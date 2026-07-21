/**
 * Phase 0 — Stage B: minimal WebSocket client.
 *
 * A dependency-free WebSocket (RFC 6455) client built on `node:net` +
 * `node:crypto`, enough to reach WAAPI's WAMP endpoint
 * (`ws://host:port/waapi`). Hand-rolled rather than bundling `ws` so nothing
 * depends on native addons (`bufferutil` / `utf-8-validate`) that may not load
 * inside the Extension Host sandbox. Frame encode/decode is included so Stage C
 * (WAMP) can reuse this client unchanged.
 *
 * See docs/phase-0-waapi-connectivity.md.
 */

// Resolved lazily so a sandbox that strips built-ins fails with a clear message
// (see probe.ts) rather than breaking bundle load.
type Net = typeof import("node:net");
type Crypto = typeof import("node:crypto");

/** RFC 6455 handshake magic. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** WAMP-over-WebSocket subprotocol used by WAAPI. */
export const WAMP_SUBPROTOCOL = "wamp.2.json";

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export interface WsConnectOptions {
  host: string;
  port: number;
  path: string;
  subprotocol?: string;
  timeoutMs?: number;
}

export interface WsHandshakeInfo {
  statusLine: string;
  /** Negotiated subprotocol the server echoed, if any. */
  subprotocol?: string;
  /** Whether the server's Sec-WebSocket-Accept matched our key. */
  acceptValid: boolean;
}

/**
 * A minimal client WebSocket. Use {@link WebSocketClient.connect} to open one;
 * it resolves only after a successful `101 Switching Protocols` handshake.
 */
export class WebSocketClient {
  readonly handshake: WsHandshakeInfo;

  private readonly socket: import("node:net").Socket;
  private readonly crypto: Crypto;
  private rxBuffer: Buffer;
  private fragmentOpcode: number | null = null;
  private fragments: Buffer[] = [];

  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  private constructor(
    socket: import("node:net").Socket,
    crypto: Crypto,
    handshake: WsHandshakeInfo,
    leftover: Buffer,
  ) {
    this.socket = socket;
    this.crypto = crypto;
    this.handshake = handshake;
    this.rxBuffer = leftover;

    this.socket.on("data", (chunk: Buffer) => {
      this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
      this.drainFrames();
    });
    this.socket.on("error", (err) => this.errorHandler?.(err));
    this.socket.on("close", () => this.closeHandler?.(1006, "socket closed"));

    // Any bytes that arrived immediately after the handshake are already frames.
    if (this.rxBuffer.length > 0) this.drainFrames();
  }

  /** Opens a TCP connection and performs the WebSocket upgrade. */
  static connect(opts: WsConnectOptions): Promise<WebSocketClient> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    let net: Net;
    let crypto: Crypto;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      net = require("node:net") as Net;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      crypto = require("node:crypto") as Crypto;
    } catch (err) {
      return Promise.reject(
        new Error(
          `Node built-ins unavailable in the Extension Host: ${(err as Error)?.message ?? err}`,
        ),
      );
    }

    return new Promise<WebSocketClient>((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const expectedAccept = crypto
        .createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");

      const socket = new net.Socket();
      let settled = false;
      let headerBuf = Buffer.alloc(0);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      socket.setTimeout(timeoutMs);
      socket.once("timeout", () =>
        fail(new Error(`WebSocket handshake timed out after ${timeoutMs}ms`)),
      );
      socket.once("error", (err) => fail(err));

      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const boundary = headerBuf.indexOf("\r\n\r\n");
        if (boundary === -1) return; // headers not complete yet

        const headerText = headerBuf.subarray(0, boundary).toString("latin1");
        const leftover = headerBuf.subarray(boundary + 4);
        const lines = headerText.split("\r\n");
        const statusLine = lines[0] ?? "";
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(":");
          if (idx === -1) continue;
          headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
        }

        if (!/^HTTP\/1\.1 101/i.test(statusLine)) {
          fail(new Error(`Expected "101 Switching Protocols", got "${statusLine}"`));
          return;
        }
        const acceptValid = headers.get("sec-websocket-accept") === expectedAccept;
        if (!acceptValid) {
          fail(new Error("Sec-WebSocket-Accept did not match the sent key"));
          return;
        }

        settled = true;
        socket.setTimeout(0);
        socket.removeAllListeners("data");
        socket.removeAllListeners("timeout");
        socket.removeAllListeners("error");
        resolve(
          new WebSocketClient(socket, crypto, {
            statusLine,
            subprotocol: headers.get("sec-websocket-protocol"),
            acceptValid,
          }, leftover),
        );
      });

      socket.connect(opts.port, opts.host, () => {
        const headers = [
          `GET ${opts.path} HTTP/1.1`,
          `Host: ${opts.host}:${opts.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
        ];
        if (opts.subprotocol) headers.push(`Sec-WebSocket-Protocol: ${opts.subprotocol}`);
        socket.write(headers.join("\r\n") + "\r\n\r\n");
      });
    });
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  /** Sends a UTF-8 text frame (used for WAMP JSON messages). */
  sendText(data: string): void {
    this.socket.write(this.encodeFrame(OPCODE.text, Buffer.from(data, "utf8")));
  }

  /** Sends a close frame and ends the socket. */
  close(code = 1000): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this.socket.write(this.encodeFrame(OPCODE.close, payload));
    } catch {
      /* socket may already be gone */
    }
    this.socket.end();
  }

  /** Client frames must be masked (RFC 6455 §5.3). */
  private encodeFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = this.crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
  }

  /** Parse as many complete frames as are buffered. */
  private drainFrames(): void {
    for (;;) {
      const buf = this.rxBuffer;
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        len = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask: Buffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return; // wait for the full payload
      let payload = buf.subarray(offset, offset + len);
      if (mask) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      this.rxBuffer = buf.subarray(offset + len);

      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OPCODE.ping:
        this.socket.write(this.encodeFrame(OPCODE.pong, payload));
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        this.closeHandler?.(code, reason);
        this.socket.end();
        return;
      }
      case OPCODE.text:
      case OPCODE.binary:
      case OPCODE.continuation: {
        if (opcode !== OPCODE.continuation) this.fragmentOpcode = opcode;
        this.fragments.push(payload);
        if (!fin) return;
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOpcode = null;
        this.messageHandler?.(full.toString("utf8"));
        return;
      }
      default:
        return; // ignore unknown opcodes
    }
  }
}

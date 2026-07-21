/**
 * Phase 0 — Stage C: WAMP client for WAAPI.
 *
 * WAAPI speaks WAMP v2 with the `wamp.2.json` serialization: every message is a
 * JSON array `[messageType, ...]` sent as a WebSocket text frame. This wraps
 * {@link WebSocketClient} with just the WAMP subset WAAPI needs — session
 * handshake (HELLO/WELCOME) and RPC (CALL/RESULT/ERROR) — plus SUBSCRIBE for
 * later phases. This is the real client the transfer features build on, not a
 * throwaway spike.
 *
 * See docs/phase-0-waapi-connectivity.md.
 */

import { WebSocketClient, WAMP_SUBPROTOCOL } from "./websocket.js";

/** WAMP message type codes (subset used by WAAPI). */
const WAMP = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  GOODBYE: 6,
  ERROR: 8,
  CALL: 48,
  RESULT: 50,
  SUBSCRIBE: 32,
  SUBSCRIBED: 33,
  EVENT: 36,
} as const;

/** WAAPI's embedded WAMP router uses this realm (matches autobahn/waapi-client). */
export const WAAPI_REALM = "realm1";

export interface WaapiConnectOptions {
  host: string;
  port: number;
  path?: string;
  realm?: string;
  timeoutMs?: number;
}

export interface WaapiError extends Error {
  uri: string;
  details?: unknown;
  kwargs?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  procedure: string;
}

type EventHandler = (kwargs: Record<string, unknown>) => void;

/**
 * A WAMP RPC client for the Wwise Authoring API. Open one with
 * {@link WaapiClient.connect}; it resolves only after a WAMP session is
 * established (WELCOME received).
 */
export class WaapiClient {
  readonly sessionId: number;

  private readonly ws: WebSocketClient;
  private readonly callTimeoutMs: number;
  private idCounter = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, EventHandler>();
  private closeHandler: ((reason: string) => void) | null = null;

  private constructor(ws: WebSocketClient, sessionId: number, callTimeoutMs: number) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.callTimeoutMs = callTimeoutMs;
    this.ws.onMessage((data) => this.dispatch(data));
    this.ws.onClose((code, reason) => this.onSocketClosed(`socket closed (${code}) ${reason}`));
    this.ws.onError((err) => this.onSocketClosed(err.message));
  }

  /** Opens the WebSocket and negotiates a WAMP session (HELLO → WELCOME). */
  static async connect(opts: WaapiConnectOptions): Promise<WaapiClient> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const realm = opts.realm ?? WAAPI_REALM;
    const ws = await WebSocketClient.connect({
      host: opts.host,
      port: opts.port,
      path: opts.path ?? "/waapi",
      subprotocol: WAMP_SUBPROTOCOL,
      timeoutMs,
    });

    return new Promise<WaapiClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`WAMP session handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.onMessage((data) => {
        let msg: unknown[];
        try {
          msg = JSON.parse(data) as unknown[];
        } catch {
          return;
        }
        if (msg[0] === WAMP.WELCOME) {
          clearTimeout(timer);
          resolve(new WaapiClient(ws, msg[1] as number, timeoutMs));
        } else if (msg[0] === WAMP.ABORT) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WAMP session aborted: ${String(msg[2])}`));
        }
      });

      // HELLO: announce the roles a WAAPI client uses (caller + subscriber).
      const hello = [
        WAMP.HELLO,
        realm,
        { roles: { caller: {}, callee: {}, publisher: {}, subscriber: {} } },
      ];
      ws.sendText(JSON.stringify(hello));
    });
  }

  /**
   * Calls a WAAPI remote procedure (e.g. `ak.wwise.core.getInfo`).
   *
   * WAAPI passes call arguments and returns results as WAMP keyword arguments,
   * so `args` becomes the CALL's ArgumentsKw and the resolved value is the
   * RESULT's ArgumentsKw.
   *
   * @param procedure - The `ak.wwise.*` URI.
   * @param args - The function arguments object (empty for argument-less calls).
   * @param options - WAAPI options object (e.g. `return` fields for queries).
   */
  call<T = Record<string, unknown>>(
    procedure: string,
    args: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId();
    const message = [WAMP.CALL, id, options, procedure, [], args];
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WAAPI call "${procedure}" timed out after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        procedure,
      });
      this.ws.sendText(JSON.stringify(message));
    });
  }

  /** Notified when the underlying connection drops. */
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  /** Sends GOODBYE and closes the socket. */
  close(): void {
    try {
      this.ws.sendText(JSON.stringify([WAMP.GOODBYE, {}, "wamp.close.normal"]));
    } catch {
      /* ignore */
    }
    this.ws.close();
  }

  private nextId(): number {
    // WAMP ids must be in [1, 2^53]; a simple counter is fine per-session.
    this.idCounter = (this.idCounter % Number.MAX_SAFE_INTEGER) + 1;
    return this.idCounter;
  }

  private dispatch(data: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(data) as unknown[];
    } catch {
      return;
    }
    switch (msg[0]) {
      case WAMP.RESULT: {
        // [50, CALL.Request, Details, YieldArguments, YieldArgumentsKw]
        const id = msg[1] as number;
        const kwargs = (msg[4] as Record<string, unknown>) ?? {};
        const args = (msg[3] as unknown[]) ?? [];
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        // WAAPI returns results as kwargs; fall back to positional args if empty.
        p.resolve(Object.keys(kwargs).length > 0 || args.length === 0 ? kwargs : args);
        return;
      }
      case WAMP.ERROR: {
        // [8, REQUEST.Type, REQUEST.Request, Details, Error, Arguments, ArgumentsKw]
        const id = msg[2] as number;
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        const err = new Error(
          `WAAPI "${p.procedure}" failed: ${String(msg[4])}`,
        ) as WaapiError;
        err.uri = String(msg[4]);
        err.details = msg[3];
        err.kwargs = msg[6];
        p.reject(err);
        return;
      }
      case WAMP.EVENT: {
        // [36, Subscription, Publication, Details, Arguments, ArgumentsKw]
        const subId = msg[1] as number;
        const handler = this.subscriptions.get(subId);
        handler?.((msg[5] as Record<string, unknown>) ?? {});
        return;
      }
      case WAMP.GOODBYE:
        this.onSocketClosed("server sent GOODBYE");
        return;
      default:
        return;
    }
  }

  private onSocketClosed(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Connection closed before response: ${reason}`));
    }
    this.pending.clear();
    this.closeHandler?.(reason);
  }
}

/**
 * Phase 0 — Stage A: sandbox gate.
 *
 * Answers the make-or-break question for the whole project: can the Ableton
 * Extension Host open a TCP socket at all, and can it reach the WAAPI port?
 * We deliberately use only `node:net` — no dependencies — because the decisive
 * signal is whether the host sandbox permits outbound sockets, not whether we
 * can speak WAMP yet (that's Stage B/C).
 *
 * See docs/phase-0-waapi-connectivity.md.
 */

/** Default WAAPI WAMP endpoint (Wwise → User Preferences → Enable Wwise Authoring API). */
export const DEFAULT_WAAPI_HOST = "127.0.0.1";
export const DEFAULT_WAAPI_PORT = 8080;

export type ProbeOutcome =
  | "net-unavailable"
  | "connected"
  | "refused"
  | "timeout"
  | "error";

export interface ProbeResult {
  outcome: ProbeOutcome;
  host: string;
  port: number;
  /** Human-readable, safe to show in a dialog. */
  message: string;
  /** Whether the host sandbox appears to permit outbound sockets at all. */
  socketsAllowed: boolean;
}

/**
 * Attempt a raw TCP connection to the WAAPI port.
 *
 * Resolves (never rejects) with a {@link ProbeResult} describing what happened,
 * so callers can render it directly.
 */
export function probeWaapi(
  host: string = DEFAULT_WAAPI_HOST,
  port: number = DEFAULT_WAAPI_PORT,
  timeoutMs = 3000,
): Promise<ProbeResult> {
  // `require` rather than a top-level import: if the sandbox strips Node
  // built-ins, this throws here instead of failing the whole bundle to load.
  let net: typeof import("node:net");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    net = require("node:net") as typeof import("node:net");
  } catch (err) {
    return Promise.resolve({
      outcome: "net-unavailable",
      host,
      port,
      socketsAllowed: false,
      message:
        "`node:net` is not available in the Extension Host — outbound sockets " +
        "appear to be sandboxed. Direct WAAPI is not possible; pivot to the " +
        `tab-delimited import fallback. (${(err as Error)?.message ?? err})`,
    });
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.once("connect", () =>
      done({
        outcome: "connected",
        host,
        port,
        socketsAllowed: true,
        message:
          `Connected to ${host}:${port}. The sandbox allows outbound sockets ` +
          "and something is listening (Wwise + WAAPI enabled). Proceed to " +
          "Stage B (WebSocket handshake).",
      }),
    );

    socket.once("timeout", () =>
      done({
        outcome: "timeout",
        host,
        port,
        socketsAllowed: true, // socket API worked; the connect just didn't complete
        message:
          `Timed out after ${timeoutMs}ms connecting to ${host}:${port}. The ` +
          "socket API works, but nothing answered — check the port or a firewall.",
      }),
    );

    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") {
        done({
          outcome: "refused",
          host,
          port,
          socketsAllowed: true,
          message:
            `Connection to ${host}:${port} was refused. Good news: the sandbox ` +
            "allows sockets. Nothing is listening — open Wwise and enable the " +
            "Authoring API (Project → User Preferences), then retry.",
        });
        return;
      }
      done({
        outcome: "error",
        host,
        port,
        socketsAllowed: true,
        message: `Socket error connecting to ${host}:${port}: ${err.code ?? ""} ${err.message}`,
      });
    });

    socket.connect(port, host);
  });
}

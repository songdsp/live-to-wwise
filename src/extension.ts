import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import {
  probeWaapi,
  DEFAULT_WAAPI_HOST,
  DEFAULT_WAAPI_PORT,
  type ProbeResult,
} from "./waapi/probe.js";
import { WebSocketClient, WAMP_SUBPROTOCOL } from "./waapi/websocket.js";
import { WaapiClient } from "./waapi/client.js";

// esbuild inlines this HTML file as a string for production builds.
import bundledInterface from "../ui/interface.html";

type Tone = "ok" | "warn" | "error";

/** Builds a data: URL for a simple colour-coded result modal. */
function resultDialogUrl(title: string, badge: string, tone: Tone, body: string): string {
  const color = tone === "ok" ? "#2e7d32" : tone === "warn" ? "#ef6c00" : "#c62828";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 16px; color: #222; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff;
           background: ${color}; font-weight: 600; text-transform: uppercase; font-size: 11px; }
  p { margin: 10px 0; } code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
  button { margin-top: 12px; }
</style></head><body>
  <h1>${title} — <span class="badge">${badge}</span></h1>
  ${body}
  <button onclick="closeDialog()">Close</button>
  <script>
    function closeDialog() {
      const msg = { method: "close_and_send", params: ["ok"] };
      if (window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage(msg);
      else if (window.chrome?.webview) window.chrome.webview.postMessage(msg);
    }
  </script>
</body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // Phase 0 — Stage A: can the host reach the WAAPI port over raw TCP?
  context.commands.registerCommand("live-to-wwise.testWaapi", () => {
    void context.ui
      .withinProgressDialog(
        `Probing WAAPI (${DEFAULT_WAAPI_HOST}:${DEFAULT_WAAPI_PORT})…`,
        { progress: 0 },
        async () => {
          const result = await probeWaapi();
          console.log(`[live-to-wwise] Stage A: ${result.outcome} — ${result.message}`);
          return result;
        },
      )
      .then((raw) => {
        const result = raw as ProbeResult;
        const tone: Tone = result.outcome === "connected" ? "ok" : result.socketsAllowed ? "warn" : "error";
        const body = `<p>Target: <code>${result.host}:${result.port}</code></p><p>${result.message}</p>`;
        void context.ui.showModalDialog(
          resultDialogUrl("WAAPI TCP Probe", result.outcome, tone, body),
          440,
          260,
        );
      });
  });

  // Phase 0 — Stage B: upgrade to a WebSocket at /waapi (expect HTTP 101).
  context.commands.registerCommand("live-to-wwise.testWaapiWs", () => {
    void context.ui
      .withinProgressDialog(
        `WebSocket handshake to ${DEFAULT_WAAPI_HOST}:${DEFAULT_WAAPI_PORT}/waapi…`,
        { progress: 0 },
        async () => {
          try {
            const ws = await WebSocketClient.connect({
              host: DEFAULT_WAAPI_HOST,
              port: DEFAULT_WAAPI_PORT,
              path: "/waapi",
              subprotocol: WAMP_SUBPROTOCOL,
            });
            const { statusLine, subprotocol, acceptValid } = ws.handshake;
            ws.close();
            console.log(`[live-to-wwise] Stage B: 101 OK — ${statusLine} (subprotocol=${subprotocol})`);
            return {
              ok: true as const,
              body:
                `<p><code>${statusLine}</code></p>` +
                `<p>Accept header valid: <code>${acceptValid}</code><br>` +
                `Negotiated subprotocol: <code>${subprotocol ?? "(none)"}</code></p>` +
                `<p>The Extension Host can open a WebSocket to WAAPI. Ready for Stage C (WAMP + getInfo).</p>`,
            };
          } catch (err) {
            const message = (err as Error)?.message ?? String(err);
            console.log(`[live-to-wwise] Stage B failed: ${message}`);
            return {
              ok: false as const,
              body: `<p>Handshake failed:</p><p><code>${message}</code></p>` +
                `<p>If Stage A connected but this fails, the port is open but not a WAAPI WebSocket — ` +
                `check that Wwise's Authoring API is enabled and using WAMP on this port.</p>`,
            };
          }
        },
      )
      .then((raw) => {
        const result = raw as { ok: boolean; body: string };
        void context.ui.showModalDialog(
          resultDialogUrl(
            "WAAPI WebSocket",
            result.ok ? "101 switching protocols" : "failed",
            result.ok ? "ok" : "error",
            result.body,
          ),
          460,
          280,
        );
      });
  });

  // Phase 0 — Stage C: WAMP session + ak.wwise.core.getInfo round-trip.
  context.commands.registerCommand("live-to-wwise.testWaapiInfo", () => {
    void context.ui
      .withinProgressDialog("Connecting to WAAPI (WAMP)…", { progress: 0 }, async (update) => {
        let client: WaapiClient | undefined;
        try {
          client = await WaapiClient.connect({
            host: DEFAULT_WAAPI_HOST,
            port: DEFAULT_WAAPI_PORT,
          });
          await update("Calling ak.wwise.core.getInfo…", 50);
          const info = await client.call<{
            version?: { displayName?: string; year?: number; schemaVersion?: number };
            apiVersion?: number;
          }>("ak.wwise.core.getInfo");

          // Best-effort: project info only succeeds when a project is open.
          let projectLine = "";
          try {
            const project = await client.call<{ name?: string; path?: string }>(
              "ak.wwise.core.getProjectInfo",
            );
            if (project?.name) {
              projectLine = `<p>Project: <code>${project.name}</code><br>` +
                `<code>${project.path ?? ""}</code></p>`;
            }
          } catch {
            projectLine = "<p><em>No project info (is a project open?).</em></p>";
          }

          const v = info.version ?? {};
          console.log(
            `[live-to-wwise] Stage C: getInfo OK — ${v.displayName} (apiVersion=${info.apiVersion}, schema=${v.schemaVersion})`,
          );
          return {
            ok: true as const,
            body:
              `<p>Wwise: <code>${v.displayName ?? "?"}</code> (${v.year ?? "?"})</p>` +
              `<p>WAAPI apiVersion: <code>${info.apiVersion ?? "?"}</code> · ` +
              `schema: <code>${v.schemaVersion ?? "?"}</code></p>` +
              projectLine +
              `<p><strong>Go.</strong> Full WAAPI round-trip works from the Extension Host — Phase 1 is unblocked.</p>`,
          };
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          console.log(`[live-to-wwise] Stage C failed: ${message}`);
          return {
            ok: false as const,
            body: `<p>WAMP round-trip failed:</p><p><code>${message}</code></p>`,
          };
        } finally {
          client?.close();
        }
      })
      .then((raw) => {
        const result = raw as { ok: boolean; body: string };
        void context.ui.showModalDialog(
          resultDialogUrl(
            "WAAPI getInfo",
            result.ok ? "connected" : "failed",
            result.ok ? "ok" : "error",
            result.body,
          ),
          480,
          320,
        );
      });
  });

  context.commands.registerCommand("live-to-wwise.showDialog", () => {
    const url = `data:text/html,${encodeURIComponent(bundledInterface)}`;
    context.ui.showModalDialog(url, 320, 160).then((result) => {
      console.log(`Dialog closed with: ${result}`);
    });
  });

  context.ui.registerContextMenuAction(
    "AudioClip",
    "live-to-wwise: Test WAAPI Connection (TCP)",
    "live-to-wwise.testWaapi",
  );

  context.ui.registerContextMenuAction(
    "AudioClip",
    "live-to-wwise: Test WAAPI WebSocket",
    "live-to-wwise.testWaapiWs",
  );

  context.ui.registerContextMenuAction(
    "AudioClip",
    "live-to-wwise: Test WAAPI getInfo (WAMP)",
    "live-to-wwise.testWaapiInfo",
  );

  context.ui.registerContextMenuAction(
    "AudioClip",
    "Open live-to-wwise",
    "live-to-wwise.showDialog",
  );
}

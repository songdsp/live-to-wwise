# Phase 0 — WAAPI Connectivity Spike

**Goal:** answer the one question the whole project hinges on — *can the Ableton
Extension Host open a network connection to WAAPI?* — with the least code
possible, before investing in any transfer feature.

## Why this is first

WAAPI is WAMP over a WebSocket to `ws://127.0.0.1:8080/waapi`. The Ableton
Extensions SDK exposes **no** network API. The host is a Node runtime and
`build.ts` bundles with esbuild `platform: "node"` (Node built-ins stay
external and are resolved at runtime), so `node:net` *should* be reachable — but
the host sandbox may forbid opening sockets. If it does, the entire direct-WAAPI
architecture is off the table and we pivot to a file-drop + companion-process
design. So we test the cheapest decisive thing first: a raw TCP connect.

## Stages

### Stage A — Sandbox gate (raw TCP) — implemented
`src/waapi/probe.ts` uses `node:net` to open a TCP socket to `127.0.0.1:8080`
with a short timeout and reports one of:

- **`net` unavailable** — `require('node:net')` throws → sockets are fully
  sandboxed. → **Pivot to fallback architecture.**
- **connected** — port open, something is listening (Wwise + WAAPI enabled). →
  Sandbox allows sockets. Proceed to Stage B.
- **refused** — socket API works but nothing on 8080 (Wwise closed or WAAPI
  disabled). Sandbox is fine; just start Wwise / enable WAAPI and retry.
- **timeout / error** — inspect message; usually a firewall or wrong port.

The decisive signal is *"does `net` work at all"* + *"can we reach a listening
port"*, not whether Wwise happens to be running this instant.

### Stage B — WebSocket handshake — implemented
`src/waapi/websocket.ts` is a minimal, dependency-free RFC 6455 client built on
`node:net` + `node:crypto`. `WebSocketClient.connect()` opens TCP, sends the
`Upgrade` request (with `Sec-WebSocket-Key` and subprotocol `wamp.2.json`), and
resolves only on `HTTP/1.1 101 Switching Protocols` with a valid
`Sec-WebSocket-Accept`. It also implements masked frame encode + frame decode
(text/binary/continuation/ping/pong/close), so Stage C's WAMP layer sits
directly on top with no rework. Chosen over bundling `ws` to avoid native
addons (`bufferutil`/`utf-8-validate`) that may not load in the host sandbox.

Success = the handshake dialog shows **101 switching protocols**. A failure
after Stage A connected means the port is open but not speaking WebSocket/WAAPI.

### Stage C — WAMP + getInfo — implemented
`src/waapi/client.ts` (`WaapiClient`) speaks the WAMP subset WAAPI needs over the
Stage B WebSocket: `HELLO` (realm `realm1`, caller+subscriber roles) → `WELCOME`,
then `CALL`/`RESULT`/`ERROR` for RPC (and `SUBSCRIBE`/`EVENT` wiring for later
phases). WAAPI passes call args and returns results as WAMP **keyword
arguments**, which the client handles. The Stage C command connects, calls
`ak.wwise.core.getInfo`, and best-effort `ak.wwise.core.getProjectInfo`, showing
Wwise version / apiVersion / schema / open project.

This is the real client Phase 1+ builds on, not a throwaway. Hand-rolled WAMP
worked, so bundling [`waapi-client`](https://github.com/audiokinetic/waapi-client)
(autobahn + ws) is **not** needed.

Success = the dialog shows Wwise's version and **Go**.

### Stage D — Render primitive check (parallel)
Independent of WAAPI. Call `resources.renderPreFxAudio(track, start, end)` on a
selected audio track and inspect the WAV: sample rate, bit depth, whether warp
is applied, and behavior on looping/unwarped clips. Documents exactly what we
can hand to `audio.import`.

## Prerequisites to run
1. Wwise open with a project.
2. Wwise → **Project → User Preferences → Enable Wwise Authoring API**
   (WAMP port defaults to 8080).
3. `npm start` to build + launch the extension in the Extension Host.
4. In Live, right-click any audio clip →
   **"live-to-wwise: Test WAAPI Connection"**.

## Exit criteria (0.E go/no-go)
- **Go (direct WAAPI):** Stage C returns a valid `getInfo` result. → Phase 1.
- **No-go (fallback):** Stage A shows `net` unavailable or sockets blocked. →
  redesign around `importTabDelimited` + a companion process, then Phase 1.

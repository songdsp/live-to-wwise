# Progress

Tracking for [PLAN.md](./PLAN.md). Legend: ✅ done · 🚧 in progress · ⬜ not started · ⛔ blocked.

_Last updated: 2026-07-21_

## Phase 0 — Connectivity spike 🚧

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0.A | `node:net` resolves in host + raw TCP connect to `127.0.0.1:8080` | ✅ | Probe (`src/waapi/probe.ts`) verified against a live Wwise — sockets allowed. |
| 0.B | WebSocket upgrade handshake to `/waapi` | ✅ | Hand-rolled RFC 6455 client (`src/waapi/websocket.ts`), no external deps. Verified: HTTP 101. |
| 0.C | WAMP HELLO→WELCOME + `ak.wwise.core.getInfo` round-trip | 🚧 | `WaapiClient` (`src/waapi/client.ts`) built on the Stage B WS; realm `realm1`, kwargs-based RPC. Wired to context menu. Needs a run to confirm getInfo returns. |
| 0.D | Confirm `renderPreFxAudio` output (sr/bit-depth, warp applied?, constraints) | ⬜ | Independent of WAAPI; can run in parallel. |
| 0.E | Go/no-go decision: direct WAAPI vs tab-delimited fallback | 🚧 | Leaning **Go** — A+B verified, C implemented. Confirms once C returns getInfo. |

**How to run the Phase 0 probes:** `npm start`, then in Live right-click any
audio clip:
- **"live-to-wwise: Test WAAPI Connection (TCP)"** → Stage A (raw socket gate).
- **"live-to-wwise: Test WAAPI WebSocket"** → Stage B (expects HTTP 101).

- **"live-to-wwise: Test WAAPI getInfo (WAMP)"** → Stage C (full round-trip).

Results show in a dialog and the Extension Host console. Wwise must be open with
Project → User Preferences → **Enable Wwise Authoring API** checked (port 8080).

## Phase 1 — MVP: Send clip to Wwise ⬜
_Not started. Unblocked once Phase 0 reaches go/no-go (0.E)._

## Phase 2 — Hierarchy mapping & batch ⬜
## Phase 3 — Metadata-rich transfer ⬜
## Phase 4 — Round-trip & sync ⬜
## Phase 5 — Music-specific & advanced ⬜

---

## Decisions log
- _2026-07-21_ — Plan drafted; started Phase 0. Chose raw `node:net` probe first
  (dependency-free, decisive for the sandbox question) before investing in a
  WAMP client or bundling `waapi-client`.
- _2026-07-21_ — Stage B: hand-rolled a minimal RFC 6455 WebSocket client on
  `node:net`+`node:crypto` instead of bundling `ws`. Rationale: avoid native
  addons (`bufferutil`/`utf-8-validate`) that may not load in the sandbox, keep
  the bundle small, and reuse its frame encode/decode directly for Stage C's
  WAMP layer. Verified against WAAPI: HTTP 101. **A + B confirmed by the user.**
- _2026-07-21_ — Stage C: hand-rolled WAMP (`WaapiClient`) rather than bundling
  `waapi-client` (autobahn + ws). The WAAPI subset is small (HELLO/WELCOME,
  CALL/RESULT/ERROR, SUBSCRIBE/EVENT) and hand-rolling keeps the whole stack
  dependency-free and sandbox-safe. This is the client Phase 1+ builds on.

## Open questions
- Does the Extension Host sandbox permit outbound sockets? (0.A)
- Is `renderPreFxAudio` truly the only render primitive? Any master/bus path? (0.D)
- Raw WAMP implementation vs bundling `waapi-client`/`autobahn`+`ws`? (0.C)

# Progress

Tracking for [PLAN.md](./PLAN.md). Legend: ✅ done · 🚧 in progress · ⬜ not started · ⛔ blocked.

_Last updated: 2026-07-21_

## Phase 0 — Connectivity spike ✅

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0.A | `node:net` resolves in host + raw TCP connect to `127.0.0.1:8080` | ✅ | Probe (`src/waapi/probe.ts`) verified — sockets allowed. |
| 0.B | WebSocket upgrade handshake to `/waapi` | ✅ | Hand-rolled RFC 6455 client (`src/waapi/websocket.ts`). Verified: HTTP 101. |
| 0.C | WAMP HELLO→WELCOME + `ak.wwise.core.getInfo` round-trip | ✅ | `WaapiClient` (`src/waapi/client.ts`); realm `realm1`, kwargs RPC. Verified. |
| 0.D | Confirm `renderPreFxAudio` output (sr/bit-depth, warp applied?, constraints) | ⬜ | Deferred — Phase 1 MVP transfers the clip's source file, not a render, so this isn't blocking. Needed for region-accurate export (Phase 2/3). |
| 0.E | Go/no-go decision | ✅ | **Go** — full WAAPI round-trip works from the Extension Host. No fallback needed. |

## Phase 1 — MVP: Send clip to Wwise ✅

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Config persistence (host/port/dest) in `storageDirectory` | ✅ | `src/config.ts` (JSON via `node:fs`). |
| 1.2 | Transfer form dialog (pre-filled from config + clip) | ✅ | `src/ui/dialogs.ts` `transferFormUrl`. |
| 1.3 | Single-clip transfer via `ak.wwise.core.audio.import` | ✅ | `src/wwise/import.ts` — imports `AudioClip.filePath` as `<Sound SFX>`. Import-operation choice (useExisting/replace/createNew). |
| 1.4 | Progress + result dialog; reveal in Project Explorer | ✅ | `FindInProjectExplorerSyncGroup1` deep-link (best-effort). |
| 1.5 | End-to-end run in Live + Wwise | ✅ | Verified by user — import lands and the result dialog returns the Wwise path. |

**How to run:** `npm start`, then in Live right-click an audio clip →
**"Send to Wwise…"** (or **"Test WAAPI Connection"** for the getInfo diagnostic).
Wwise must be open with a project and the Authoring API enabled (port 8080).

**MVP scope note:** transfers the clip's **source file** (`AudioClip.filePath`),
not the warped/trimmed region or track FX — those need `renderPreFxAudio` (0.D),
scheduled for Phase 2/3. Non-WAV sources may not import; WAV/AIFF recommended.

## Phase 2a — Batch, rename-in-Live & destination picker 📝 planned
_Design in [phase-2a-batch-and-destination.md](./phase-2a-batch-and-destination.md).
Chosen to build before 2b. Not yet implemented; 3 open questions to confirm._

| # | Task | Status |
|---|------|--------|
| 2a.1 | `fetchDestinations` via `object.get`/WAQL, Actor-Mixer scope (reused by 2b) | ✅ |
| 2a.2 | `AudioTrack.ArrangementSelection` entry → clips overlapping time range | ✅ |
| 2a.2b | Batch rename naming core (`src/live/rename.ts`, pure + verified) | ✅ |
| 2a.3 | Batch form: destination datalist + rename controls (prefix/base/suffix) + operation + live preview | ✅ |
| 2a.4 | Rename-in-Live (transaction) + collision/resume vs Wwise dest + transfer loop + `setNotes` + summary | 🚧 |
| 2a.5 | `ClipSlotSelection` (Session View) entry | 🚧 |
| 2a.6 | Cache destinations (`src/wwise/cache.ts`); offline fallback + form banner | 🚧 |

**Decisions:** Arrangement entry first · rename clip/object only (leave Originals
WAV as-is) + always `setNotes` for provenance · Actor-Mixer destination scope
only (see [phase-2a doc](./phase-2a-batch-and-destination.md)).

**2a.1 run:** `npm start`, right-click an audio clip → **"List Wwise
Destinations"** (project open). Confirms the WAQL query + `return`-in-options
mapping and shows the container paths the picker will offer.

**2a.2 run:** in Arrangement View, drag a time selection across one or more
audio tracks (include take lanes if you like), right-click → **"Send to
Wwise…"**. Currently previews the resolved clip set (name · start beat · source
file); step 3 swaps this preview for the batch form. Checks: correct clips
included, partial-overlap clips picked up, take-lane clips found, no dupes.

**2a.3 run:** Arrangement View → select audio clips → **"Send to Wwise…"**. It
reads Wwise destinations (progress dialog), then opens the batch form: pick a
destination from the dropdown, toggle prefix/suffix, set digit count + names,
watch the live `old → new` preview, confirm the Transfer button disables when a
multi-file selection has no affix or no destination. Submitting shows a preview
of the computed batch (step 4 does the real rename + transfer). Rename settings
persist to config.

**Preview resume (fixed):** `fetchHierarchy` returns a `destinationPath →
childNames` map in the same query that builds the dropdown; the form mirrors
`resumeIndex` in-browser so the preview shows resumed numbers live as the
destination/affix changes (commit still re-resolves fresh). Verified the mirrored
regex matches the TS core.

**2a.4 run:** Arrangement View → select audio clips → **"Send to Wwise…"** →
configure the batch form → **Transfer**. Verifies end-to-end: clips are renamed
in Live (single undo — Cmd-Z reverts all), objects created at the destination
with matching names, index resumes after existing objects on a second run,
Notes carry the source path, all imported objects reveal in the Project
Explorer, and the summary lists per-item success/failure.

**2a.5 run:** Session View → select several clip slots (across tracks/scenes) →
right-click → **"Send to Wwise…"**. Same batch flow as arrangement; checks empty
slots and MIDI clips are skipped, selection order is preserved.

**2a.6 run:** with Wwise **closed** (after a prior successful run so a cache
exists), open the batch form — the destination dropdown still populates from
`hierarchy-cache.json` and shows the orange "Wwise unreachable" banner; transfer
then fails cleanly until Wwise is back. Delete the cache + close Wwise → empty
dropdown, free-text still works.

**Collision note:** step 4 relies on resume-index to avoid collisions and lets
the import operation govern existing names (useExisting skips, replaceExisting
updates, createNew auto-renames). A hard abort-with-conflict-list mode is
deferred (not needed since Wwise never destructively clobbers here).

**Rename target (resolved):** rename **clip / Wwise object names** only
(`Clip.name` → `objectPath`); disk files untouched so clips never go offline;
resume + collision vs the **Wwise destination**; no two-phase step. The pure
naming core (2a.2b) is done and verified.

## Phase 2b — Hierarchy mapping, preview & containers ⬜
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
- _2026-07-21_ — Phase 0 closed **Go**; started Phase 1. MVP transfers
  `AudioClip.filePath` (the source file) rather than rendering the clip region,
  to stay universal across session/arrangement clips and avoid the
  track+beat-range plumbing `renderPreFxAudio` needs. Region/FX-accurate render
  moves to Phase 2/3 (0.D).
- _2026-07-21_ — Phase 1 verified end-to-end (returns Wwise path). Split old
  Phase 2 into **2a** (batch + rename-in-Live + destination picker — user's two
  requested behaviors) and **2b** (mapping table, preview, containers). Building
  2a first: it reuses Phase 1 plumbing and its `object.get`/WAQL destination
  query is a prerequisite 2b also needs.

## Open questions
- Does WAAPI echo `wamp.2.json` and accept realm `realm1` as expected? (resolved if getInfo returned)
- `renderPreFxAudio` output format + how to get the enclosing `AudioTrack` from a clip handle? (0.D / Phase 2)
- Does `ak.wwise.core.audio.import` return objects under `objects` with our `return` fields, across Wwise versions? (confirm in 1.5)

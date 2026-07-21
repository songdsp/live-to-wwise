# CLAUDE.md — live-to-wwise

Guidance for working in this repo. Read alongside `docs/PLAN.md` (feature plan)
and `docs/PROGRESS.md` (status + decisions log). User-facing usage is in
`README.md`.

## What this is

An Ableton Live extension (Extensions SDK, Node runtime "Extension Host") that
sends audio clips into Wwise over WAAPI. Ableton counterpart to ReaWwise.
**MVP is complete** (Phases 0–2); Phases 3–5 are future work.

## Build & run

```bash
npm start        # dev build + launch in the Extension Host (extensions-cli run)
npm run build    # production: tsc --noEmit typecheck + esbuild bundle → dist/extension.js
```

- `npm run build` is the fast verification loop — it typechecks (`tsc --noEmit`)
  **and** bundles. Always run it after edits; a clean run means types are good.
- Bundling is esbuild with **`platform: "node"`, `format: "cjs"`** (see
  `build.ts`). This is load-bearing: `node:net`/`node:crypto`/`node:fs`/
  `node:path`/`node:os` must survive as runtime `require()` — that's why the code
  uses `require("node:x")` inside functions, not top-level `import`.
- `manifest.json` defines name/entry/version; `dist/extension.js` is the entry.

## Testing needs a live rig

There are no unit tests. Real verification is manual: Live open with the
Extension Host, **and Wwise open with a project + Authoring API enabled on port
8080**. You (Claude) can't run that — make changes, `npm run build` to prove
they compile, and hand the user precise steps to verify in the rig.

## Hard-won facts (don't relearn these)

- **WAAPI = WAMP over WebSocket** at `ws://127.0.0.1:8080/waapi`, subprotocol
  `wamp.2.json`, realm `realm1`. The whole stack is **hand-rolled, zero external
  deps** (`src/waapi/{probe,websocket,client}.ts`) — deliberately, so nothing
  native has to load in the sandbox. Don't add `ws`/`autobahn`/`waapi-client`.
- **`WaapiClient.call(procedure, args, options)`**: `args` → WAMP ArgumentsKw,
  `options` → WAMP CALL Options. `object.get` returns results under the `return`
  key; `audio.import` returns under `objects`.
- **`object.get` — use the structured form**, not WAQL selectors, for
  descendants: `{ from: { path: [root] }, transform: [{ select: ["descendants"] }] }`.
  A WAQL `select this, descendants` selector returned empty on the user's Wwise;
  the structured form is version-safe. See `src/wwise/hierarchy.ts`.
- **WAQL `$ "path" select children` throws `ak.wwise.query.invalid_query` when
  the path doesn't exist** (it does NOT return empty). `fetchChildNames` catches
  this and returns `[]` — needed because a to-be-created container has no path
  yet (resume index → 0).
- **Imports are copies, not links.** `audio.import` copies the WAV into Wwise's
  `Originals`; Wwise owns that copy. Moving Live-side sources never breaks Wwise.
- **`audio.import` auto-creates typed ancestors.** Containers are made by putting
  a type-tagged segment in `objectPath`, e.g.
  `…\<Random Container>Name\<Sound SFX>step_01`. No separate `object.create`
  needed. Tag map in `src/wwise/import.ts` (`CONTAINER_TAG`). Note WAQL project
  paths carry **no** type tags — strip them for `fetchChildNames`.
- **WKWebView quirks** (dialogs are HTML in `data:` URLs via `ui.showModalDialog`):
  - `<datalist>` does **not** reliably open → we use a custom combobox
    (`setupCombo` in `src/ui/dialogs.ts`; menu items fire on `mousedown` +
    `preventDefault` so the pick beats the input's blur).
  - macOS autocorrect mangles name fields → apply the `NO_AUTOCORRECT` attrs.
  - Global `select { width:100% }` will stretch inline selects and shove
    siblings off-row → set `width:auto` on inline selects.
- **`clip.color` returns a BigInt at runtime** despite the `number` type. Any
  arithmetic must `Number(...)` it first (`Cannot mix BigInt` otherwise).
- **`environment.storageDirectory` may be undefined** under `extensions-cli run`.
  `resolveStorageDir()` in `src/config.ts` falls back to `~/.live-to-wwise`.
  Route all persistence through it.

## Code map

- `src/extension.ts` — entry. Registers context-menu actions
  (`AudioTrack.ArrangementSelection`, `ClipSlotSelection` → "Send to Wwise…") and
  the `runBatch` orchestration (fetch hierarchy → form → rename-in-Live txn →
  transfer loop → summary). Diagnostics (`testConnection`, `listDestinations`)
  and the single-clip `AudioClip` entry were **removed** for the MVP.
- `src/live/selection.ts` — resolves an arrangement/clip-slot selection to
  `AudioClip<"1.0.0">[]`.
- `src/live/rename.ts` — **pure** naming engine (`computeName`,
  `computeBatchNames`, `resumeIndex`). `prefix·base·suffix`, mirror rule. The
  browser form in `dialogs.ts` mirrors this logic for the live preview — **keep
  the two in sync** if you change naming.
- `src/wwise/import.ts` — `transferAudioToWwise`, `containerParentPath`,
  `sanitizeWwiseName`, `setObjectNotes`, `revealInWwise`.
- `src/wwise/hierarchy.ts` — `fetchHierarchy` (destinations + `childrenByPath`
  in one query), `fetchChildNames`, `fetchDestinations`, `CONTAINER_TYPES`.
- `src/wwise/cache.ts` — offline hierarchy cache.
- `src/ui/dialogs.ts` — `batchFormUrl`, `resultDialogUrl` (HTML as `data:` URLs).
- `src/config.ts` — persisted `WaapiConfig`, `resolveStorageDir`.

## Conventions

- Match the surrounding style: `require("node:x")` inside functions; explicit
  return types; terse purposeful comments explaining *why*, not *what*.
- After changing anything, run `npm run build` and report the result honestly.
- The sandboxed form can't call WAAPI — fetch everything it needs (destinations,
  child names) on the host side first and pass it into `batchFormUrl`.
- Best-effort side calls (`setNotes`, `revealInWwise`) are wrapped so a failure
  never aborts the batch.

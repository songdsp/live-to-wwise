# live-to-wwise — Feature Plan

An Ableton Live extension that transfers audio and object hierarchies into
Wwise, the Ableton counterpart to [ReaWwise](https://github.com/audiokinetic/ReaWwise)
(REAPER → Wwise). Built on the [Ableton Extensions SDK](https://ableton.github.io/extensions-sdk/)
and the [Wwise Authoring API (WAAPI)](https://www.audiokinetic.com/library/edge/?source=SDK&id=waapi_index.html).

> Status is tracked in [PROGRESS.md](./PROGRESS.md). Phase 0 detail lives in
> [phase-0-waapi-connectivity.md](./phase-0-waapi-connectivity.md).

---

## Architecture: two sides + one bridge

```
┌────────────────────┐        render WAV          ┌──────────────────┐
│  Ableton Live      │  ─────────────────────────▶│  temp / project  │
│  (Extension Host,  │        file path            │  folder on disk  │
│   Node runtime)    │                             └────────┬─────────┘
│                    │                                       │ audioFile path
│  live-to-wwise ────┼──── WAAPI (WAMP / WebSocket) ─────────▼─────────┐
│  extension         │     ws://127.0.0.1:8080/waapi   ┌──────────────┐│
└────────────────────┘                                 │  Wwise       ││
                                                        │  Authoring   ││
                       ak.wwise.core.audio.import  ◀────│  App         ││
                                                        └──────────────┘│
                                                                        │
```

The extension renders/collects audio on the Live side, then calls WAAPI to
create Wwise objects that reference those files.

### Ableton SDK primitives (what we have)

| Capability | API |
|---|---|
| Render a track region → WAV (pre-FX only) | `resources.renderPreFxAudio(track, startBeat, endBeat)` |
| Read a clip/sample source file | `AudioClip.filePath`, `Sample.filePath`, `Simpler.sample` |
| Copy a file into the Live project | `resources.importIntoProject(path)` |
| Read structure & metadata | `Song` → tracks / clips / scenes / cuePoints / tempo / warpMarkers / color / scale / mixer |
| Create clips / tracks / scenes | `Song.create*`, `ClipSlot.createAudioClip`, `Simpler.replaceSample` |
| Persistent config | `environment.storageDirectory` |
| UI | `ui.showModalDialog(url,w,h)`, `ui.withinProgressDialog()`, `ui.registerContextMenuAction(scope,…)` |
| Entry points (context menu scopes) | `AudioClip`, `AudioTrack`, `Sample`, `Scene`, `ClipSlot`, `AudioTrack.ArrangementSelection`, `ClipSlotSelection`, … |

### WAAPI commands (what we call)

- `ak.wwise.core.audio.import` — workhorse. `importOperation` (`useExisting`/`replaceExisting`/`createNew`), a `default` block, and `imports[]` of `{ audioFile, objectPath, originalsSubFolder }`. `objectPath` is type-tagged, e.g. `\Actor-Mixer Hierarchy\Default Work Unit\<Random Container>Footsteps\<Sound SFX>step_01`.
- `ak.wwise.core.getInfo` / `getProjectInfo` — handshake + project fingerprint.
- `ak.wwise.core.object.get` (WAQL) / `.create` / `.set` / `.setProperty` / `.setNotes` / `.delete`.
- `ak.wwise.ui.getSelectedObjects`, `ak.wwise.ui.commands.execute` (FindInProjectExplorer, Inspect).
- `ak.wwise.core.transport.*` — audition.
- `ak.wwise.core.object.created` / `nameChanged` — live sync subscriptions.

---

## ⚠️ Make-or-break risk (Phase 0)

WAAPI is **WAMP over a WebSocket to `127.0.0.1:8080`**. The Extension Host is a
Node runtime, but the SDK exposes **no network API**, and the sandbox may block
raw sockets. Everything else depends on this. **Prove it before building
anything.** If sockets are blocked, fall back to writing a tab-delimited import
file + rendered WAVs to a watched folder, imported by a companion
process / WwiseConsole script (`ak.wwise.core.audio.importTabDelimited`).

---

## Phases

### Phase 0 — Connectivity spike *(current)*
Prove the extension host can reach WAAPI. See
[phase-0-waapi-connectivity.md](./phase-0-waapi-connectivity.md).
- Stage A: `node:net` availability + raw TCP connect to `127.0.0.1:8080` (the sandbox gate).
- Stage B: WebSocket upgrade handshake to `/waapi`.
- Stage C: WAMP HELLO→WELCOME, then `ak.wwise.core.getInfo` round-trip.
- Confirm `renderPreFxAudio` output format and constraints.

### Phase 1 — MVP: "Send clip to Wwise"
- Connect panel: host/port, test connection, persist to `storageDirectory`.
- Single audio-clip transfer from the `AudioClip` context menu → render region → `audio.import` as `<Sound SFX>`.
- Import-operation choice; progress via `withinProgressDialog`; deep-link into Wwise via `ui.commands.execute`.

### Phase 2 — Hierarchy mapping & batch
- Batch transfer over `ArrangementSelection` / `ClipSlotSelection`.
- Hierarchy Mapping Table with tokens (`$track`, `$clip`, `$scene`, `$color`, `$group`) → type-tagged `objectPath`.
- Preview panel (files + objects to be created/replaced) before commit.
- Originals subfolder + import destination; named presets.
- Container templates (Random/Sequence/Switch/Blend) via `object.create`.

### Phase 3 — Metadata-rich transfer
- Notes with source track/clip/tempo/warp info.
- Cue-point slicing of long arrangement clips into multiple sources.
- Color → routing/folders; loop/warp metadata carried into import.

### Phase 4 — Round-trip & sync
- Import Wwise-side audio back into Live (`importIntoProject` → `createAudioClip` / `replaceSample`).
- Audition imported objects in Wwise (`transport.*`).
- Object subscriptions for live status; GUID mapping so re-transfer does `replaceExisting`.

### Phase 5 — Music-specific & advanced
- Scenes → Music Segments; cue points → segment cues; tempo/signature → segment tempo.
- Per-track stems → Blend/Switch containers.
- Network transfer to a Wwise on another machine.

---

## Hard SDK limitations (design around / feature-request to Ableton)

- **No post-FX / master / bus render** — only `renderPreFxAudio` per audio track; track FX and mixer processing are not captured.
- **No MIDI-instrument rendering** — cannot bounce MIDI/Simpler/instrument tracks; only existing audio clips/samples transfer.
- **No docked panel** — modal + progress dialogs only.
- **Fixed context-menu scopes** — no menu on return/master tracks or the transport.

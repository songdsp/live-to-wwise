# Phase 2a — Batch transfer, rename-in-Live, and Wwise destination picker

Two behaviors that extend the Phase 1 MVP. They are the concrete core of Phase 2;
the heavier mapping/preview/container work is split out to **Phase 2b**.

> Recommendation: build 2a before 2b. Both behaviors reuse Phase 1's
> `transferAudioToWwise` and the destination picker builds the WAQL hierarchy
> query that 2b's mapping table and preview panel also need.

---

## Behavior 1 — Batch export with rename-in-Live

Select several audio clips, optionally rename them **in Ableton first** (the
clip itself is renamed, so the new name persists in the Live Set), then transfer
all of them to Wwise in one operation.

### Entry points (SDK context-menu scopes)
- **`AudioTrack.ArrangementSelection`** → `{ time_selection_start,
  time_selection_end, selected_lanes: Handle[] }`. Arrangement View. **Build
  first** (user's primary workflow). Gives a time range + lanes, not clips
  directly — resolve by finding clips on each lane (`Track.arrangementClips` /
  `TakeLane.clips`) that overlap `[start, end)`.
- **`ClipSlotSelection`** → `{ selected_clip_slots: Handle[] }`. Session View
  multi-select — an explicit clip set. Add second.

### Clip resolution
- `ClipSlotSelection`: for each slot handle → `ClipSlot.clip`, keep `AudioClip`s
  (skip empty slots and MIDI clips).
- `ArrangementSelection`: resolve each `selected_lanes` handle to `Track`/
  `TakeLane` (via `getObjectFromHandle(h, DataModelObject)` + `instanceof`),
  collect `AudioClip`s overlapping `[start, end)`.

### Rename flow (writes back to Live)
- The batch form lists one row per clip with an editable **name** field,
  pre-filled from `Clip.name`.
- On submit, for each changed row set `clip.name = newName`. Wrap the whole batch
  in `ctx.withinTransaction(...)` so it is **one undo step** in Live.
- The renamed clip's name becomes the Wwise object name; `AudioClip.filePath`
  (the source WAV) is unchanged.

### Batch rename convention
Implemented (pure, verified) in `src/live/rename.ts`. A name is
`prefix · base · suffix`, parts joined with `_`.

- **Base** — text field, default = each file's own original name. A literal
  applies to all selected (the running index keeps them unique).
- **Prefix / suffix** — each has an on/off switch; **off** omits that part
  entirely (its stepper + name field disable). **On** = a `number + name` pair:
  a **stepper for digit count** (zero-pad width) + a **name field** (no spaces;
  name **may be blank** → only the number is added).
- **Mirror rule** — number on the outer edge, name adjacent to the `_`:
  - Suffix: `base` + `_` + name + number → `foo` + `_sample` + `00` = `foo_sample00`
  - Prefix: number + name + `_` + `base` → `01` + `sample` + `_foo` = `01sample_foo`
  - Blank name drops out → `01` + `_foo` = `01_foo`
- **Continuous, resuming index** — runs across the selection in the preview's
  current sort order from 0; a later batch with the **same settings** resumes
  after the highest existing matching index (scan the target namespace for the
  affix pattern — `resumeIndex()` / `buildIndexMatcher()`).
- **≥ 1 affix required for multi-file** — the index is the only guarantee of
  distinct names, so if both prefix/suffix are off the **Rename button disables**
  (`validateRename()`). Single-file: base alone is valid.
- **Collision = abort, don't clobber** — pre-flight every target against
  existing objects at the Wwise destination; on any collision, stop the whole
  batch and show the conflict list (nothing renamed/imported). Layers with the
  import operation (see below). Two-phase temp step **not needed** in this model
  (we create new distinct objects, never swap existing ones on disk).
- **Live preview** — `old → new` for every file before commit
  (`computeBatchNames()`).

> **✅ Resolved — rename operates on clip / Wwise object names.** The batch
> rename sets `Clip.name` (which flows to the Wwise object via `objectPath`);
> **disk files are left untouched**, so clips never go media-offline
> (`AudioClip.filePath` is read-only and can't be re-pointed anyway). Resume +
> collision are evaluated against the **Wwise destination folder** — re-running a
> batch to the same folder resumes numbering after the highest existing matching
> object and won't clobber. The two-phase temp rename is dropped.
>
> **Collision ↔ import operation (step-4 detail):** the resume-index normally
> prevents destination collisions outright. When a target name still matches an
> existing object, the import operation governs intent — `createNew`
> auto-renames, `replaceExisting` updates, `useExisting` skips — so hard "abort
> with conflict list" is reserved for the case where the user wants strict
> creation and a name already exists.

### Transfer loop
- For each resolved clip, call the Phase 1 `transferAudioToWwise` with the
  (possibly renamed) name and the chosen destination + import operation.
- Per-item progress via `withinProgressDialog` (`i/total`).
- **Continue on error**; collect a per-item success/fail summary for the result
  dialog rather than aborting the whole batch on one failure.

### Edge cases / decisions
- **Duplicate target names** under the same parent → warn in the form before
  submit (client-side check); `createNew` auto-renames, `replaceExisting`
  overwrites, `useExisting` skips.
- **Physical original filename** → left as-is. Wwise owns its Originals copy, so
  the WAV keeps its source filename; only the Ableton clip name (→ Wwise object
  name) is changed. No temp copy. See "Source provenance & re-linking" below.
- **Non-audio / empty selections** → skip with a note in the summary.

---

## Source provenance & re-linking

**Key insight — imports are copies, not links.** `audio.import` copies the
source into Wwise's `Originals/` folder; Wwise then owns that copy and no longer
references the Ableton file. So the physical filename doesn't matter and we
**leave the Originals WAV named as-is** — we only rename the Ableton clip, whose
name flows to the Wwise **object** via `objectPath`. No temp copy, no `node:fs`
write path.

Because moving/reorganizing Ableton sources never breaks the Wwise project, the
only mapping that matters is *re-exporting updated audio to the same object
without duplicating it.* Maintain that, most robust last:

1. **Stable `objectPath`** (`parent\name`) → re-import with `replaceExisting`
   updates the same object. Cheapest; breaks if renamed after first transfer.
2. **Provenance in Wwise Notes** (`ak.wwise.core.object.setNotes`) → stamp the
   Live source path + clip name on the object; WAQL-search Notes to find it again
   regardless of renames. Wwise-side source of truth.
3. **Sidecar map** in `storageDirectory`: `sourceFilePath → Wwise GUID`. Key on
   the on-disk **source path** (stable), NOT `Handle.id` (session-scoped).

**Decisions:**
- Leave the Originals WAV filename as-is; rename only the Ableton clip / Wwise object.
- Always `setNotes` on import (cheap, robust provenance).
- Renaming *before* first transfer (this feature) keeps the name stable from the
  start and avoids most relink pain.
- If a clip is renamed *after* it was transferred, offer to rename the existing
  Wwise object (`ak.wwise.core.object.setName`) via the Notes/GUID lookup rather
  than create a duplicate.

---

## Behavior 2 — Wwise destination picker

Replace the free-text "Wwise parent path" field with a dropdown of real
destinations read live from the open Wwise project.

### Query (new WAAPI surface: `ak.wwise.core.object.get` + WAQL)
- WAQL, scoped to the Actor-Mixer Hierarchy (add Interactive Music later):
  `$ "\\Actor-Mixer Hierarchy" select this, descendants`
- `options.return`: `["id", "name", "path", "type"]`.
- Client-side filter to types that can **parent a Sound**: `WorkUnit`, `Folder`,
  `ActorMixer`, `RandomSequenceContainer`, `SwitchContainer`, `BlendContainer`,
  `VirtualFolder`. Present each by `path`.

### Fetch / cache / fallback
- The HTML modal is sandboxed and cannot call WAAPI itself, so the extension
  must fetch destinations **before** opening the form and inject them.
- Flow: connect → query hierarchy → cache the list to `config` → open form.
- **Resilience:** if the fetch fails (Wwise closed), fall back to the cached list,
  then to plain free-text. Use a `<datalist>`-backed input (combobox) so the user
  gets the dropdown **and** can still type a custom path.

---

## Shared: redesigned batch form

```
┌───────────────────────────────────────────────┐
│ Send 3 clips to Wwise                          │
│                                                │
│ Destination  [ \Actor-Mixer\Default WU  ▾ ]    │  ← datalist from object.get
│ If it exists [ Use existing            ▾ ]     │
│                                                │
│  Wwise name          Source                    │
│  [ Footstep_01   ]   footsteps_take3.wav       │  ← rename → writes to Live
│  [ Footstep_02   ]   footsteps_take3.wav       │
│  [ Door_Creak    ]   door_amb.wav              │
│                                                │
│ ⚠ 2 clips share the source file                │  ← client-side warnings
│                          [ Cancel ] [Transfer] │
└───────────────────────────────────────────────┘
```

Submit posts JSON `{ destination, importOperation, items: [{handle_id, name}], … }`.

---

## New surface summary
- **WAAPI:** `ak.wwise.core.object.get` (WAQL) — reusable by 2b;
  `ak.wwise.core.object.setNotes` (provenance); `ak.wwise.core.object.setName`
  (rename-after-transfer).
- **SDK:** `AudioTrack.ArrangementSelection` / `ClipSlotSelection` scopes;
  `ClipSlot.clip`; `Track.arrangementClips`; `TakeLane.clips`; `Clip.name`
  setter; `ctx.withinTransaction`.

## Build order
1. `src/wwise/hierarchy.ts` — `fetchDestinations(client)` via `object.get`/WAQL, Actor-Mixer scope. _(reused by 2b)_
2. Multi-select entry: **`AudioTrack.ArrangementSelection`** → clips overlapping the time range on selected lanes.
3. Batch form (`dialogs.ts`): destination datalist + rename rows + operation + warnings.
4. Rename-in-Live (transaction) + batch transfer loop + `setNotes` + summary.
5. `ClipSlotSelection` (Session View) entry as a second source of clips.
6. Cache destinations to config; offline fallback.

## Decisions (resolved)
- **Entry point first:** Arrangement View (`AudioTrack.ArrangementSelection`); Session second.
- **Physical file:** left as-is (Wwise owns its Originals copy) — rename only the clip/object; always `setNotes` for provenance.
- **Destination scope:** Actor-Mixer Hierarchy only at first; Interactive Music later (Phase 5).

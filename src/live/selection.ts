/**
 * Resolves Live selection contexts into the audio clips to transfer.
 *
 * The `AudioTrack.ArrangementSelection` context menu scope hands us a time range
 * plus a set of lane handles (tracks and/or take lanes), not clips directly, so
 * we collect the audio clips on those lanes that overlap the range.
 */

import {
  AudioClip,
  ClipSlot,
  Track,
  TakeLane,
  DataModelObject,
  type ArrangementSelection,
  type ClipSlotSelection,
  type Clip,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

type Ctx = ExtensionContext<"1.0.0">;

/**
 * Collects the audio clips in an arrangement selection.
 *
 * A clip is included when it overlaps `[start, end)`. If the selection has no
 * real time range (start ≥ end), every audio clip on the selected lanes is
 * included instead. Clips are de-duplicated by handle id.
 */
export function resolveArrangementClips(
  ctx: Ctx,
  selection: ArrangementSelection,
): AudioClip<"1.0.0">[] {
  const start = selection.time_selection_start;
  const end = selection.time_selection_end;
  const hasRange = end > start;

  const result: AudioClip<"1.0.0">[] = [];
  const seen = new Set<bigint>();

  for (const laneHandle of selection.selected_lanes) {
    let lane: DataModelObject<"1.0.0">;
    try {
      lane = ctx.getObjectFromHandle(laneHandle, DataModelObject);
    } catch {
      continue; // lane deleted or unrecognized
    }

    let laneClips: Clip<"1.0.0">[] = [];
    if (lane instanceof Track) {
      laneClips = lane.arrangementClips;
    } else if (lane instanceof TakeLane) {
      laneClips = lane.clips;
    }

    for (const clip of laneClips) {
      if (!(clip instanceof AudioClip)) continue;
      // Overlap test: clip touches the selection range.
      if (hasRange && !(clip.startTime < end && clip.endTime > start)) continue;
      if (seen.has(clip.handle.id)) continue;
      seen.add(clip.handle.id);
      result.push(clip);
    }
  }

  // Stable order by arrangement position, then name.
  return result.sort((a, b) => a.startTime - b.startTime || a.name.localeCompare(b.name));
}

/**
 * Collects the audio clips from a Session View clip-slot selection, in the order
 * the slots were selected. Empty slots and MIDI clips are skipped; clips are
 * de-duplicated by handle id.
 */
export function resolveClipSlotClips(
  ctx: Ctx,
  selection: ClipSlotSelection,
): AudioClip<"1.0.0">[] {
  const result: AudioClip<"1.0.0">[] = [];
  const seen = new Set<bigint>();

  for (const slotHandle of selection.selected_clip_slots) {
    let slot: ClipSlot<"1.0.0">;
    try {
      slot = ctx.getObjectFromHandle(slotHandle, ClipSlot);
    } catch {
      continue;
    }
    const clip = slot.clip;
    if (clip instanceof AudioClip && !seen.has(clip.handle.id)) {
      seen.add(clip.handle.id);
      result.push(clip);
    }
  }

  return result;
}

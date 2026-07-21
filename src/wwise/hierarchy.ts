/**
 * Reads potential import destinations from the open Wwise project via
 * `ak.wwise.core.object.get` (WAQL). Reused by the Phase 2a destination picker
 * and later by Phase 2b's mapping table / preview.
 */

import type { WaapiClient } from "../waapi/client.js";

export interface WwiseDestination {
  id: string;
  name: string;
  /** Full Wwise path, e.g. `\Actor-Mixer Hierarchy\Default Work Unit\SFX`. */
  path: string;
  type: string;
}

/** Wwise object types that can be the parent of a `<Sound SFX>`. */
export const CONTAINER_TYPES: readonly string[] = [
  "WorkUnit",
  "Folder", // Virtual Folder
  "ActorMixer",
  "RandomSequenceContainer",
  "SwitchContainer",
  "BlendContainer",
];

/** Root of the Actor-Mixer Hierarchy (2a scope; Interactive Music comes later). */
export const ACTOR_MIXER_ROOT = "\\Actor-Mixer Hierarchy";

/**
 * Returns the container-capable objects under `root`, sorted by path, suitable
 * as `<Sound SFX>` parents. Filters descendants client-side so a WAQL `where`
 * quirk can't fail the whole query.
 */
export async function fetchDestinations(
  client: WaapiClient,
  root: string = ACTOR_MIXER_ROOT,
): Promise<WwiseDestination[]> {
  const waql = `$ "${root}" select this, descendants`;
  const result = await client.call<{ return?: WwiseDestination[] }>(
    "ak.wwise.core.object.get",
    { waql },
    { return: ["id", "name", "path", "type"] },
  );

  const objects = result.return ?? [];
  const allowed = new Set(CONTAINER_TYPES);
  return objects
    .filter((o) => o.path && allowed.has(o.type))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface WwiseHierarchy {
  /** Container-capable destination paths (for the picker). */
  destinations: string[];
  /** Immediate child names keyed by parent path (for live resume preview). */
  childrenByPath: Record<string, string[]>;
}

/**
 * One descendants query that yields both the destination list and a
 * parent-path → child-names map, so the batch form can preview resumed indices
 * without further WAAPI calls.
 */
export async function fetchHierarchy(
  client: WaapiClient,
  root: string = ACTOR_MIXER_ROOT,
): Promise<WwiseHierarchy> {
  const waql = `$ "${root}" select this, descendants`;
  const result = await client.call<{ return?: WwiseDestination[] }>(
    "ak.wwise.core.object.get",
    { waql },
    { return: ["id", "name", "path", "type"] },
  );

  const objects = result.return ?? [];
  const allowed = new Set(CONTAINER_TYPES);
  const destinations: string[] = [];
  const childrenByPath: Record<string, string[]> = {};
  for (const o of objects) {
    if (!o.path) continue;
    if (allowed.has(o.type)) destinations.push(o.path);
    const idx = o.path.lastIndexOf("\\");
    if (idx > 0) {
      const parent = o.path.slice(0, idx);
      (childrenByPath[parent] ??= []).push(o.name ?? o.path.slice(idx + 1));
    }
  }
  destinations.sort((a, b) => a.localeCompare(b));
  return { destinations, childrenByPath };
}

/**
 * Names of the immediate children of `parentPath`. Used to resume the batch
 * index and pre-flight collisions against the chosen Wwise destination.
 */
export async function fetchChildNames(client: WaapiClient, parentPath: string): Promise<string[]> {
  const waql = `$ "${parentPath}" select children`;
  const result = await client.call<{ return?: { name?: string }[] }>(
    "ak.wwise.core.object.get",
    { waql },
    { return: ["name"] },
  );
  return (result.return ?? []).map((o) => o.name ?? "").filter((n) => n.length > 0);
}

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
/** Structured `object.get` args for "the object at `root` and everything under it". */
function descendantsQuery(root: string) {
  // Canonical, version-safe form (works on all Wwise versions, unlike some WAQL selectors).
  return { from: { path: [root] }, transform: [{ select: ["descendants"] }] };
}

export async function fetchDestinations(
  client: WaapiClient,
  root: string = ACTOR_MIXER_ROOT,
): Promise<WwiseDestination[]> {
  const result = await client.call<{ return?: WwiseDestination[] }>(
    "ak.wwise.core.object.get",
    descendantsQuery(root),
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
  const result = await client.call<{ return?: WwiseDestination[] }>(
    "ak.wwise.core.object.get",
    descendantsQuery(root),
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
  console.log(
    `[live-to-wwise] hierarchy under "${root}": ${objects.length} objects, ${destinations.length} destinations` +
    (objects.length && !destinations.length
      ? ` (types seen: ${[...new Set(objects.map((o) => o.type))].join(", ")})`
      : ""),
  );
  return { destinations, childrenByPath };
}

/**
 * Names of the immediate children of `parentPath`. Used to resume the batch
 * index and pre-flight collisions against the chosen Wwise destination.
 *
 * A path that doesn't resolve — e.g. a container about to be created on this
 * run — makes WAQL raise `ak.wwise.query.invalid_query`. That just means "no
 * object there yet", so we treat it as no children (index resumes from 0).
 */
export async function fetchChildNames(client: WaapiClient, parentPath: string): Promise<string[]> {
  const waql = `$ "${parentPath}" select children`;
  try {
    const result = await client.call<{ return?: { name?: string }[] }>(
      "ak.wwise.core.object.get",
      { waql },
      { return: ["name"] },
    );
    return (result.return ?? []).map((o) => o.name ?? "").filter((n) => n.length > 0);
  } catch (err) {
    if (/invalid_query/.test((err as Error)?.message ?? "")) return [];
    throw err;
  }
}

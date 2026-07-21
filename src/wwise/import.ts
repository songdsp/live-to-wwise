/**
 * Transfer helpers: turn a Live audio source into a Wwise object via
 * `ak.wwise.core.audio.import`, then reveal it in the Project Explorer.
 */

import type { WaapiClient } from "../waapi/client.js";
import type { ImportOperation } from "../config.js";

export interface TransferRequest {
  /** Absolute path to the audio file to import (WAV/AIFF recommended). */
  audioFile: string;
  /** Wwise parent path, e.g. `\Actor-Mixer Hierarchy\Default Work Unit`. */
  parentPath: string;
  /** Desired Wwise object name (will be sanitized). */
  objectName: string;
  importLanguage: string;
  importOperation: ImportOperation;
}

export interface ImportedObject {
  id: string;
  name?: string;
  path?: string;
  type?: string;
}

/**
 * Wwise object names can't contain the path/reserved characters; replace them
 * so the name is safe to embed in a type-tagged `objectPath`.
 */
export function sanitizeWwiseName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "Unnamed";
}

/**
 * Imports a single audio file as a `<Sound SFX>` under `parentPath`.
 * Returns the created (or existing/replaced) Wwise object.
 */
export async function transferAudioToWwise(
  client: WaapiClient,
  req: TransferRequest,
): Promise<ImportedObject> {
  const name = sanitizeWwiseName(req.objectName);
  // Type-tagged path — the `<Sound SFX>` prefix tells Wwise which object to create.
  const objectPath = `${req.parentPath}\\<Sound SFX>${name}`;

  const result = await client.call<{ objects?: ImportedObject[] }>(
    "ak.wwise.core.audio.import",
    {
      importOperation: req.importOperation,
      default: { importLanguage: req.importLanguage },
      imports: [{ audioFile: req.audioFile, objectPath }],
    },
    { return: ["id", "name", "path", "type"] },
  );

  const obj = result.objects?.[0];
  if (!obj?.id) {
    throw new Error("Import succeeded but returned no object.");
  }
  return obj;
}

/** Writes provenance to a Wwise object's Notes so it stays findable / re-linkable. */
export async function setObjectNotes(
  client: WaapiClient,
  objectId: string,
  notes: string,
): Promise<void> {
  await client.call("ak.wwise.core.object.setNotes", { object: objectId, value: notes });
}

/** Selects and scrolls to one or more objects in Wwise's Project Explorer (best-effort). */
export async function revealInWwise(
  client: WaapiClient,
  objectIds: string | string[],
): Promise<void> {
  const objects = Array.isArray(objectIds) ? objectIds : [objectIds];
  if (objects.length === 0) return;
  await client.call("ak.wwise.ui.commands.execute", {
    command: "FindInProjectExplorerSyncGroup1",
    objects,
  });
}

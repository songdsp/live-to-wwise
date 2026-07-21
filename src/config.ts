/**
 * Persistent settings for live-to-wwise, stored as JSON in the extension's
 * `environment.storageDirectory` so connection + destination choices survive
 * across Live sessions.
 */

import type { BatchRenameSettings } from "./live/rename.js";

export type ImportOperation = "createNew" | "useExisting" | "replaceExisting";

/** Wwise container to wrap a batch in; `none` imports loose sibling sounds. */
export type ContainerType = "none" | "random" | "sequence" | "switch" | "blend";

export interface ContainerSettings {
  type: ContainerType;
  /** Name of the container to find-or-create; ignored when `type` is `none`. */
  name: string;
}

export interface WaapiConfig {
  host: string;
  port: number;
  /** Wwise parent path, e.g. `\Actor-Mixer Hierarchy\Default Work Unit`. */
  parentPath: string;
  /** WAAPI import language; `SFX` for non-localized sound effects. */
  importLanguage: string;
  importOperation: ImportOperation;
  /** Last-used batch rename settings. */
  batchRename: BatchRenameSettings;
  /** Last-used container template. */
  container: ContainerSettings;
}

export const DEFAULT_CONFIG: WaapiConfig = {
  host: "127.0.0.1",
  port: 8080,
  parentPath: "\\Actor-Mixer Hierarchy\\Default Work Unit",
  importLanguage: "SFX",
  importOperation: "useExisting",
  batchRename: {
    base: { mode: "original", value: "" },
    prefix: { enabled: false, digits: 2, name: "" },
    suffix: { enabled: true, digits: 2, name: "" },
  },
  container: { type: "none", name: "" },
};

const CONFIG_FILE = "config.json";

/**
 * The directory to persist to. Prefers the host's per-extension
 * `environment.storageDirectory`; when the host doesn't provide one (e.g. dev
 * `extensions-cli run`), falls back to `~/.live-to-wwise` so settings still
 * survive across sessions.
 */
export function resolveStorageDir(storageDir: string | undefined): string {
  if (storageDir) return storageDir;
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return path.join(os.homedir(), ".live-to-wwise");
}

/** Loads config from the storage directory, falling back to defaults. */
export function loadConfig(storageDir: string | undefined): WaapiConfig {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const raw = fs.readFileSync(path.join(resolveStorageDir(storageDir), CONFIG_FILE), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<WaapiConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes config to the storage directory (best-effort; logs on failure). */
export function saveConfig(storageDir: string | undefined, config: WaapiConfig): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = resolveStorageDir(storageDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.log(`[live-to-wwise] Failed to save config: ${(err as Error)?.message}`);
  }
}

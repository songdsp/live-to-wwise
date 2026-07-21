/**
 * Persistent settings for live-to-wwise, stored as JSON in the extension's
 * `environment.storageDirectory` so connection + destination choices survive
 * across Live sessions.
 */

import type { BatchRenameSettings } from "./live/rename.js";

export type ImportOperation = "createNew" | "useExisting" | "replaceExisting";

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
};

const CONFIG_FILE = "config.json";

/** Loads config from the storage directory, falling back to defaults. */
export function loadConfig(storageDir: string | undefined): WaapiConfig {
  if (!storageDir) return { ...DEFAULT_CONFIG };
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const raw = fs.readFileSync(path.join(storageDir, CONFIG_FILE), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<WaapiConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes config to the storage directory (best-effort; logs on failure). */
export function saveConfig(storageDir: string | undefined, config: WaapiConfig): void {
  if (!storageDir) return;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, CONFIG_FILE),
      JSON.stringify(config, null, 2),
      "utf8",
    );
  } catch (err) {
    console.log(`[live-to-wwise] Failed to save config: ${(err as Error)?.message}`);
  }
}

/**
 * On-disk cache of the last-fetched Wwise hierarchy, so the batch form can still
 * populate its destination picker when WAAPI is momentarily unreachable.
 */

import { resolveStorageDir } from "../config.js";
import type { WwiseHierarchy } from "./hierarchy.js";

const CACHE_FILE = "hierarchy-cache.json";

export function saveHierarchyCache(storageDir: string | undefined, hierarchy: WwiseHierarchy): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = resolveStorageDir(storageDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(hierarchy), "utf8");
  } catch (err) {
    console.log(`[live-to-wwise] Failed to cache hierarchy: ${(err as Error)?.message}`);
  }
}

export function loadHierarchyCache(storageDir: string | undefined): WwiseHierarchy | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const raw = fs.readFileSync(path.join(resolveStorageDir(storageDir), CACHE_FILE), "utf8");
    const h = JSON.parse(raw) as WwiseHierarchy;
    if (Array.isArray(h.destinations) && h.childrenByPath) return h;
    return null;
  } catch {
    return null;
  }
}

/**
 * Batch-rename naming convention (Phase 2a).
 *
 * A name is `prefix · base · suffix`, the parts joined with `_`:
 *   - base: each clip's original name, or a literal applied to all.
 *   - prefix (optional): `<index><name>` — number on the outer edge, name next to `_`.
 *   - suffix (optional): `<name><index>` — name next to `_`, number on the outer edge.
 *   - a blank affix name collapses to just the (zero-padded) index.
 *
 * This module is pure (no I/O) so it can drive the live `old → new` preview.
 * Where the resuming index and collision checks are evaluated (Wwise destination
 * vs disk) is decided by the caller — see docs/phase-2a-batch-and-destination.md.
 */

export interface AffixSettings {
  enabled: boolean;
  /** Zero-pad width for the running index. */
  digits: number;
  /** Static name; may be blank; spaces are stripped. */
  name: string;
}

export interface BatchRenameSettings {
  base: { mode: "original" | "literal"; value: string };
  prefix: AffixSettings;
  suffix: AffixSettings;
}

export interface RenameEntry {
  oldName: string;
  newName: string;
  index: number;
}

function padIndex(index: number, digits: number): string {
  const s = String(Math.max(0, Math.trunc(index)));
  return s.length >= digits ? s : "0".repeat(digits - s.length) + s;
}

function stripSpaces(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Computes the new name for one clip at a given running index. */
export function computeName(
  original: string,
  index: number,
  settings: BatchRenameSettings,
): string {
  const base = settings.base.mode === "literal" ? settings.base.value : original;
  const parts: string[] = [];
  if (settings.prefix.enabled) {
    // number outer, name adjacent to the `_`
    parts.push(padIndex(index, settings.prefix.digits) + stripSpaces(settings.prefix.name));
  }
  parts.push(base);
  if (settings.suffix.enabled) {
    // name adjacent to the `_`, number outer
    parts.push(stripSpaces(settings.suffix.name) + padIndex(index, settings.suffix.digits));
  }
  return parts.filter((p) => p.length > 0).join("_");
}

/** Computes `old → new` for the whole selection, indices running from `startIndex`. */
export function computeBatchNames(
  originals: string[],
  settings: BatchRenameSettings,
  startIndex = 0,
): RenameEntry[] {
  return originals.map((oldName, i) => {
    const index = startIndex + i;
    return { oldName, newName: computeName(oldName, index, settings), index };
  });
}

/**
 * Validity of a rename batch. For a multi-file selection at least one of
 * prefix/suffix must be enabled, since the running index is what keeps the N
 * outputs distinct (a literal base would otherwise collapse them). A single-file
 * rename has no such requirement.
 */
export function validateRename(
  settings: BatchRenameSettings,
  fileCount: number,
): { ok: boolean; reason?: string } {
  if (fileCount > 1 && !settings.prefix.enabled && !settings.suffix.enabled) {
    return { ok: false, reason: "Enable a prefix or suffix so each file gets a unique index." };
  }
  return { ok: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A matcher that extracts the running index from an existing name produced by
 * these settings, or `null` if the name doesn't match. Used to (a) resume the
 * index after the highest existing match and (b) detect the pattern in a target
 * namespace. Prefers the suffix anchor, else the prefix.
 */
export function buildIndexMatcher(settings: BatchRenameSettings): ((name: string) => number | null) | null {
  let re: RegExp | null = null;
  if (settings.suffix.enabled) {
    re = new RegExp(`_${escapeRegExp(stripSpaces(settings.suffix.name))}(\\d+)$`);
  } else if (settings.prefix.enabled) {
    re = new RegExp(`^(\\d+)${escapeRegExp(stripSpaces(settings.prefix.name))}_`);
  }
  if (!re) return null;
  const matcher = re;
  return (name: string) => {
    const m = matcher.exec(name);
    return m ? parseInt(m[1], 10) : null;
  };
}

/**
 * The index to resume at: one past the highest index among `existingNames` that
 * matches the settings pattern, or 0 when none match.
 */
export function resumeIndex(settings: BatchRenameSettings, existingNames: string[]): number {
  const matcher = buildIndexMatcher(settings);
  if (!matcher) return 0;
  let max = -1;
  for (const name of existingNames) {
    const idx = matcher(name);
    if (idx !== null && idx > max) max = idx;
  }
  return max + 1;
}

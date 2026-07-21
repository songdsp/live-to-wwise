import {
  initialize,
  AudioClip,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";
import { resolveArrangementClips, resolveClipSlotClips } from "./live/selection.js";
import { computeBatchNames, resumeIndex, type BatchRenameSettings } from "./live/rename.js";
import { WaapiClient } from "./waapi/client.js";
import { loadConfig, saveConfig, type WaapiConfig, type ImportOperation } from "./config.js";
import { transferAudioToWwise, revealInWwise, setObjectNotes, type ImportedObject } from "./wwise/import.js";
import { fetchHierarchy, fetchChildNames, fetchDestinations } from "./wwise/hierarchy.js";
import { saveHierarchyCache, loadHierarchyCache } from "./wwise/cache.js";
import { resultDialogUrl, transferFormUrl, batchFormUrl } from "./ui/dialogs.js";

type Ctx = ExtensionContext<"1.0.0">;
type Tone = "ok" | "warn" | "error";

function showResult(ctx: Ctx, title: string, badge: string, tone: Tone, body: string): Promise<string> {
  return ctx.ui.showModalDialog(resultDialogUrl(title, badge, tone, body), 480, 320);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;");
}

function baseName(path: string): string {
  const m = /[^/\\]+$/.exec(path);
  return m ? m[0] : path;
}

/** Phase 1 — transfer a single audio clip's source file to Wwise. */
async function sendClip(ctx: Ctx, handle: Handle): Promise<void> {
  let clip: AudioClip<"1.0.0">;
  try {
    clip = ctx.getObjectFromHandle(handle, AudioClip);
  } catch (err) {
    await showResult(ctx, "Send to Wwise", "not an audio clip", "error",
      `<p>Could not read the selected clip: <code>${(err as Error)?.message}</code></p>`);
    return;
  }

  const filePath = clip.filePath;
  const clipName = clip.name;
  if (!filePath) {
    await showResult(ctx, "Send to Wwise", "no source file", "error",
      "<p>This clip has no source audio file to import.</p>");
    return;
  }

  const storageDir = ctx.environment.storageDirectory;
  const config = loadConfig(storageDir);

  const formRaw = await ctx.ui.showModalDialog(transferFormUrl(config, clipName, filePath), 480, 440);
  if (!formRaw) return; // cancelled

  let req: WaapiConfig & { objectName: string };
  try {
    req = JSON.parse(formRaw);
  } catch {
    return;
  }

  // Remember connection + destination choices for next time.
  saveConfig(storageDir, {
    ...config,
    host: req.host,
    port: req.port,
    parentPath: req.parentPath,
    importLanguage: req.importLanguage,
    importOperation: req.importOperation,
  });

  const outcome = await ctx.ui.withinProgressDialog(
    "Transferring to Wwise…",
    { progress: 0 },
    async (update) => {
      let client: WaapiClient | undefined;
      try {
        await update("Connecting to WAAPI…", 20);
        client = await WaapiClient.connect({ host: req.host, port: req.port });
        await update(`Importing “${req.objectName}”…`, 60);
        const obj = await transferAudioToWwise(client, {
          audioFile: filePath,
          parentPath: req.parentPath,
          objectName: req.objectName,
          importLanguage: req.importLanguage,
          importOperation: req.importOperation,
        });
        await update("Revealing in Wwise…", 90);
        try {
          await revealInWwise(client, obj.id);
        } catch {
          /* deep-link is best-effort */
        }
        return { ok: true as const, obj };
      } catch (err) {
        return { ok: false as const, message: (err as Error)?.message ?? String(err) };
      } finally {
        client?.close();
      }
    },
  );

  const res = outcome as { ok: true; obj: ImportedObject } | { ok: false; message: string };
  if (res.ok) {
    await showResult(ctx, "Sent to Wwise", "imported", "ok",
      `<p>Created / updated in Wwise:</p>` +
      `<p><code>${res.obj.path ?? res.obj.name ?? res.obj.id}</code></p>` +
      `<p>Type: <code>${res.obj.type ?? "Sound"}</code></p>`);
  } else {
    await showResult(ctx, "Send to Wwise", "failed", "error",
      `<p>Transfer failed:</p><p><code>${res.message}</code></p>`);
  }
}

/** Diagnostic: WAMP session + ak.wwise.core.getInfo round-trip. */
async function testConnection(ctx: Ctx): Promise<void> {
  const config = loadConfig(ctx.environment.storageDirectory);
  const outcome = await ctx.ui.withinProgressDialog(
    "Connecting to WAAPI…",
    { progress: 0 },
    async (update) => {
      let client: WaapiClient | undefined;
      try {
        client = await WaapiClient.connect({ host: config.host, port: config.port });
        await update("Calling ak.wwise.core.getInfo…", 60);
        const info = await client.call<{
          version?: { displayName?: string; year?: number };
          apiVersion?: number;
        }>("ak.wwise.core.getInfo");
        const v = info.version ?? {};
        return {
          ok: true as const,
          body:
            `<p>Connected to <code>${config.host}:${config.port}</code></p>` +
            `<p>Wwise: <code>${v.displayName ?? "?"}</code> (${v.year ?? "?"}) · ` +
            `apiVersion <code>${info.apiVersion ?? "?"}</code></p>`,
        };
      } catch (err) {
        return { ok: false as const, body: `<p><code>${(err as Error)?.message ?? err}</code></p>` };
      } finally {
        client?.close();
      }
    },
  );
  const res = outcome as { ok: boolean; body: string };
  await showResult(ctx, "WAAPI Connection", res.ok ? "connected" : "failed", res.ok ? "ok" : "error", res.body);
}

/** Arrangement View entry (`AudioTrack.ArrangementSelection`). */
async function sendSelection(ctx: Ctx, selection: ArrangementSelection): Promise<void> {
  await runBatch(ctx, resolveArrangementClips(ctx, selection), "arrangement selection");
}

/** Session View entry (`ClipSlotSelection`). */
async function sendClipSlots(ctx: Ctx, selection: ClipSlotSelection): Promise<void> {
  await runBatch(ctx, resolveClipSlotClips(ctx, selection), "clip-slot selection");
}

/**
 * Phase 2a: batch-transfer a set of audio clips — fetch destinations (cached
 * fallback), show the batch form with live rename preview, rename the clips in
 * Live as one undo step, then transfer each with provenance and a summary.
 */
async function runBatch(
  ctx: Ctx,
  clips: AudioClip<"1.0.0">[],
  sourceLabel: string,
): Promise<void> {
  if (clips.length === 0) {
    await showResult(ctx, "Send to Wwise", "no clips", "warn",
      `<p>No audio clips found in the ${sourceLabel}.</p>`);
    return;
  }

  const config = loadConfig(ctx.environment.storageDirectory);
  const storageDir = ctx.environment.storageDirectory;
  const originals = clips.map((c) => c.name);

  // Fetch destinations + children up front (the sandboxed form can't call
  // WAAPI). Cache on success; on failure fall back to the cached hierarchy.
  const hierarchy = (await ctx.ui.withinProgressDialog(
    "Reading Wwise destinations…",
    { progress: 0 },
    async () => {
      let client: WaapiClient | undefined;
      try {
        client = await WaapiClient.connect({ host: config.host, port: config.port });
        const h = await fetchHierarchy(client);
        saveHierarchyCache(storageDir, h);
        return { ...h, offline: false };
      } catch (err) {
        console.log(`[live-to-wwise] destination fetch failed: ${(err as Error)?.message}`);
        const cached = loadHierarchyCache(storageDir);
        return cached
          ? { ...cached, offline: true }
          : { destinations: [] as string[], childrenByPath: {} as Record<string, string[]>, offline: true };
      } finally {
        client?.close();
      }
    },
  )) as { destinations: string[]; childrenByPath: Record<string, string[]>; offline: boolean };

  const formRaw = await ctx.ui.showModalDialog(
    batchFormUrl(
      originals,
      hierarchy.destinations,
      {
        destination: config.parentPath,
        importOperation: config.importOperation,
        rename: config.batchRename,
      },
      hierarchy.childrenByPath,
      hierarchy.offline,
    ),
    560,
    580,
  );
  if (!formRaw) return; // cancelled

  let settings: { destination: string; importOperation: string; rename: BatchRenameSettings };
  try {
    settings = JSON.parse(formRaw);
  } catch {
    return;
  }

  saveConfig(ctx.environment.storageDirectory, {
    ...config,
    parentPath: settings.destination,
    importOperation: settings.importOperation as ImportOperation,
    batchRename: settings.rename,
  });

  type ItemResult = { name: string; ok: boolean; path?: string; error?: string };
  const outcome = await ctx.ui.withinProgressDialog(
    "Transferring to Wwise…",
    { progress: 0 },
    async (update) => {
      let client: WaapiClient | undefined;
      try {
        await update("Connecting to WAAPI…", 5);
        client = await WaapiClient.connect({ host: config.host, port: config.port });

        // Resume the index after existing matching objects at the destination.
        await update("Checking existing objects…", 12);
        const childNames = await fetchChildNames(client, settings.destination);
        const start = resumeIndex(settings.rename, childNames);
        const entries = computeBatchNames(originals, settings.rename, start);

        // Rename the clips in Live as a single undo step.
        await update("Renaming clips in Live…", 20);
        ctx.withinTransaction(() => {
          entries.forEach((e, i) => {
            if (clips[i].name !== e.newName) clips[i].name = e.newName;
          });
        });

        // Transfer each clip; continue past failures and report per item.
        const results: ItemResult[] = [];
        const importedIds: string[] = [];
        for (let i = 0; i < clips.length; i++) {
          const name = entries[i].newName;
          const pct = 25 + Math.round((i / clips.length) * 70);
          await update(`Importing ${i + 1}/${clips.length}: ${name}`, pct);

          const filePath = clips[i].filePath;
          if (!filePath) {
            results.push({ name, ok: false, error: "no source file" });
            continue;
          }
          try {
            const obj = await transferAudioToWwise(client, {
              audioFile: filePath,
              parentPath: settings.destination,
              objectName: name,
              importLanguage: config.importLanguage,
              importOperation: settings.importOperation as ImportOperation,
            });
            importedIds.push(obj.id);
            try {
              await setObjectNotes(client, obj.id, `live-to-wwise · source: ${filePath} · clip: ${name}`);
            } catch {
              /* notes are best-effort */
            }
            results.push({ name, ok: true, path: obj.path });
          } catch (err) {
            results.push({ name, ok: false, error: (err as Error)?.message ?? String(err) });
          }
        }

        if (importedIds.length > 0) {
          await update("Revealing in Wwise…", 97);
          try {
            await revealInWwise(client, importedIds);
          } catch {
            /* deep-link best-effort */
          }
        }
        return { results };
      } catch (err) {
        return { fatal: (err as Error)?.message ?? String(err) };
      } finally {
        client?.close();
      }
    },
  );

  const res = outcome as { results?: ItemResult[]; fatal?: string };
  if (res.fatal || !res.results) {
    await showResult(ctx, "Batch transfer", "failed", "error",
      `<p><code>${escapeHtml(res.fatal ?? "unknown error")}</code></p>`);
    return;
  }
  const results = res.results;
  const okCount = results.filter((r) => r.ok).length;
  const rows = results
    .map((r) =>
      r.ok
        ? `<li>✓ <code>${escapeHtml(r.path ?? r.name)}</code></li>`
        : `<li>✗ <code>${escapeHtml(r.name)}</code> — ${escapeHtml(r.error ?? "")}</li>`)
    .join("");
  await showResult(ctx, "Batch transfer", `${okCount}/${results.length} sent`,
    okCount === results.length ? "ok" : "warn",
    `<p>Destination <code>${escapeHtml(settings.destination)}</code></p>` +
    `<ul style="padding-left:18px;max-height:240px;overflow:auto">${rows}</ul>`);
}

/** Phase 2a step 1 diagnostic: list Wwise import destinations via WAQL. */
async function listDestinations(ctx: Ctx): Promise<void> {
  const config = loadConfig(ctx.environment.storageDirectory);
  const outcome = await ctx.ui.withinProgressDialog(
    "Reading Wwise hierarchy…",
    { progress: 0 },
    async (update) => {
      let client: WaapiClient | undefined;
      try {
        client = await WaapiClient.connect({ host: config.host, port: config.port });
        await update("Querying ak.wwise.core.object.get…", 60);
        const dests = await fetchDestinations(client);
        return { ok: true as const, dests };
      } catch (err) {
        return { ok: false as const, message: (err as Error)?.message ?? String(err) };
      } finally {
        client?.close();
      }
    },
  );

  const res = outcome as
    | { ok: true; dests: { path: string; type: string }[] }
    | { ok: false; message: string };
  if (!res.ok) {
    await showResult(ctx, "Wwise Destinations", "failed", "error",
      `<p><code>${res.message}</code></p>`);
    return;
  }
  const shown = res.dests.slice(0, 100);
  const rows = shown
    .map((d) => `<li><code>${d.path}</code> <span style="opacity:.6">(${d.type})</span></li>`)
    .join("");
  const more = res.dests.length > shown.length ? `<p>…and ${res.dests.length - shown.length} more.</p>` : "";
  await showResult(ctx, "Wwise Destinations", `${res.dests.length} found`,
    res.dests.length > 0 ? "ok" : "warn",
    (res.dests.length === 0
      ? "<p>No container-capable destinations found. Is a project open?</p>"
      : `<ul style="padding-left:18px;max-height:200px;overflow:auto">${rows}</ul>${more}`));
}

export function activate(activation: ActivationContext) {
  const ctx = initialize(activation, "1.0.0");

  if (!ctx.environment.storageDirectory) {
    console.log("[live-to-wwise] No storage directory; config will not persist.");
  }

  ctx.commands.registerCommand("live-to-wwise.sendClip", (...args) => {
    void sendClip(ctx, args[0] as Handle);
  });

  ctx.commands.registerCommand("live-to-wwise.testConnection", () => {
    void testConnection(ctx);
  });

  ctx.commands.registerCommand("live-to-wwise.listDestinations", () => {
    void listDestinations(ctx);
  });

  ctx.commands.registerCommand("live-to-wwise.sendSelection", (...args) => {
    void sendSelection(ctx, args[0] as ArrangementSelection);
  });

  ctx.commands.registerCommand("live-to-wwise.sendClipSlots", (...args) => {
    void sendClipSlots(ctx, args[0] as ClipSlotSelection);
  });

  ctx.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Send to Wwise…",
    "live-to-wwise.sendSelection",
  );
  ctx.ui.registerContextMenuAction(
    "ClipSlotSelection",
    "Send to Wwise…",
    "live-to-wwise.sendClipSlots",
  );
  ctx.ui.registerContextMenuAction("AudioClip", "Send to Wwise…", "live-to-wwise.sendClip");
  ctx.ui.registerContextMenuAction("AudioClip", "Test WAAPI Connection", "live-to-wwise.testConnection");
  ctx.ui.registerContextMenuAction("AudioClip", "List Wwise Destinations", "live-to-wwise.listDestinations");
}

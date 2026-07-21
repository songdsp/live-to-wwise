import {
  initialize,
  AudioClip,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
} from "@ableton-extensions/sdk";
import { resolveArrangementClips, resolveClipSlotClips } from "./live/selection.js";
import { computeBatchNames, resumeIndex, type BatchRenameSettings } from "./live/rename.js";
import { WaapiClient } from "./waapi/client.js";
import { loadConfig, saveConfig, type ContainerSettings, type ImportOperation } from "./config.js";
import { transferAudioToWwise, revealInWwise, setObjectNotes, sanitizeWwiseName } from "./wwise/import.js";
import { fetchHierarchy, fetchChildNames } from "./wwise/hierarchy.js";
import { saveHierarchyCache, loadHierarchyCache } from "./wwise/cache.js";
import { resultDialogUrl, batchFormUrl } from "./ui/dialogs.js";

type Ctx = ExtensionContext<"1.0.0">;
type Tone = "ok" | "warn" | "error";

function showResult(ctx: Ctx, title: string, badge: string, tone: Tone, body: string): Promise<string> {
  return ctx.ui.showModalDialog(resultDialogUrl(title, badge, tone, body), 480, 320);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;");
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
        container: config.container,
      },
      hierarchy.childrenByPath,
      hierarchy.offline,
    ),
    560,
    580,
  );
  if (!formRaw) return; // cancelled

  let settings: {
    destination: string;
    importOperation: string;
    rename: BatchRenameSettings;
    container: ContainerSettings;
  };
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
    container: settings.container,
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

        // Resume the index after existing matching objects. When wrapping in a
        // container, the sounds live inside it — so check the container's
        // children (a fresh container has none → numbering from 0), not the
        // destination's. WAQL paths carry no type tag, just the plain name.
        await update("Checking existing objects…", 12);
        const collisionParent =
          settings.container.type !== "none" && settings.container.name.trim()
            ? `${settings.destination}\\${sanitizeWwiseName(settings.container.name)}`
            : settings.destination;
        const childNames = await fetchChildNames(client, collisionParent);
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
              container: settings.container,
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

export function activate(activation: ActivationContext) {
  const ctx = initialize(activation, "1.0.0");

  if (!ctx.environment.storageDirectory) {
    console.log("[live-to-wwise] Host provided no storage directory; persisting to ~/.live-to-wwise instead.");
  }

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
}

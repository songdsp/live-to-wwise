/**
 * HTML builders for the extension's modal dialogs, returned as `data:` URLs for
 * `ui.showModalDialog`. A dialog returns a value by posting
 * `{ method: "close_and_send", params: [string] }` to the host; the empty
 * string denotes cancel.
 */

import type { WaapiConfig } from "../config.js";
import type { BatchRenameSettings } from "../live/rename.js";

type Tone = "ok" | "warn" | "error";

/** Attributes that turn off macOS/WebKit text meddling in name fields. */
const NO_AUTOCORRECT = `autocorrect="off" autocapitalize="off" spellcheck="false" autocomplete="off"`;

const CLOSE_SCRIPT = `
  function postResult(s){
    const m = { method: "close_and_send", params: [s] };
    if (window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage(m);
    else if (window.chrome?.webview) window.chrome.webview.postMessage(m);
  }`;

const BASE_STYLE = `
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 16px; color: #1c1c1c; }
  h1 { font-size: 15px; margin: 0 0 10px; }
  p { margin: 8px 0; }
  code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; word-break: break-all; }
  label { display: block; margin: 8px 0 2px; font-weight: 600; font-size: 12px; }
  input, select { width: 100%; box-sizing: border-box; padding: 5px 6px; font: inherit; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  button { padding: 6px 14px; font: inherit; }
  button.primary { font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff;
           font-weight: 600; text-transform: uppercase; font-size: 11px; }`;

function toDataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

/** A simple colour-coded result modal. `body` is raw HTML. */
export function resultDialogUrl(title: string, badge: string, tone: Tone, body: string): string {
  const color = tone === "ok" ? "#2e7d32" : tone === "warn" ? "#ef6c00" : "#c62828";
  return toDataUrl(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_STYLE}
  .badge { background: ${color}; }</style></head><body>
  <h1>${title} — <span class="badge">${badge}</span></h1>
  ${body}
  <div class="buttons"><button class="primary" onclick="postResult('ok')">Close</button></div>
  <script>${CLOSE_SCRIPT}</script>
</body></html>`);
}

/**
 * The "Send clip to Wwise" form, pre-filled from config + the clicked clip.
 * On submit it posts a JSON string with host/port/parentPath/objectName/
 * importOperation/importLanguage; cancel posts "".
 */
export function transferFormUrl(config: WaapiConfig, clipName: string, filePath: string): string {
  // Embed values as JSON so backslashes in paths survive intact.
  const cfgJson = JSON.stringify(config);
  const clipJson = JSON.stringify({ name: clipName, filePath });
  return toDataUrl(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_STYLE}</style></head><body>
  <h1>Send clip to Wwise</h1>
  <p>Source: <code id="file"></code></p>
  <div class="row">
    <div><label for="host">WAAPI host</label><input id="host"></div>
    <div style="flex:0 0 90px"><label for="port">Port</label><input id="port" type="number"></div>
  </div>
  <label for="parentPath">Wwise parent path</label><input id="parentPath">
  <label for="objectName">Object name</label><input id="objectName">
  <label for="importOperation">If it already exists</label>
  <select id="importOperation">
    <option value="useExisting">Use existing (skip import)</option>
    <option value="replaceExisting">Replace existing audio</option>
    <option value="createNew">Create new (auto-rename)</option>
  </select>
  <div class="buttons">
    <button onclick="postResult('')">Cancel</button>
    <button class="primary" onclick="submitForm()">Transfer</button>
  </div>
  <script>
    ${CLOSE_SCRIPT}
    const cfg = ${cfgJson};
    const clip = ${clipJson};
    const $ = (id) => document.getElementById(id);
    $("file").textContent = clip.filePath || "(no file)";
    $("host").value = cfg.host;
    $("port").value = cfg.port;
    $("parentPath").value = cfg.parentPath;
    $("objectName").value = clip.name;
    $("importOperation").value = cfg.importOperation;
    function submitForm(){
      postResult(JSON.stringify({
        host: $("host").value.trim(),
        port: Number($("port").value),
        parentPath: $("parentPath").value.trim(),
        objectName: $("objectName").value.trim(),
        importOperation: $("importOperation").value,
        importLanguage: cfg.importLanguage,
      }));
    }
  </script>
</body></html>`);
}

export interface BatchFormDefaults {
  destination: string;
  importOperation: string;
  rename: BatchRenameSettings;
}

/**
 * The batch "Send N clips to Wwise" form. Shows a destination combobox
 * (`<datalist>` of Wwise paths), rename controls (base + prefix/suffix), and a
 * live `old → new` preview. The naming logic is mirrored here in-browser so the
 * preview updates without round-tripping to the host. Preview indices start at
 * 0; the real resuming offset is applied at commit. Submit posts
 * `{ destination, importOperation, rename }`; cancel posts "".
 */
export function batchFormUrl(
  originals: string[],
  destinations: string[],
  defaults: BatchFormDefaults,
  childrenByDest: Record<string, string[]> = {},
  offline = false,
): string {
  const data = JSON.stringify({ originals, destinations, defaults, childrenByDest, offline });
  const extra = `
    fieldset { border: 1px solid #ddd; border-radius: 6px; margin: 10px 0; padding: 8px 10px; }
    legend { font-weight: 600; font-size: 12px; padding: 0 4px; }
    .affix { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .affix input[type=number] { width: 56px; flex: 0 0 auto; }
    .affix .nm { flex: 1; }
    .affix.off { opacity: .5; }
    .warn { color: #c62828; font-size: 12px; min-height: 16px; margin: 4px 0; }
    #preview { list-style: none; padding: 0; margin: 6px 0 0; max-height: 160px; overflow: auto;
               border: 1px solid #eee; border-radius: 4px; }
    #preview li { padding: 2px 8px; font-family: ui-monospace, monospace; font-size: 12px;
                  white-space: nowrap; }
    #preview li:nth-child(odd) { background: #fafafa; }
    .arrow { opacity: .5; }`;
  return toDataUrl(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_STYLE}${extra}</style></head><body>
  <h1 id="title"></h1>
  <div id="offline" style="display:none;color:#ef6c00;font-size:12px;margin:0 0 8px">
    ⚠ Wwise unreachable — showing cached destinations. Transfer will fail until it's reachable.
  </div>

  <label for="dest">Wwise destination</label>
  <input id="dest" list="dests" ${NO_AUTOCORRECT} placeholder="\\Actor-Mixer Hierarchy\\Default Work Unit">
  <datalist id="dests"></datalist>

  <label for="op">If it already exists</label>
  <select id="op">
    <option value="useExisting">Use existing (skip import)</option>
    <option value="replaceExisting">Replace existing audio</option>
    <option value="createNew">Create new (auto-rename)</option>
  </select>

  <fieldset>
    <legend>Rename</legend>
    <div class="affix">
      <label style="margin:0;flex:0 0 auto" for="baseMode">Base</label>
      <select id="baseMode" style="flex:0 0 auto; width:auto"><option value="original">Original name</option><option value="literal">Literal</option></select>
      <input id="baseLiteral" class="nm" ${NO_AUTOCORRECT} placeholder="literal base applied to all">
    </div>
    <div class="affix" id="prefixRow">
      <label style="margin:0;flex:0 0 auto"><input type="checkbox" id="prefixOn"> Prefix</label>
      <input type="number" id="prefixDigits" min="1" max="8" title="digit count (zero-pad)">
      <input id="prefixName" class="nm" ${NO_AUTOCORRECT} placeholder="name (optional, no spaces)">
    </div>
    <div class="affix" id="suffixRow">
      <label style="margin:0;flex:0 0 auto"><input type="checkbox" id="suffixOn"> Suffix</label>
      <input type="number" id="suffixDigits" min="1" max="8" title="digit count (zero-pad)">
      <input id="suffixName" class="nm" ${NO_AUTOCORRECT} placeholder="name (optional, no spaces)">
    </div>
    <div class="warn" id="warn"></div>
    <div style="font-size:12px;opacity:.7">Preview (numbering resumes after existing objects):</div>
    <ul id="preview"></ul>
  </fieldset>

  <div class="buttons">
    <button onclick="postResult('')">Cancel</button>
    <button class="primary" id="go" onclick="submitForm()">Transfer</button>
  </div>
  <script>
    ${CLOSE_SCRIPT}
    const D = ${data};
    const $ = (id) => document.getElementById(id);

    $("title").textContent = "Send " + D.originals.length + " clip" + (D.originals.length===1?"":"s") + " to Wwise";
    if (D.offline) $("offline").style.display = "block";
    $("dests").innerHTML = D.destinations.map(p => "<option></option>").join("");
    D.destinations.forEach((p, i) => { $("dests").children[i].value = p; });
    $("dest").value = D.defaults.destination || "";
    $("op").value = D.defaults.importOperation || "useExisting";
    const r = D.defaults.rename;
    $("baseMode").value = r.base.mode;
    $("baseLiteral").value = r.base.value || "";
    $("prefixOn").checked = r.prefix.enabled; $("prefixDigits").value = r.prefix.digits; $("prefixName").value = r.prefix.name || "";
    $("suffixOn").checked = r.suffix.enabled; $("suffixDigits").value = r.suffix.digits; $("suffixName").value = r.suffix.name || "";

    function pad(i, d){ const s = String(Math.max(0, Math.trunc(i))); return s.length >= d ? s : "0".repeat(d - s.length) + s; }
    function strip(s){ return (s||"").replace(/\\s+/g, ""); }
    function readSettings(){
      return {
        base: { mode: $("baseMode").value, value: $("baseLiteral").value.trim() },
        prefix: { enabled: $("prefixOn").checked, digits: Math.max(1, Number($("prefixDigits").value)||1), name: strip($("prefixName").value) },
        suffix: { enabled: $("suffixOn").checked, digits: Math.max(1, Number($("suffixDigits").value)||1), name: strip($("suffixName").value) },
      };
    }
    function computeName(original, index, s){
      const base = s.base.mode === "literal" ? s.base.value : original;
      const parts = [];
      if (s.prefix.enabled) parts.push(pad(index, s.prefix.digits) + s.prefix.name);
      parts.push(base);
      if (s.suffix.enabled) parts.push(s.suffix.name + pad(index, s.suffix.digits));
      return parts.filter(p => p.length > 0).join("_");
    }
    // Mirror of resumeIndex(): resume after the highest existing matching index
    // among the selected destination's children.
    function escapeRe(x){ return x.replace(/[^A-Za-z0-9_]/g, function(c){ return "\\\\" + c; }); }
    function resumeStart(s, names){
      let re = null;
      if (s.suffix.enabled) re = new RegExp("_" + escapeRe(s.suffix.name) + "(\\\\d+)$");
      else if (s.prefix.enabled) re = new RegExp("^(\\\\d+)" + escapeRe(s.prefix.name) + "_");
      if (!re) return 0;
      let max = -1;
      names.forEach(function(n){ const m = re.exec(n); if (m) { const v = parseInt(m[1], 10); if (v > max) max = v; } });
      return max + 1;
    }
    function update(){
      const s = readSettings();
      const isLiteral = s.base.mode === "literal";
      $("baseLiteral").disabled = !isLiteral;
      $("baseLiteral").style.opacity = isLiteral ? "" : ".5";
      $("prefixDigits").disabled = $("prefixName").disabled = !s.prefix.enabled;
      $("suffixDigits").disabled = $("suffixName").disabled = !s.suffix.enabled;
      $("prefixRow").classList.toggle("off", !s.prefix.enabled);
      $("suffixRow").classList.toggle("off", !s.suffix.enabled);

      const names = D.childrenByDest[$("dest").value.trim()] || [];
      const start = resumeStart(s, names);
      const ul = $("preview"); ul.innerHTML = "";
      D.originals.forEach((o, i) => {
        const li = document.createElement("li");
        const oldS = document.createElement("span"); oldS.textContent = o;
        const arr = document.createElement("span"); arr.className = "arrow"; arr.textContent = "  →  ";
        const neu = document.createElement("span"); neu.textContent = computeName(o, start + i, s);
        li.append(oldS, arr, neu); ul.appendChild(li);
      });

      const multiNoAffix = D.originals.length > 1 && !s.prefix.enabled && !s.suffix.enabled;
      const noDest = $("dest").value.trim().length === 0;
      $("warn").textContent = multiNoAffix
        ? "Enable a prefix or suffix so each file gets a unique index."
        : (noDest ? "Choose a Wwise destination." : "");
      $("go").disabled = multiNoAffix || noDest;
    }
    function submitForm(){
      postResult(JSON.stringify({
        destination: $("dest").value.trim(),
        importOperation: $("op").value,
        rename: readSettings(),
      }));
    }
    document.querySelectorAll("input, select").forEach(el => {
      el.addEventListener("input", update); el.addEventListener("change", update);
    });
    update();
  </script>
</body></html>`);
}

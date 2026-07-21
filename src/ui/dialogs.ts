/**
 * HTML builders for the extension's modal dialogs, returned as `data:` URLs for
 * `ui.showModalDialog`. A dialog returns a value by posting
 * `{ method: "close_and_send", params: [string] }` to the host; the empty
 * string denotes cancel.
 */

import type { ContainerSettings } from "../config.js";
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

export interface BatchFormDefaults {
  destination: string;
  importOperation: string;
  rename: BatchRenameSettings;
  container: ContainerSettings;
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
    .arrow { opacity: .5; }
    .combo { position: relative; }
    .combo > input { padding-right: 26px; }
    .combo-btn { position: absolute; right: 1px; top: 1px; bottom: 1px; width: 24px; padding: 0;
                 border: none; background: transparent; cursor: pointer; font-size: 12px; }
    .combo-menu { position: absolute; left: 0; right: 0; top: 100%; z-index: 20; margin: 2px 0 0;
                  padding: 0; list-style: none; max-height: 180px; overflow: auto; background: #fff;
                  border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.15); display: none; }
    .combo-menu.open { display: block; }
    .combo-menu li { padding: 5px 8px; font-size: 12px; cursor: pointer; white-space: nowrap;
                     overflow: hidden; text-overflow: ellipsis; }
    .combo-menu li:hover { background: #e8eefc; }
    .combo-menu li.empty { color: #999; cursor: default; }`;
  return toDataUrl(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_STYLE}${extra}</style></head><body>
  <h1 id="title"></h1>
  <div id="offline" style="display:none;color:#ef6c00;font-size:12px;margin:0 0 8px">
    ⚠ Wwise unreachable — showing cached destinations. Transfer will fail until it's reachable.
  </div>

  <label for="dest">Wwise destination</label>
  <div class="combo">
    <input id="dest" ${NO_AUTOCORRECT} placeholder="\\Actor-Mixer Hierarchy\\Default Work Unit">
    <button type="button" id="destToggle" class="combo-btn" tabindex="-1">▾</button>
    <ul id="destMenu" class="combo-menu"></ul>
  </div>

  <label for="op">If it already exists</label>
  <select id="op">
    <option value="useExisting">Use existing (skip import)</option>
    <option value="replaceExisting">Replace existing audio</option>
    <option value="createNew">Create new (auto-rename)</option>
  </select>

  <fieldset>
    <legend>Container</legend>
    <div class="affix">
      <label style="margin:0;flex:0 0 auto" for="containerType">Wrap in</label>
      <select id="containerType" style="flex:0 0 auto; width:auto">
        <option value="none">No container (loose sounds)</option>
        <option value="random">Random Container</option>
        <option value="sequence">Sequence Container</option>
        <option value="switch">Switch Container</option>
        <option value="blend">Blend Container</option>
      </select>
      <input id="containerName" class="nm" ${NO_AUTOCORRECT} placeholder="container name">
    </div>
    <div style="font-size:12px;opacity:.7;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="containerHint"></div>
  </fieldset>

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
    $("dest").value = D.defaults.destination || "";
    setupCombo();
    $("op").value = D.defaults.importOperation || "useExisting";
    const c = D.defaults.container || { type: "none", name: "" };
    $("containerType").value = c.type;
    $("containerName").value = c.name || "";
    const r = D.defaults.rename;
    $("baseMode").value = r.base.mode;
    $("baseLiteral").value = r.base.value || "";
    $("prefixOn").checked = r.prefix.enabled; $("prefixDigits").value = r.prefix.digits; $("prefixName").value = r.prefix.name || "";
    $("suffixOn").checked = r.suffix.enabled; $("suffixDigits").value = r.suffix.digits; $("suffixName").value = r.suffix.name || "";

    const CTAG = { random:"Random Container", sequence:"Sequence Container", switch:"Switch Container", blend:"Blend Container" };
    function readContainer(){ return { type: $("containerType").value, name: $("containerName").value.trim() }; }
    // Where sounds actually land — a container inserts one path segment, so
    // resume-index lookups and the collision check target the container, not
    // the destination (a fresh container has no children → numbering from 0).
    function effectiveParent(dest, cont){ return (cont.type !== "none" && cont.name) ? (dest + "\\\\" + cont.name) : dest; }
    function updateContainer(){
      const cont = readContainer();
      const off = cont.type === "none";
      $("containerName").disabled = off;
      $("containerName").style.opacity = off ? ".5" : "";
      if (off) { $("containerHint").textContent = ""; return; }
      const dest = $("dest").value.trim();
      $("containerHint").textContent = cont.name
        ? "→ " + dest + "\\\\<" + CTAG[cont.type] + ">" + cont.name + "\\\\<Sound SFX>…"
        : "Enter a container name.";
    }
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
      updateContainer();

      const cont = readContainer();
      const names = D.childrenByDest[effectiveParent($("dest").value.trim(), cont)] || [];
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
      const noContainerName = cont.type !== "none" && !cont.name;
      $("warn").textContent = multiNoAffix
        ? "Enable a prefix or suffix so each file gets a unique index."
        : (noDest ? "Choose a Wwise destination."
        : (noContainerName ? "Enter a container name." : ""));
      $("go").disabled = multiNoAffix || noDest || noContainerName;
    }
    function submitForm(){
      postResult(JSON.stringify({
        destination: $("dest").value.trim(),
        importOperation: $("op").value,
        rename: readSettings(),
        container: readContainer(),
      }));
    }
    // Custom destination dropdown — <datalist> doesn't reliably open in WKWebView.
    function setupCombo(){
      const destEl = $("dest"), menu = $("destMenu");
      function render(){
        const q = destEl.value.trim().toLowerCase();
        const matches = D.destinations.filter(function(p){ return p.toLowerCase().indexOf(q) !== -1; });
        menu.innerHTML = "";
        if (!matches.length){
          const li = document.createElement("li"); li.className = "empty";
          li.textContent = D.destinations.length ? "No match — type a custom path" : "No destinations — type a path";
          menu.appendChild(li); return;
        }
        matches.forEach(function(p){
          const li = document.createElement("li"); li.textContent = p;
          // mousedown (not click) so it fires before the input's blur closes the menu.
          li.addEventListener("mousedown", function(e){ e.preventDefault(); destEl.value = p; close(); update(); });
          menu.appendChild(li);
        });
      }
      function open(){ render(); menu.classList.add("open"); }
      function close(){ menu.classList.remove("open"); }
      $("destToggle").addEventListener("mousedown", function(e){
        e.preventDefault();
        menu.classList.contains("open") ? close() : (destEl.focus(), open());
      });
      destEl.addEventListener("focus", open);
      destEl.addEventListener("input", open);
      destEl.addEventListener("blur", function(){ setTimeout(close, 150); });
      document.addEventListener("keydown", function(e){ if (e.key === "Escape") close(); });
    }
    document.querySelectorAll("input, select").forEach(el => {
      el.addEventListener("input", update); el.addEventListener("change", update);
    });
    update();
  </script>
</body></html>`);
}

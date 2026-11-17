// Preferences window. Changes save automatically (macOS convention).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PROVIDER_NAMES = { anthropic: "Anthropic", copilot: "GitHub Copilot", chatgpt: "ChatGPT", openrouter: "OpenRouter", ollama: "Ollama" }; // Paw Agent's built-in providers
// Deprecated: CLI agents (CLI_AGENTS). Off: Settings › Agents lists providers and their models only.
const CLI_AGENTS = false;

let settings = null;
let detections = {};
// What Settings › Agents shows: { kind: "provider", id }, { kind: "model", id: "provider/model" }
// or, with CLI agents, { kind: "agent", id }.
let sel = null;

const GRADIENTS = [
  ["#d97757", "#b4532a"], ["#10a37f", "#0b7a5f"], ["#4f8cff", "#7a5cff"], ["#ff9f0a", "#ff6a00"],
  ["#30d1c8", "#0a84ff"], ["#bf5af2", "#7a5cff"], ["#ff375f", "#bf2b4a"], ["#64d2ff", "#0a84ff"],
];
function avatarStyle(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = GRADIENTS[h % GRADIENTS.length];
  return `background: linear-gradient(145deg, ${a}, ${b})`;
}
function initials(name) {
  return (name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

// ---------- tabs ----------
function selectTab(tab) {
  document.querySelectorAll("#ptabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + tab));
  try { localStorage.setItem("paw.prefsTab", tab); } catch {}
}
window.selectTab = selectTab;
document.querySelectorAll("#ptabs button").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

// ---------- saving ----------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => invoke("save_settings", { settings }).catch((e) => console.error(e)), 250);
}
/** Saves now: for commands that read the saved settings (scans, keys of custom providers). */
function saveNow() {
  clearTimeout(saveTimer);
  return invoke("save_settings", { settings });
}
/** The selected CLI agent; none when a provider or model is selected. */
const current = () => sel?.kind === "agent" ? settings?.agents.find((a) => a.id === sel.id) : undefined;
// Deprecated: CLI agents (CLI_AGENTS). Their controls stay in the page, hidden.
if (!CLI_AGENTS) document.querySelectorAll(".cli-only").forEach((el) => el.classList.add("hidden"));

// ---------- general ----------
function renderGeneral() {
  $("g-cwd").value = settings.general.default_cwd;
  // Deprecated: CLI agents (CLI_AGENTS).
  if (CLI_AGENTS) $("g-only-installed").checked = settings.general.only_installed;
  $("g-history").value = settings.general.history_size ?? 1000;
  $("g-max-sessions").value = settings.general.max_sessions ?? 50;
  $("g-max-agents").value = settings.general.max_agents ?? 3;
  showSessionCount();
  $("g-mode").value = settings.general.input_mode || "auto";
  $("g-approval").value = settings.general.approval || "edits";
  $("g-share-shell").checked = settings.general.share_shell !== false;
  showHistoryCount();
  // Deprecated: CLI agents (CLI_AGENTS). Without them new tabs open the default model.
  if (CLI_AGENTS) {
    const pick = $("g-agent");
    pick.innerHTML = "";
    for (const a of sortedAgents().filter((a) => a.enabled)) {
      const d = detections[a.id];
      pick.appendChild(new Option(a.name + (d && !d.installed ? " (not installed)" : ""), a.id));
    }
    pick.value = settings.general.default_agent ?? "";
    if (!pick.value && pick.options.length) pick.value = pick.options[0].value;
  }
}
// Deprecated: CLI agents (CLI_AGENTS).
if (CLI_AGENTS) $("g-agent").addEventListener("change", (e) => { settings.general.default_agent = e.target.value; save(); });
$("g-mode").addEventListener("change", (e) => { settings.general.input_mode = e.target.value; save(); });
$("g-approval").addEventListener("change", (e) => { settings.general.approval = e.target.value; save(); });
$("g-share-shell").addEventListener("change", (e) => { settings.general.share_shell = e.target.checked; save(); });

// Shell history size
async function showHistoryCount() {
  const n = (await invoke("history_list")).length;
  $("g-history-hint").textContent =
    `${n} command${n === 1 ? "" : "s"} saved. Shared by all tabs and kept between launches. 0 turns it off.`;
}
let trimTimer = null;
$("g-history").addEventListener("input", (e) => {
  const v = Math.max(0, Math.min(100000, Math.floor(Number(e.target.value) || 0)));
  settings.general.history_size = v;
  save();
  // Apply the new limit once the setting is stored.
  clearTimeout(trimTimer);
  trimTimer = setTimeout(async () => { await invoke("history_trim"); showHistoryCount(); }, 500);
});
$("g-history-clear").onclick = async () => {
  if (!confirm("Clear the shell history for all tabs? This can't be undone.")) return;
  await invoke("history_clear");
  showHistoryCount();
};
// Closed sessions kept in ~/.paw/session
async function showSessionCount() {
  try {
    const list = await invoke("list_sessions");
    const ws = await invoke("load_workspace").catch(() => null);
    const open = new Set((ws?.tabs ?? []).map((t) => t.id).filter(Boolean));
    const closed = list.filter((x) => !open.has(x.id));
    const mb = closed.reduce((n, x) => n + x.size, 0) / 1048576;
    $("g-sessions-hint").textContent = `${closed.length} closed session${closed.length === 1 ? "" : "s"} kept (${mb < 0.1 ? "<0.1" : mb.toFixed(1)} MB). ` +
      "A tab's folder (~/.paw/session) stays after you close it, so /sessions can reopen it. Beyond this number the oldest go first. 0 keeps all.";
  } catch { /* keep the plain hint */ }
}
$("g-max-agents").addEventListener("input", (e) => {
  settings.general.max_agents = Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0)));
  save();
});
let sessionsTimer = null;
$("g-max-sessions").addEventListener("input", (e) => {
  settings.general.max_sessions = Math.max(0, Math.min(10000, Math.floor(Number(e.target.value) || 0)));
  save();
  // The main window applies the limit once the setting is stored.
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(showSessionCount, 900);
});
$("g-cwd").addEventListener("input", (e) => { settings.general.default_cwd = e.target.value; save(); });
// Deprecated: CLI agents (CLI_AGENTS).
if (CLI_AGENTS) $("g-only-installed").addEventListener("change", (e) => { settings.general.only_installed = e.target.checked; save(); });

// ---------- providers and models ----------
// Settings from older versions may lack `providers` and `models`; these create them before a write.
function providerConfig(p) {
  settings.providers ??= {};
  const c = (settings.providers[p] ??= { base_url: "", key_source: "", custom_models: [] });
  c.custom_models ??= [];
  return c;
}
function modelPrefs() {
  settings.models ??= { default: null, hidden: [] };
  settings.models.hidden ??= [];
  return settings.models;
}
/** A custom (OpenAI-compatible) provider's settings entry, if `p` is one. */
const customEntry = (p) => (settings?.providers?.custom ?? []).find((c) => c.id === p);
/** The model ids the user added to provider `p` (its custom entry's for a custom provider). */
function customModels(p) {
  const c = customEntry(p);
  return c ? (c.custom_models ??= []) : providerConfig(p).custom_models;
}
/** The Paw Agent scan's providers (minus custom ones removed since); null until it has arrived. */
const providerViews = () => detections.paw?.providers?.filter((v) => !v.removable || customEntry(v.id)) ?? null;
const providerView = (p) => providerViews()?.find((v) => v.id === p);
const providerName = (p) => customEntry(p)?.name || providerView(p)?.name || PROVIDER_NAMES[p] || p;
/** "anthropic", "copilot", "chatgpt", "openrouter", "ollama" or "compatible": what the detail shows. */
const providerKind = (p) => providerView(p)?.kind || (customEntry(p) ? "compatible" : p);
// A model id is "provider/model"; only the first segment is the provider.
const providerOf = (id) => id.slice(0, id.indexOf("/"));
const shortName = (id) => id.slice(id.indexOf("/") + 1);
const isHidden = (id) => modelPrefs().hidden.includes(id);
const isDefault = (id) => modelPrefs().default === id;
/** A provider's plain model ids: what the scan found, then custom ids added since. */
function providerModels(p) {
  const list = [...(providerView(p)?.models ?? [])];
  for (const m of customModels(p)) if (!list.includes(m)) list.push(m);
  return list;
}
const isListed = (id) => id.includes("/") && !!providerView(providerOf(id)) && providerModels(providerOf(id)).includes(shortName(id));
/** A new custom provider's id: its name as a slug, unique, never a built-in id. */
function newProviderId(name) {
  const fit = (s, max) => s.slice(0, max).replace(/-+$/, "");
  const base = fit(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, ""), 32) || "provider";
  // "custom" is where settings keep these providers.
  const taken = new Set([...Object.keys(PROVIDER_NAMES), "custom", ...(settings.providers?.custom ?? []).map((c) => c.id),
    ...(detections.paw?.providers ?? []).map((v) => v.id)]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${fit(base, 32 - String(n).length - 1)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

function defaultSelection() {
  const def = modelPrefs().default;
  if (def && isListed(def)) return { kind: "model", id: def };
  const first = providerViews()?.[0];
  if (first) return { kind: "provider", id: first.id };
  // Deprecated: CLI agents (CLI_AGENTS).
  if (CLI_AGENTS && cliAgents().length) return { kind: "agent", id: cliAgents()[0].id };
  return null;
}
function selectionExists() {
  if (sel?.kind === "provider") return !!providerView(sel.id) || !!customEntry(sel.id);
  if (sel?.kind === "model") return isListed(sel.id);
  if (sel?.kind === "new-provider") return true;
  return !!current();
}
function select(kind, id) {
  sel = { kind, id };
  renderList();
  renderDetail();
}

// ---------- agent list ----------
// Deprecated: CLI agents (CLI_AGENTS). Also orders the Default agent menu.
function sortedAgents() {
  // Paw Agent first; then the CLI agents, installed first, then alphabetical.
  return [...settings.agents].sort((a, b) => {
    const pa = a.io === "paw" ? 0 : 1;
    const pb = b.io === "paw" ? 0 : 1;
    const ia = detections[a.id]?.installed ? 0 : 1;
    const ib = detections[b.id]?.installed ? 0 : 1;
    return pa - pb || ia - ib || a.name.localeCompare(b.name);
  });
}
// Deprecated: CLI agents (CLI_AGENTS). Paw Agent is listed as its providers.
const cliAgents = () => sortedAgents().filter((a) => a.io !== "paw");

// Deprecated: CLI agents (CLI_AGENTS).
function statusText(a) {
  const d = detections[a.id];
  if (!d) return "Checking…";
  if (!d.installed) return "Not installed";
  return d.version ? d.version.slice(0, 40) : "Installed";
}

/** Each provider, with its models below it. */
function renderList() {
  const ul = $("alist");
  ul.innerHTML = "";
  const row = (className, html, onclick) => {
    const li = document.createElement("li");
    li.className = className;
    li.innerHTML = html;
    if (onclick) li.onclick = onclick;
    ul.appendChild(li);
    return li;
  };
  const views = providerViews();
  if (!views) row("alist-note", "Looking for models…");
  for (const v of views ?? []) {
    const on = sel?.kind === "provider" && sel.id === v.id;
    row(`alist-prov${on ? " active" : ""}`,
      `<span class="pdot${v.connected ? " ok" : ""}" title="${v.connected ? "Connected" : "Not connected"}"></span>` +
      `<div class="meta"><div class="nm">${esc(providerName(v.id))}</div></div>`,
      () => select("provider", v.id)).title = v.status;
    for (const m of providerModels(v.id)) {
      const id = `${v.id}/${m}`;
      const active = sel?.kind === "model" && sel.id === id;
      row(`alist-model${active ? " active" : ""}${isHidden(id) ? " dimmed" : ""}`,
        `<div class="meta"><div class="nm" title="${esc(m)}">${esc(m)}</div></div>${isDefault(id) ? `<span class="tag">Default</span>` : ""}`,
        () => select("model", id));
    }
  }
  // Deprecated: CLI agents (CLI_AGENTS).
  if (CLI_AGENTS) renderCliList(ul);
}

// Deprecated: CLI agents (CLI_AGENTS).
function renderCliList(ul) {
  const agents = cliAgents();
  // A faint line between Paw Agent's models and the CLI agents.
  if (agents.length && ul.children.length) ul.appendChild(Object.assign(document.createElement("li"), { className: "alist-sep", role: "separator" }));
  for (const a of agents) {
    const d = detections[a.id];
    const li = document.createElement("li");
    li.className = (sel?.kind === "agent" && a.id === sel.id ? "active " : "") + (a.enabled && d?.installed !== false ? "" : "disabled");
    li.innerHTML = `
      <div class="avatar ${d && !d.installed ? "off" : ""}" style="${avatarStyle(a.id)}">${esc(initials(a.name))}</div>
      <div class="meta"><div class="nm">${esc(a.name)}</div><div class="sub">${esc(statusText(a))}</div></div>`;
    li.onclick = () => select("agent", a.id);
    ul.appendChild(li);
  }
  $("a-del").disabled = !current() || current().builtin;
}

// ---------- detail ----------
function renderDetail() {
  $("adetail").classList.toggle("hidden", !sel);
  if (!sel) return;
  const kind = sel.kind;
  $("d-paw").classList.toggle("hidden", kind !== "provider");
  $("d-model").classList.toggle("hidden", kind !== "model");
  $("d-newprov").classList.toggle("hidden", kind !== "new-provider");
  $("d-models-group").classList.toggle("hidden", kind === "model" || kind === "new-provider");
  for (const id of ["d-command", "d-footer", "d-enabled-wrap"]) $(id).classList.toggle("hidden", kind !== "agent");
  if (kind === "provider") renderProvider(sel.id);
  else if (kind === "model") renderModel(sel.id);
  else if (kind === "new-provider") renderNewProvider();
  else if (CLI_AGENTS) renderAgent(current()); // Deprecated: CLI agents (CLI_AGENTS).
  // Allow rules apply to every model.
  if (kind === "new-provider") document.querySelectorAll(".d-allowed-only").forEach((el) => el.classList.add("hidden"));
  else renderAllowed(kind === "agent" ? sel.id : "paw");
}

/** The detail's avatar and title, for a provider or a model. */
function renderHead(provider, title) {
  const name = providerName(provider);
  $("d-avatar").className = "avatar" + (providerView(provider)?.connected ? "" : " off");
  $("d-avatar").setAttribute("style", avatarStyle(provider));
  $("d-avatar").textContent = initials(name);
  $("d-name").value = title;
  $("d-name").readOnly = true;
}

function renderProvider(p) {
  const v = providerView(p);
  renderHead(p, providerName(p));
  $("d-status").innerHTML = `<span class="${v?.connected ? "ok" : "missing"}">●</span><span>${esc(v?.status ?? "Checking…")}</span>`;
  renderConnection(p);

  $("d-msrc").textContent = v?.connected ? "" : "In the menus once it's connected";
  const ul = $("d-models");
  ul.innerHTML = "";
  const custom = customModels(p);
  for (const m of providerModels(p)) {
    const id = `${p}/${m}`;
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="lbl">${esc(m)}</span>
      ${isDefault(id) ? `<span class="tag">Default</span>` : ""}
      ${isHidden(id) ? `<span class="tag">Hidden</span>` : ""}
      ${custom.includes(m) ? `<button class="rm" title="Remove">×</button>` : ""}`;
    li.onclick = (e) => { if (!e.target.classList.contains("rm")) select("model", id); };
    const rm = li.querySelector(".rm");
    if (rm) rm.onclick = () => {
      const list = customModels(p);
      list.splice(list.indexOf(m), 1);
      save();
      renderList();
      renderDetail();
      rescan();
    };
    ul.appendChild(li);
  }
  if (!ul.children.length) {
    const none = v?.available?.length ? "None yet: add the ones you want below." : "No models found yet.";
    ul.innerHTML = `<li><span class="lbl plain">${none}</span></li>`;
  }
  renderAvailable(p);
}

// A large catalogue (OpenRouter's…) isn't listed whole: the user searches it and adds models.
const AVAILABLE_ROWS = 200;
let availableFor = null; // the provider the search box was typed for
function renderAvailable(p) {
  const all = providerView(p)?.available ?? [];
  $("d-avail").classList.toggle("hidden", !all.length);
  if (availableFor !== p) { availableFor = p; $("d-msearch").value = ""; }
  if (!all.length) return;
  $("d-msearch").placeholder = `Search ${all.length} models…`;
  const q = $("d-msearch").value.trim().toLowerCase();
  const hits = q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
  const added = new Set(customModels(p));
  const ul = $("d-mavail");
  const top = ul.scrollTop;
  ul.innerHTML = hits.slice(0, AVAILABLE_ROWS).map((m) => {
    const on = added.has(m);
    return `<li><span class="lbl" title="${esc(m)}">${esc(m)}</span>` +
      `<button class="btn-ghost small${on ? " added" : ""}" type="button" data-model="${esc(m)}">${on ? "Added" : "Add"}</button></li>`;
  }).join("") || `<li><span class="lbl plain">No model matches.</span></li>`;
  ul.scrollTop = top;
  $("d-mavail-note").textContent = hits.length > AVAILABLE_ROWS ? `Showing ${AVAILABLE_ROWS} of ${hits.length}: narrow the search.` : "";
}
$("d-msearch").addEventListener("input", () => { if (sel?.kind === "provider") renderAvailable(sel.id); });
$("d-mavail").addEventListener("click", (e) => {
  const m = e.target.closest("button[data-model]")?.dataset.model;
  if (m == null || sel?.kind !== "provider") return;
  const list = customModels(sel.id);
  const i = list.indexOf(m);
  if (i >= 0) list.splice(i, 1); else list.push(m);
  save();
  renderList();
  renderDetail();
  rescan();
});

/** The detail's head while adding a provider. */
function renderNewProvider() {
  $("d-avatar").className = "avatar off";
  $("d-avatar").setAttribute("style", avatarStyle("new-provider"));
  $("d-avatar").textContent = "+";
  $("d-name").value = "New Provider";
  $("d-name").readOnly = true;
  $("d-status").innerHTML = `<span>Any service with an OpenAI-compatible API</span>`;
}
$("a-addprov").onclick = () => {
  $("d-np-form").reset();
  $("d-np-status").textContent = "";
  select("new-provider", "");
  $("d-np-name").focus();
};
$("d-np-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("d-np-name").value.trim();
  const base_url = $("d-np-baseurl").value.trim();
  const key = $("d-np-apikey").value.trim();
  if (!name || !base_url) { $("d-np-status").textContent = "It needs a name and a base URL."; return; }
  const id = newProviderId(name);
  settings.providers ??= {};
  (settings.providers.custom ??= []).push({ id, name, base_url, custom_models: [] });
  try {
    // The key command only takes providers in the saved settings.
    await saveNow();
    if (key) await invoke("paw_key_set", { provider: id, key });
  } catch (err) { alert(`Couldn't save the key: ${err}`); }
  await refreshKeyStatus();
  select("provider", id);
  rescan();
});

function renderModel(id) {
  const p = providerOf(id);
  const connected = !!providerView(p)?.connected;
  renderHead(p, shortName(id));
  $("d-status").innerHTML = `<span>${esc(providerName(p))}</span>${connected ? "" : `<span class="missing">· not connected</span>`}`;
  const hidden = isHidden(id);
  const def = isDefault(id);
  $("d-m-shown").checked = !hidden;
  $("d-m-default").textContent = def ? "Default model for new sessions" : "Use for new sessions";
  $("d-m-default").disabled = def;
  $("d-m-default-hint").textContent = !def ? ""
    : hidden ? "It's hidden from the menus, so new sessions start with the first model there."
    : !connected ? "Its provider isn't connected, so new sessions start with the first model in the menus."
    : "";
}
$("d-m-shown").addEventListener("change", (e) => {
  if (sel?.kind !== "model") return;
  const mp = modelPrefs();
  mp.hidden = mp.hidden.filter((x) => x !== sel.id);
  if (!e.target.checked) mp.hidden.push(sel.id);
  save();
  renderList();
  renderDetail();
});
$("d-m-default").onclick = () => {
  if (sel?.kind !== "model") return;
  modelPrefs().default = sel.id;
  save();
  renderList();
  renderDetail();
};

// Deprecated: CLI agents (CLI_AGENTS).
// True when {model} appears outside an optional [[ ]] segment.
const needsModel = (a) => a.io === "paw" || /\{model\}/.test(a.template.replace(/\[\[[\s\S]*?\]\]/g, ""));
// Deprecated: CLI agents (CLI_AGENTS).
function allModels(a) {
  const d = detections[a.id];
  const found = d?.models ?? [];
  const list = [...found];
  for (const m of a.custom_models) if (!list.includes(m)) list.push(m);
  if (a.default_model && !list.includes(a.default_model)) list.push(a.default_model);
  return list;
}

// Deprecated: CLI agents (CLI_AGENTS).
function renderAgent(a) {
  if (!a) return;
  const d = detections[a.id];

  $("d-avatar").className = "avatar" + (d && !d.installed ? " off" : "");
  $("d-avatar").setAttribute("style", avatarStyle(a.id));
  $("d-avatar").textContent = initials(a.name);
  $("d-name").value = a.name;
  $("d-name").readOnly = a.builtin;
  $("d-enabled").checked = a.enabled;

  if (!d) $("d-status").innerHTML = `<span class="missing">Checking…</span>`;
  else if (!d.installed) $("d-status").innerHTML = `<span class="missing">Not found on your PATH</span> <span>· looked for <code>${esc(a.binary)}</code></span>`;
  else $("d-status").innerHTML = `<span class="ok">● Installed</span>${d.version ? `<span>· ${esc(d.version)}</span>` : ""}<span>· <code>${esc(d.path)}</code></span>`;

  // Models
  $("d-msrc").textContent = d ? (d.installed ? `Source: ${d.models_source}` : "") : "";
  const ul = $("d-models");
  ul.innerHTML = "";
  if (!needsModel(a)) ul.appendChild(modelRow(a, "", "Let the CLI decide", { plain: true }));
  for (const m of allModels(a)) {
    ul.appendChild(modelRow(a, m, m, {
      configured: d?.configured_model === m,
      custom: a.custom_models.includes(m) && !(d?.models ?? []).includes(m),
    }));
  }

  // Command
  $("d-binary").value = a.binary;
  $("d-io").value = a.io;
  $("d-template").value = a.template;
  $("d-continuity").value = a.continuity || "replay";
  $("d-allow").value = a.allow_template || "";
  $("d-skills").value = a.skills_template ?? "";
  $("d-skills-delivery").value = a.skills_delivery || "index";
  for (const l of ["ask", "edits", "auto", "plan", "full"]) $(`d-ap-${l}`).value = a.approvals?.[l] ?? "";
  $("d-pattern").value = a.session_pattern || "";
  document.querySelectorAll(".d-session-only").forEach((el) => el.classList.toggle("hidden", (a.continuity || "replay") !== "session"));
  $("d-reset").textContent = a.builtin ? "Restore Defaults" : "Remove Agent";
  updatePreview();
}

// Deprecated: CLI agents (CLI_AGENTS).
function modelRow(a, value, label, { plain, configured, custom } = {}) {
  const li = document.createElement("li");
  const checked = (a.default_model ?? "") === value;
  li.innerHTML = `
    <input type="radio" name="defmodel" ${checked ? "checked" : ""} />
    <span class="lbl ${plain ? "plain" : ""}">${esc(label)}</span>
    ${checked ? `<span class="tag">Default</span>` : ""}
    ${configured ? `<span class="tag cfg" title="Set in the CLI's own config">CLI config</span>` : ""}
    ${custom ? `<button class="rm" title="Remove">×</button>` : ""}`;
  li.onclick = (e) => {
    if (e.target.classList.contains("rm")) return;
    a.default_model = value || null;
    save();
    renderDetail();
  };
  const rm = li.querySelector(".rm");
  if (rm) rm.onclick = () => {
    a.custom_models = a.custom_models.filter((m) => m !== value);
    if (a.default_model === value) a.default_model = null;
    save();
    renderDetail();
  };
  return li;
}

// Deprecated: CLI agents (CLI_AGENTS).
async function updatePreview() {
  const a = current();
  if (!a) return;
  const el = $("d-preview");
  try {
    const prompt = a.io === "claude-stream-json" ? "" : "Fix the failing tests";
    el.textContent = await invoke("render_command", {
      agent: a, prompt, permission: a.approvals?.[settings.general.approval || "edits"] ?? "",
      model: a.default_model ?? (needsModel(a) ? allModels(a)[0] ?? "" : ""),
    });
    el.classList.remove("err");
  } catch (e) {
    el.textContent = String(e);
    el.classList.add("err");
  }
}

// Deprecated: CLI agents (CLI_AGENTS).
if (CLI_AGENTS) {
  $("d-name").addEventListener("input", (e) => { current().name = e.target.value; save(); renderList(); $("d-avatar").textContent = initials(e.target.value); });
  $("d-enabled").addEventListener("change", (e) => { current().enabled = e.target.checked; save(); renderList(); });
  $("d-binary").addEventListener("input", (e) => { current().binary = e.target.value.trim(); save(); });
  $("d-binary").addEventListener("change", () => rescan());
  $("d-io").addEventListener("change", (e) => { current().io = e.target.value; save(); updatePreview(); });
  $("d-continuity").addEventListener("change", (e) => { current().continuity = e.target.value; save(); renderDetail(); });
  $("d-allow").addEventListener("input", (e) => { current().allow_template = e.target.value; save(); });
  $("d-skills").addEventListener("input", (e) => { current().skills_template = e.target.value; save(); });
  $("d-skills-delivery").addEventListener("change", (e) => { current().skills_delivery = e.target.value; save(); });
}

// ---------- providers: connection ----------
// The API key goes straight to the Keychain; Settings never reads it back.
let keyStatus = null;
let keySources = null; // where an Anthropic key was found (never the key)
let copilotStatus = null; // Paw's Copilot sign-in and Copilot CLI's (never a token)
let claudeStatus = null; // Paw's Claude sign-in (never a token)
let chatgptStatus = null; // Paw's ChatGPT sign-in (never a token)
async function refreshKeyStatus() {
  try { keyStatus = await invoke("paw_key_status"); } catch { keyStatus = {}; }
  try { keySources = await invoke("paw_key_sources"); } catch { keySources = []; }
  try { copilotStatus = await invoke("paw_copilot_status"); } catch { copilotStatus = {}; }
  try { claudeStatus = await invoke("paw_claude_status"); } catch { claudeStatus = {}; }
  try { chatgptStatus = await invoke("paw_chatgpt_status"); } catch { chatgptStatus = {}; }
  if (settings && sel?.kind === "provider") renderConnection(sel.id);
}
/** A provider's sign-in, key and address controls. */
function renderConnection(p) {
  const kind = providerKind(p);
  // Ollama's address is a row of its own; Anthropic's belongs to API keys
  // (the API tab); Copilot's and ChatGPT's come with the account.
  $("d-baseurl").value = providerConfig("ollama").base_url || "";
  $("d-baseurl").placeholder = "http://localhost:11434";
  $("d-baseurl-hint").textContent = "Leave empty for the Ollama on this Mac.";
  $("d-api-baseurl").value = providerConfig("anthropic").base_url || "";
  for (const k of ["anthropic", "copilot", "chatgpt", "openrouter", "compatible"]) {
    document.querySelectorAll(`.d-${k}-only`).forEach((el) => el.classList.toggle("hidden", kind !== k));
  }
  document.querySelectorAll(".d-addr").forEach((el) => el.classList.toggle("hidden", kind !== "ollama"));
  // Only a failed save or removal needs words; the list shows a saved key.
  $("d-keystatus").textContent = "";
  $("d-keydel").disabled = !keyStatus?.anthropic;
  renderKeySources();
  renderCopilot();
  renderClaude();
  renderOpenRouter();
  renderChatGPT();
  if (kind === "compatible") renderCompatible(p);
}
/** "Open it again" links: their page is in data-url. */
function openAgain(e) {
  e.preventDefault();
  if (e.target.dataset.url) invoke("open_url", { url: e.target.dataset.url }).catch(() => {});
}
for (const id of ["d-or-open", "d-gpt-open", "d-gpt-dev-open"]) $(id).onclick = openAgain;
const cancelled = (err) => String(err) === "Sign-in cancelled.";

// ---------- Paw Agent: OpenRouter sign-in (it gives Paw an API key) ----------
let openrouterSigningIn = false;
let openrouterError = "";
let openrouterTab = "signin"; // the Login tab the user picked, while Settings is open
function renderOpenRouter() {
  const hasKey = !!keyStatus?.openrouter;
  $("d-or-status").textContent = openrouterError;
  $("d-or-signin").textContent = hasKey ? "Sign In Again" : "Sign in with OpenRouter";
  $("d-or-signin").disabled = openrouterSigningIn;
  $("d-or-cancel").classList.toggle("hidden", !openrouterSigningIn);
  $("d-or-signout").classList.toggle("hidden", !hasKey || openrouterSigningIn);
  if (!openrouterSigningIn) $("d-or-waiting").classList.add("hidden");
  $("d-or-keystatus").textContent = hasKey ? "A key is saved in your Keychain." : "";
  $("d-or-keydel").disabled = !hasKey;
  showLoginTab($("d-or-tabs"), openrouterTab);
}
listen("openrouter:auth", ({ payload }) => {
  if (!openrouterSigningIn) return;
  $("d-or-open").dataset.url = payload?.url ?? payload;
  $("d-or-waiting").classList.remove("hidden");
});
$("d-or-signin").onclick = async () => {
  openrouterSigningIn = true;
  openrouterError = "";
  renderOpenRouter();
  try {
    await invoke("paw_openrouter_sign_in");
  } catch (err) {
    openrouterError = cancelled(err) ? "" : `Couldn't sign in: ${err}`;
  }
  openrouterSigningIn = false;
  await refreshKeyStatus();
  rescan();
};
$("d-or-cancel").onclick = () => invoke("paw_openrouter_cancel_sign_in").catch(() => {});
$("d-or-signout").onclick = async () => {
  if (!confirm("Sign Paw out of OpenRouter? This removes its key from your Keychain.")) return;
  openrouterError = "";
  try { await invoke("paw_key_delete", { provider: "openrouter" }); } catch (err) { openrouterError = String(err); }
  await refreshKeyStatus();
  rescan();
};
$("d-or-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (tab) showLoginTab($("d-or-tabs"), (openrouterTab = tab));
});

// ---------- Paw Agent: ChatGPT sign-in ----------
let chatgptSigningIn = false;
let chatgptError = "";
function renderChatGPT() {
  const st = chatgptStatus;
  const text = chatgptError || (st?.signed_in && !chatgptSigningIn ? `Signed in${st.login ? ` as ${st.login}` : ""}.` : "");
  $("d-gpt-status").textContent = text;
  $("d-gpt-status").classList.toggle("hidden", !text);
  $("d-gpt-signin").textContent = st?.signed_in ? "Sign In Again" : "Sign in with ChatGPT";
  $("d-gpt-signin").disabled = chatgptSigningIn;
  $("d-gpt-cancel").classList.toggle("hidden", !chatgptSigningIn);
  $("d-gpt-signout").classList.toggle("hidden", !st?.signed_in || chatgptSigningIn);
  if (!chatgptSigningIn) {
    $("d-gpt-waiting").classList.add("hidden");
    $("d-gpt-device").classList.add("hidden");
  }
}
listen("chatgpt:auth", ({ payload }) => {
  if (!chatgptSigningIn) return;
  $("d-gpt-open").dataset.url = payload?.url ?? payload;
  $("d-gpt-waiting").classList.remove("hidden");
});
// Without a browser sign-in, a code to enter on OpenAI's page.
listen("chatgpt:device", ({ payload }) => {
  if (!chatgptSigningIn) return;
  $("d-gpt-waiting").classList.add("hidden");
  $("d-gpt-code").textContent = payload.code;
  $("d-gpt-dev-open").dataset.url = payload.uri;
  $("d-gpt-device").classList.remove("hidden");
  navigator.clipboard?.writeText(payload.code).catch(() => {});
});
$("d-gpt-signin").onclick = async () => {
  chatgptSigningIn = true;
  chatgptError = "";
  renderChatGPT();
  try {
    await invoke("paw_chatgpt_sign_in");
  } catch (err) {
    chatgptError = cancelled(err) ? "" : `Couldn't sign in: ${err}`;
  }
  chatgptSigningIn = false;
  await refreshKeyStatus();
  rescan();
};
$("d-gpt-cancel").onclick = () => invoke("paw_chatgpt_cancel_sign_in").catch(() => {});
$("d-gpt-signout").onclick = async () => {
  if (!confirm("Sign Paw out of ChatGPT?")) return;
  chatgptError = "";
  try { await invoke("paw_chatgpt_sign_out"); } catch (err) { chatgptError = String(err); }
  await refreshKeyStatus();
  rescan();
};

// ---------- Paw Agent: custom (OpenAI-compatible) providers ----------
function renderCompatible(p) {
  const c = customEntry(p);
  if (!c) return;
  // Not over what the user is typing (a scan may re-render meanwhile).
  for (const [id, value] of [["d-cu-name", c.name], ["d-cu-baseurl", c.base_url]]) {
    if (document.activeElement !== $(id)) $(id).value = value ?? "";
  }
  $("d-cu-keystatus").textContent = keyStatus?.[p] ? "A key is saved in your Keychain." : "No key: requests go without one.";
  $("d-cu-keydel").disabled = !keyStatus?.[p];
}
$("d-cu-name").addEventListener("input", (e) => {
  const c = customEntry(sel?.id);
  if (!c) return;
  c.name = e.target.value.trim();
  save();
  renderList();
  renderHead(c.id, providerName(c.id));
});
$("d-cu-baseurl").addEventListener("input", (e) => {
  const c = customEntry(sel?.id);
  if (!c) return;
  c.base_url = e.target.value.trim();
  save();
});
for (const id of ["d-cu-name", "d-cu-baseurl"]) $(id).addEventListener("change", () => rescan());
$("d-cu-remove").onclick = async () => {
  const c = customEntry(sel?.id);
  if (!c || !confirm(`Remove “${providerName(c.id)}”? Its API key goes from your Keychain too.`)) return;
  // The key command only takes providers in the saved settings: delete the key first.
  if (keyStatus?.[c.id]) {
    try { await invoke("paw_key_delete", { provider: c.id }); } catch (err) { $("d-cu-keystatus").textContent = String(err); return; }
  }
  settings.providers.custom = settings.providers.custom.filter((x) => x !== c);
  const mp = modelPrefs();
  const ours = (m) => m?.startsWith(c.id + "/");
  mp.hidden = mp.hidden.filter((m) => !ours(m));
  if (ours(mp.default)) mp.default = null;
  const first = providerViews()?.[0];
  sel = first ? { kind: "provider", id: first.id } : null;
  save();
  renderList();
  renderDetail();
  await refreshKeyStatus();
  rescan();
};

// ---------- Paw Agent: GitHub Copilot sign-in ----------
let copilotSigningIn = false;
let copilotError = "";
function renderCopilot() {
  const st = copilotStatus;
  const who = st?.login ? ` as ${st.login}` : "";
  $("d-cp-status").textContent = copilotError ? copilotError
    : st == null ? "Checking…"
    : copilotSigningIn ? "Waiting for you to approve Paw on GitHub…"
    : st.signed_in ? `Signed in to GitHub${who}. Paw Agent uses this sign-in.`
    : st.cli ? `Not signed in. Paw Agent uses Copilot CLI's sign-in (${st.cli}) for now.`
    : "Not signed in, and Copilot CLI isn't signed in either.";
  $("d-cp-signin").textContent = st?.signed_in ? "Sign In Again" : "Sign in with GitHub";
  $("d-cp-signin").disabled = copilotSigningIn;
  $("d-cp-cancel").classList.toggle("hidden", !copilotSigningIn);
  $("d-cp-signout").classList.toggle("hidden", !st?.signed_in || copilotSigningIn);
  if (!copilotSigningIn) $("d-cp-device").classList.add("hidden");
}
listen("copilot:device", ({ payload }) => {
  if (!copilotSigningIn) return;
  $("d-cp-code").textContent = payload.code;
  $("d-cp-open").dataset.url = payload.uri;
  $("d-cp-device").classList.remove("hidden");
  navigator.clipboard?.writeText(payload.code).catch(() => {});
});
$("d-cp-signin").onclick = async () => {
  copilotSigningIn = true;
  copilotError = "";
  renderCopilot();
  try {
    await invoke("paw_copilot_sign_in");
  } catch (err) {
    copilotError = String(err) === "Sign-in cancelled." ? "" : `Couldn't sign in: ${err}`;
  }
  copilotSigningIn = false;
  await refreshKeyStatus();
  rescan(); // the account's models
};
$("d-cp-cancel").onclick = () => invoke("paw_copilot_cancel_sign_in").catch(() => {});
$("d-cp-open").onclick = (e) => {
  e.preventDefault();
  if (e.target.dataset.url) invoke("open_url", { url: e.target.dataset.url }).catch(() => {});
};
$("d-cp-signout").onclick = async () => {
  if (!confirm("Sign Paw out of GitHub Copilot? Paw Agent then uses Copilot CLI's sign-in, if there is one.")) return;
  copilotError = "";
  try { await invoke("paw_copilot_sign_out"); } catch (err) { copilotError = String(err); }
  await refreshKeyStatus();
  rescan();
};

// ---------- Paw Agent: Claude sign-in ----------
let claudeSigningIn = false;
let claudeError = "";
function renderClaude() {
  const st = claudeStatus;
  // Only a failed sign-in needs words; the buttons show the rest.
  $("d-cl-status").textContent = claudeError;
  $("d-cl-status").classList.toggle("hidden", !claudeError);
  $("d-cl-signin").textContent = st?.signed_in ? "Sign In Again" : "Sign in with Claude";
  $("d-cl-signin").disabled = claudeSigningIn;
  $("d-cl-cancel").classList.toggle("hidden", !claudeSigningIn);
  $("d-cl-signout").classList.toggle("hidden", !st?.signed_in || claudeSigningIn);
  if (!claudeSigningIn) $("d-cl-waiting").classList.add("hidden");
}
listen("claude:auth", ({ payload }) => {
  if (!claudeSigningIn) return;
  $("d-cl-open").dataset.url = payload;
  $("d-cl-waiting").classList.remove("hidden");
});
$("d-cl-signin").onclick = async () => {
  claudeSigningIn = true;
  claudeError = "";
  renderClaude();
  try {
    await invoke("paw_claude_sign_in");
  } catch (err) {
    claudeError = String(err) === "Sign-in cancelled." ? "" : `Couldn't sign in: ${err}`;
  }
  claudeSigningIn = false;
  await refreshKeyStatus();
  rescan();
};
$("d-cl-cancel").onclick = () => invoke("paw_claude_cancel_sign_in").catch(() => {});
$("d-cl-open").onclick = (e) => {
  e.preventDefault();
  if (e.target.dataset.url) invoke("open_url", { url: e.target.dataset.url }).catch(() => {});
};
$("d-cl-signout").onclick = async () => {
  if (!confirm("Sign Paw out of Claude? Paw Agent then uses the next key or sign-in Key from finds.")) return;
  claudeError = "";
  try { await invoke("paw_claude_sign_out"); } catch (err) { claudeError = String(err); }
  await refreshKeyStatus();
  rescan();
};

let loginTab = null; // the Login tab the user picked, while Settings is open
function renderKeySources() {
  const keySource = providerConfig("anthropic").key_source;
  const pick = $("d-keysource");
  const list = keySources ?? [];
  const usable = list.filter((k) => k.usable);
  const name = (k) => k.detail ? `${k.label} — ${k.detail}` : k.label;
  pick.innerHTML = "";
  const add = (value, text, disabled = false) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = text; o.disabled = disabled;
    pick.appendChild(o);
  };
  add("", keySources == null ? "Automatic (looking…)" : usable.length ? `Automatic — ${name(usable[0])}` : "Automatic — no usable key or sign-in found yet");
  for (const k of usable) add(k.id, name(k));
  // A saved choice that isn't there any more stays visible, so it can be changed.
  if (keySource && !usable.some((k) => k.id === keySource)) add(keySource, `${keySource} (not found now)`);
  pick.value = keySource || "";
  const fill = (ul, items) => {
    ul.innerHTML = "";
    for (const k of items) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="ks-mark ${k.usable ? "ok" : "no"}">${k.usable ? "✓" : "✕"}</span>` +
        `<span class="ks-text">${esc(name(k))}${k.note ? `<span class="ks-note">${esc(k.note)}</span>` : ""}</span>`;
      ul.appendChild(li);
    }
  };
  fill($("d-signins"), list.filter((k) => k.sign_in));
  fill($("d-keysources"), list.filter((k) => !k.sign_in));
  // Until the user picks a tab, open the one holding what Paw Agent uses.
  const used = keySource ? list.find((k) => k.id === keySource) : usable[0];
  showLoginTab($("d-login-tabs"), loginTab ?? (used && !used.sign_in ? "api" : "signin"));
}
/** Shows a Login tab (Sign-in or API) of the tab bar `tabs`. */
function showLoginTab(tabs, tab) {
  for (const b of tabs.querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  tabs.closest(".login-tabs").querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab));
}
$("d-login-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (tab) showLoginTab($("d-login-tabs"), (loginTab = tab));
});
$("d-keysource").addEventListener("change", (e) => {
  providerConfig("anthropic").key_source = e.target.value;
  save();
  rescan();
});
// Ollama's address (d-baseurl) and Anthropic's (d-api-baseurl, for a gateway).
for (const [id, p] of [["d-baseurl", "ollama"], ["d-api-baseurl", "anthropic"]]) {
  $(id).addEventListener("input", (e) => { providerConfig(p).base_url = e.target.value.trim(); save(); });
  $(id).addEventListener("change", () => rescan());
}
/** An API key form: Save puts the key in the Keychain for `provider()`, Remove deletes it. */
function keyForm(form, input, del, status, provider) {
  $(form).addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $(input).value.trim();
    if (!key) return;
    try {
      await invoke("paw_key_set", { provider: provider(), key });
      $(input).value = "";
    } catch (err) { $(status).textContent = `Couldn't save the key: ${err}`; return; }
    await refreshKeyStatus();
    rescan();
  });
  $(del).onclick = async () => {
    if (!confirm(`Remove the ${providerName(provider())} API key from your Keychain?`)) return;
    try { await invoke("paw_key_delete", { provider: provider() }); } catch (err) { $(status).textContent = String(err); return; }
    await refreshKeyStatus();
    rescan();
  };
}
keyForm("d-keyform", "d-apikey", "d-keydel", "d-keystatus", () => "anthropic");
keyForm("d-or-keyform", "d-or-apikey", "d-or-keydel", "d-or-keystatus", () => "openrouter");
keyForm("d-cu-keyform", "d-cu-apikey", "d-cu-keydel", "d-cu-keystatus", () => sel.id);
refreshKeyStatus();

/** Actions the user chose "Always in this folder" for, on approval cards. Paw Agent's are keyed "paw". */
function renderAllowed(agentId) {
  const rules = (settings.allow_rules ?? []).filter((r) => r.agent === agentId);
  document.querySelectorAll(".d-allowed-only").forEach((el) => el.classList.toggle("hidden", !rules.length));
  const ul = $("d-allowed");
  ul.innerHTML = "";
  for (const r of rules) {
    const li = document.createElement("li");
    const folder = r.folder.replace(/^\/Users\/[^/]+/, "~");
    li.innerHTML = `<code title="${esc(r.label)}">${esc(r.label)}</code><span class="dim" title="${esc(folder)}">${esc(folder)}</span><button class="icon-btn" title="Remove">×</button>`;
    li.querySelector("button").onclick = () => {
      settings.allow_rules = settings.allow_rules.filter((x) => x !== r);
      save();
      renderAllowed(agentId);
    };
    ul.appendChild(li);
  }
}

$("d-addmodel").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("d-newmodel").value.trim();
  if (!v || !sel) return;
  if (sel.kind === "provider") {
    // Custom ids are plain; "anthropic/x" typed on Anthropic means "x".
    const p = sel.id;
    const id = v.startsWith(p + "/") ? v.slice(p.length + 1) : v;
    if (!providerModels(p).includes(id)) customModels(p).push(id);
    $("d-newmodel").value = "";
    save();
    renderList();
    renderDetail();
    rescan();
    return;
  }
  // Deprecated: CLI agents (CLI_AGENTS).
  const a = current();
  if (!CLI_AGENTS || !a) return;
  if (!allModels(a).includes(v)) a.custom_models.push(v);
  $("d-newmodel").value = "";
  save();
  renderDetail();
});

// Deprecated: CLI agents (CLI_AGENTS).
if (CLI_AGENTS) {
  for (const l of ["ask", "edits", "auto", "plan", "full"]) {
    $(`d-ap-${l}`).addEventListener("input", (e) => {
      const a = current();
      a.approvals ??= {};
      if (e.target.value.trim()) a.approvals[l] = e.target.value.trim(); else delete a.approvals[l];
      save();
      updatePreview();
    });
  }
  $("d-pattern").addEventListener("input", (e) => { current().session_pattern = e.target.value; save(); });
  $("d-template").addEventListener("input", (e) => { current().template = e.target.value; save(); updatePreview(); });

  $("d-reset").onclick = async () => {
    const a = current();
    if (!a) return;
    if (a.builtin) {
      const def = await invoke("reset_agent", { id: a.id });
      if (def) Object.assign(a, def);
    } else {
      if (!confirm(`Remove “${a.name}”?`)) return;
      settings.agents = settings.agents.filter((x) => x.id !== a.id);
      sel = defaultSelection();
    }
    save();
    renderList();
    renderDetail();
  };
  $("a-del").onclick = () => current() && !current().builtin && $("d-reset").click();

  $("a-add").onclick = () => {
    const id = "custom-" + Math.random().toString(36).slice(2, 8);
    settings.agents.push({
      id, name: "New Agent", binary: "my-agent", template: "{bin} {prompt}", io: "text",
      enabled: true, builtin: false, default_model: null, custom_models: [],
    });
    sel = { kind: "agent", id };
    save();
    renderList();
    renderDetail();
    $("d-name").focus();
    $("d-name").select();
  };
}

// ---------- detection ----------
function setScanning(on) {
  $("a-spin").classList.toggle("hidden", !on);
  $("a-rescan").disabled = on;
}
async function rescan() {
  setScanning(true);
  // Save first so the scan sees changed settings.
  await saveNow();
  await invoke("get_detections", { rescan: true });
}
$("a-rescan").onclick = rescan;

listen("agents:detected", ({ payload }) => {
  detections = payload;
  if (!settings) return; // boot renders once settings are in
  refreshKeyStatus(); // a key set up since may be there now
  setScanning(false);
  if (!selectionExists()) sel = defaultSelection();
  renderGeneral();
  renderList();
  renderDetail();
});


// ---------- appearance (themes) ----------
const T = window.PawThemes;
const ap = () => (settings.appearance ??= { light: "paw-light", dark: "paw-dark", light_extended: true, dark_extended: true, custom: [] });

/** A small preview: "Aa", a `~/` chip, a cursor block and the palette. */
function themePreview(t) {
  const el = document.createElement("div");
  el.className = "tprev";
  el.style.background = t.background;
  el.style.color = t.foreground;
  el.style.setProperty("--ring", t.background);
  const chipBg = T.mix(t.background, t.cursor, t.appearance === "dark" ? 0.3 : 0.2);
  el.innerHTML = `
    <div class="tp-top">
      <span class="aa">Aa</span>
      <span class="chip" style="background:${chipBg};color:${t.foreground}">~/</span>
      <span class="cur" style="background:${t.cursor}"></span>
    </div>
    <div class="dots">${t.palette.slice(0, 8).map((c) => `<span style="background:${c}"></span>`).join("")}</div>`;
  return el;
}

function renderWindowControls() {
  const mode = ap().mode || "system";
  document.querySelectorAll("#ap-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const pct = Math.round((ap().opacity ?? 0.94) * 100);
  $("ap-opacity").value = pct;
  $("ap-opacity-val").textContent = `${pct}%`;
  $("ap-opacity").style.setProperty("--fill", `${((pct - 30) / 70) * 100}%`);
}
document.querySelectorAll("#ap-mode button").forEach((b) => {
  b.onclick = () => { ap().mode = b.dataset.mode; save(); renderWindowControls(); };
});
$("ap-opacity").addEventListener("input", (e) => {
  ap().opacity = Math.max(0.3, Math.min(1, Number(e.target.value) / 100));
  renderWindowControls();
  save();
});

// ---------- font ----------
const FONT_DEFAULT = 12.5;
const KNOWN_FONTS = ["SF Mono", "Menlo", "Monaco", "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro",
  "IBM Plex Mono", "Hack", "Iosevka", "Roboto Mono", "Ubuntu Mono", "Victor Mono", "Geist Mono", "Commit Mono",
  "Monaspace Neon", "Berkeley Mono", "Input Mono", "Courier New"];
/** Installed? A font that isn't renders like the fallback in both a mono and a serif setting. */
function fontInstalled(name) {
  const c = (fontInstalled.ctx ??= document.createElement("canvas").getContext("2d"));
  const w = (f) => { c.font = `40px ${f}`; return c.measureText("mmmmmmmmmlli10OO@@%").width; };
  return ["monospace", "serif"].some((base) => w(`"${name}", ${base}`) !== w(base));
}
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
function renderFont() {
  const a = ap();
  const name = String(a.font_family ?? "");
  if (document.activeElement !== $("ap-font")) $("ap-font").value = name;
  const size = Number(a.font_size) || FONT_DEFAULT, lh = Number(a.line_height) || 1.6;
  $("ap-font-size").value = size;
  $("ap-font-size-val").textContent = String(size);
  $("ap-font-size").style.setProperty("--fill", `${((size - 9) / 19) * 100}%`);
  $("ap-line-height").value = lh;
  $("ap-line-height-val").textContent = lh.toFixed(2).replace(/0$/, "");
  $("ap-line-height").style.setProperty("--fill", `${((lh - 1.2) / 1.0) * 100}%`);
  const ok = !name.trim() || fontInstalled(name.trim());
  $("ap-font-hint").textContent = ok
    ? "For the transcript, the prompt and the terminal view. Empty: the system's monospace (SF Mono)."
    : `“${name.trim()}” isn't installed, so SF Mono is used. Install it, or pick one from the list.`;
  $("ap-font-hint").classList.toggle("warn", !ok);
  const pv = $("ap-font-preview").style;
  pv.setProperty("--pv-family", name.trim() ? `"${name.trim().replace(/["\\]/g, "")}", ${MONO}` : MONO);
  pv.setProperty("--pv-size", `${size}px`);
  pv.setProperty("--pv-lh", String(lh));
  // The active theme's colors, so the preview looks like a tab.
  try {
    const { theme } = T.activeTheme(settings);
    pv.setProperty("--pv-bg", theme.background);
    pv.setProperty("--pv-fg", theme.foreground);
  } catch { /* defaults */ }
}
function fillFontList() {
  $("ap-font-list").innerHTML = KNOWN_FONTS.filter(fontInstalled).map((f) => `<option value="${esc(f)}"></option>`).join("");
}
$("ap-font").addEventListener("input", (e) => { ap().font_family = e.target.value; renderFont(); save(); });
$("ap-font").addEventListener("change", (e) => { ap().font_family = e.target.value.trim(); renderFont(); save(); });
$("ap-font-size").addEventListener("input", (e) => { ap().font_size = Number(e.target.value); renderFont(); save(); });
$("ap-line-height").addEventListener("input", (e) => { ap().line_height = Number(e.target.value); renderFont(); save(); });
$("ap-font-reset").onclick = () => { Object.assign(ap(), { font_family: "", font_size: FONT_DEFAULT, line_height: 1.6 }); renderFont(); save(); };
// ⌘+ / ⌘− in the main window change the size: follow it here (and don't save an old one over it).
listen("settings:changed", ({ payload }) => {
  if (!settings || !payload?.appearance) return;
  const now = ap();
  if (now.font_size !== payload.appearance.font_size) { now.font_size = payload.appearance.font_size; renderFont(); }
});

function renderAppearance() {
  renderWindowControls();
  if (!fillFontList.done) { fillFontList(); fillFontList.done = true; }
  renderFont();
  const sys = T.systemAppearance();
  for (const mode of ["light", "dark"]) {
    document.querySelector(`.ap-section[data-mode="${mode}"]`).classList.toggle("active", sys === mode);
    const row = $(`ap-row-${mode}`);
    row.innerHTML = "";
    const themes = T.allThemes(settings).filter((t) => t.appearance === mode);
    const groups = [
      ["Default", themes.filter((t) => t.id === `paw-${mode}`)],
      ["Custom", themes.filter((t) => !t.builtin)],
      ["Built-in", themes.filter((t) => t.builtin && t.id !== `paw-${mode}`)],
    ];
    const selected = ap()[mode];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const g = document.createElement("div");
      g.className = "ap-group";
      g.innerHTML = `<div class="ap-group-label">${label}</div><div class="ap-cards"></div>`;
      for (const t of list) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "tcard" + (t.id === selected ? " sel" : "");
        card.title = t.name;
        card.appendChild(themePreview(t));
        card.insertAdjacentHTML("beforeend", `<div class="tname">${esc(t.name)}</div>`);
        if (!t.builtin) {
          const edit = document.createElement("span");
          edit.className = "tedit";
          edit.title = "Edit theme";
          edit.textContent = "✎";
          edit.onclick = (e) => { e.stopPropagation(); openEditor(mode, t); };
          card.appendChild(edit);
        }
        card.onclick = () => { ap()[mode] = t.id; save(); renderAppearance(); };
        card.ondblclick = () => { if (!t.builtin) openEditor(mode, t); };
        g.querySelector(".ap-cards").appendChild(card);
      }
      row.appendChild(g);
    }
    row.querySelector(".tcard.sel")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    $(`ap-ext-${mode}`).checked = ap()[`${mode}_extended`] !== false;
  }
}

for (const mode of ["light", "dark"]) {
  $(`ap-ext-${mode}`).addEventListener("change", (e) => { ap()[`${mode}_extended`] = e.target.checked; save(); });
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAppearance);

// ----- editor -----
let editing = null; // { mode, theme, isNew }
const COLOR_KEYS = ["background", "foreground", "cursor", "selection"];

function openEditor(mode, theme, isNew = false) {
  editing = { mode, isNew, theme: structuredClone(theme) };
  $("te-name").value = theme.name;
  for (const k of COLOR_KEYS) $(`te-${k}`).value = theme[k];
  for (const [box, offset] of [["te-normal", 0], ["te-bright", 8]]) {
    const el = $(box);
    el.innerHTML = "";
    for (let i = 0; i < 8; i++) {
      const input = document.createElement("input");
      input.type = "color";
      input.value = editing.theme.palette[offset + i];
      input.title = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"][i] + (offset ? " (bright)" : "");
      input.oninput = () => { editing.theme.palette[offset + i] = input.value; updateEditorPreview(); };
      el.appendChild(input);
    }
  }
  $("te-delete").classList.toggle("hidden", isNew || theme.builtin);
  $("te").classList.remove("hidden");
  updateEditorPreview();
  $("te-name").focus();
  $("te-name").select();
}

function updateEditorPreview() {
  const t = editing.theme;
  t.name = $("te-name").value;
  for (const k of COLOR_KEYS) t[k] = $(`te-${k}`).value;
  t.appearance = T.luminance(t.background) < 0.4 ? "dark" : "light";
  const box = $("te-preview");
  box.replaceWith(Object.assign(themePreview(t), { id: "te-preview" }));
}
["te-name", ...COLOR_KEYS.map((k) => `te-${k}`)].forEach((id) => $(id).addEventListener("input", updateEditorPreview));
const closeEditor = () => { $("te").classList.add("hidden"); editing = null; };
$("te-cancel").onclick = closeEditor;
$("te").addEventListener("mousedown", (e) => { if (e.target === $("te")) closeEditor(); });

$("te-form").addEventListener("submit", (e) => {
  e.preventDefault();
  updateEditorPreview();
  const t = editing.theme;
  const stored = {
    id: t.id, name: t.name.trim() || "Untitled", appearance: t.appearance,
    background: t.background, foreground: t.foreground, cursor: t.cursor, selection: t.selection, palette: t.palette,
  };
  const list = ap().custom;
  const i = list.findIndex((x) => x.id === stored.id);
  if (i >= 0) list[i] = stored; else list.push(stored);
  // Background decides light/dark; select it in that section.
  ap()[stored.appearance] = stored.id;
  save();
  closeEditor();
  renderAppearance();
});

$("te-delete").onclick = () => {
  const t = editing.theme;
  if (!confirm(`Delete the theme “${t.name}”?`)) return;
  ap().custom = ap().custom.filter((x) => x.id !== t.id);
  for (const mode of ["light", "dark"]) if (ap()[mode] === t.id) ap()[mode] = `paw-${mode}`;
  save();
  closeEditor();
  renderAppearance();
};

document.querySelectorAll(".ap-new").forEach((b) => {
  b.onclick = () => {
    const mode = b.dataset.new;
    const base = T.activeTheme(settings, mode).theme;
    const n = ap().custom.filter((t) => (t.name || "").startsWith("Custom")).length + 1;
    openEditor(mode, { ...base, id: "custom-" + Math.random().toString(36).slice(2, 9), name: `Custom ${n}`, builtin: false }, true);
  };
});

// ----- import -----
$("ap-import").onclick = async () => {
  const msg = $("ap-import-msg");
  msg.classList.remove("error");
  try {
    const picked = await invoke("pick_theme_file");
    if (!picked) return;
    const [fileName, text] = picked;
    const t = T.importThemeFile(fileName, text);
    const stored = {
      id: t.id, name: t.name, appearance: t.appearance, background: t.background, foreground: t.foreground,
      cursor: t.cursor, selection: t.selection, palette: t.palette,
    };
    ap().custom.push(stored);
    ap()[t.appearance] = t.id;
    save();
    renderAppearance();
    msg.textContent = `Imported “${t.name}” as a ${t.appearance} theme and selected it.`;
  } catch (e) {
    msg.textContent = `Couldn't import that file: ${e.message ?? e}`;
    msg.classList.add("error");
  }
};

// ---------- boot ----------
(async () => {
  settings = await invoke("get_settings");
  detections = await invoke("get_detections", { rescan: false });
  setScanning(await invoke("is_scanning"));
  sel = defaultSelection();
  renderGeneral();
  renderAppearance();
  renderList();
  renderDetail();
  let tab = location.hash.slice(1);
  if (!tab) { try { tab = localStorage.getItem("paw.prefsTab"); } catch {} }
  selectTab(["general", "appearance", "agents", "about"].includes(tab) ? tab : "agents");
})();

document.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "w") { e.preventDefault(); window.__TAURI__.window.getCurrentWindow().close(); }
});

// About: the version, and the About window for the license and the projects Paw is built on.
invoke("about_info").then((i) => { $("about-version").textContent = `Version ${i.version}`; }).catch(() => {});
document.querySelector("#pane-about .about-links").addEventListener("click", (e) => {
  const b = e.target.closest("[data-about]");
  if (b) invoke("open_about", { view: b.dataset.about }).catch(() => {});
});

// ---------- plugins ----------
// The catalog (index.json) from Paw's repository, or another URL or folder
// (General's plugin_source); installed plugins live in ~/.paw/plugins.
const PERMISSION_TEXT = {
  commands: "add slash commands and print in your tabs",
  statusbar: "show text in the status bar",
  events: "see your prompts, agent turns (time, tokens) and shell commands",
  prompt: "put text in your prompt or send it to an agent",
  shell: "run commands in your tab's shell",
  network: "connect to the internet",
  tasks: "read your plans and follow their progress",
  views: "draw on a plan's board, next to its graph",
};
const plState = { catalog: null, installed: [], error: "", loading: false, busy: new Set(), appVersion: "" };
const older = (a, b) => {
  const p = (v) => String(v ?? "").replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};
const plSource = () => (settings.general.plugin_source ?? "").trim() || null;

async function loadPluginLists() {
  plState.loading = true;
  plState.error = "";
  renderPlugins();
  try { plState.installed = await invoke("plugins_installed", { withCode: false }); } catch (e) { plState.installed = []; }
  try {
    plState.catalog = await invoke("plugins_catalog", { source: plSource() });
  } catch (e) {
    plState.catalog = null;
    plState.error = String(e) + (plSource() ? "" : " — if Paw's repository is private, set the catalog to a folder (its plugins folder in a checkout).");
  }
  plState.loading = false;
  renderPlugins();
}

function permsHtml(perms) {
  return (perms ?? []).map((p) => `<span class="pl-perm" title="${esc(PERMISSION_TEXT[p] ?? p)}">${esc(p)}</span>`).join("");
}

function pluginCard(m, { installed, enabled, update, needs }) {
  const busy = plState.busy.has(m.id);
  const meta = [m.version && `v${m.version}`, m.author && `by ${m.author}`, m.license].filter(Boolean).map(esc).join(" · ");
  const link = m.homepage ? ` · <a href="#" data-url="${esc(m.homepage)}">website</a>` : "";
  const actions = installed
    ? `${update ? `<button type="button" class="btn-primary small" data-pl-update="${esc(m.id)}" ${busy ? "disabled" : ""}>Update to v${esc(update)}</button>` : ""}
       <button type="button" class="btn-ghost small" data-pl-folder="${esc(m.id)}">Show Files</button>
       <button type="button" class="btn-ghost small danger" data-pl-remove="${esc(m.id)}" ${busy ? "disabled" : ""}>Remove</button>`
    : needs
      ? `<span class="hint">Needs Paw ${esc(needs)}</span>`
      : `<button type="button" class="btn-primary small" data-pl-install="${esc(m.id)}" ${busy ? "disabled" : ""}>${busy ? "Installing…" : "Install"}</button>`;
  return `<div class="pl-card${installed && !enabled ? " off" : ""}">
    <div class="pl-top">
      <div class="pl-title"><b>${esc(m.name)}</b> <span class="hint">${meta}${link}</span></div>
      ${installed ? `<label class="switch" title="${enabled ? "On" : "Off"}"><input type="checkbox" data-pl-toggle="${esc(m.id)}" ${enabled ? "checked" : ""} /><span></span></label>` : ""}
    </div>
    ${m.description ? `<div class="pl-desc">${esc(m.description)}</div>` : ""}
    <div class="pl-bottom"><div class="pl-perms">${permsHtml(m.permissions)}</div><div class="pl-actions">${actions}</div></div>
  </div>`;
}

function renderPlugins() {
  if (!$("pl-installed")) return;
  if (document.activeElement !== $("pl-source")) $("pl-source").value = settings?.general?.plugin_source ?? "";
  const cat = new Map((plState.catalog?.plugins ?? []).map((m) => [m.id, m]));
  const inst = plState.installed;
  $("pl-installed").innerHTML = inst.length
    ? inst.map((p) => {
      const newer = cat.get(p.manifest.id);
      return pluginCard(p.manifest, { installed: true, enabled: p.enabled, update: newer && older(p.manifest.version, newer.version) ? newer.version : null });
    }).join("")
    : `<div class="pl-empty">No plugins installed yet.</div>`;
  const ids = new Set(inst.map((p) => p.manifest.id));
  const avail = [...cat.values()].filter((m) => !ids.has(m.id));
  $("pl-available").innerHTML = plState.loading
    ? `<div class="pl-empty">Loading the catalog…</div>`
    : plState.error
      ? `<div class="pl-empty err">${esc(plState.error)}</div>`
      : avail.length
        ? avail.map((m) => pluginCard(m, { installed: false, needs: m.min_paw && plState.appVersion && older(plState.appVersion, m.min_paw) ? m.min_paw : null })).join("")
        : `<div class="pl-empty">${cat.size ? "Every plugin in the catalog is installed." : "The catalog has no plugins."}</div>`;
}

async function installPlugin(id, verb = "Install") {
  const m = plState.catalog?.plugins.find((x) => x.id === id);
  if (!m) return;
  // An update marks what the installed version couldn't do yet.
  const had = plState.installed?.find((p) => p.manifest.id === id)?.manifest.permissions;
  const perms = m.permissions ?? [];
  const can = perms.map((p) => `• ${PERMISSION_TEXT[p] ?? p}${had && !had.includes(p) ? "  (new)" : ""}`).join("\n") || "• nothing beyond running in its sandbox";
  if (!confirm(`${verb} “${m.name}” ${m.version}${m.author ? ` by ${m.author}` : ""}?\n\nIt will be able to:\n${can}\n\nPlugins run in a sandbox and can only do what's listed.`)) return;
  plState.busy.add(id);
  renderPlugins();
  try {
    // Paw refuses the plugin if its own manifest asks for more than this.
    await invoke("plugin_install", { source: plSource(), id, permissions: perms });
    $("pl-msg").textContent = `${m.name} ${m.version} is installed and on. Its commands are in /help and /plugins.`;
  } catch (e) {
    alert(`Couldn't install ${m.name}: ${e}`);
  }
  plState.busy.delete(id);
  try { plState.installed = await invoke("plugins_installed", { withCode: false }); } catch {}
  renderPlugins();
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  const inst = t.closest?.("[data-pl-install]");
  if (inst) return installPlugin(inst.dataset.plInstall);
  const upd = t.closest?.("[data-pl-update]");
  if (upd) return installPlugin(upd.dataset.plUpdate, "Update");
  const rm = t.closest?.("[data-pl-remove]");
  if (rm) {
    const p = plState.installed.find((x) => x.manifest.id === rm.dataset.plRemove);
    if (!p || !confirm(`Remove “${p.manifest.name}”? What it stored is removed too.`)) return;
    try { await invoke("plugin_remove", { id: p.manifest.id }); } catch (err) { alert(String(err)); }
    try { plState.installed = await invoke("plugins_installed", { withCode: false }); } catch {}
    return renderPlugins();
  }
  const folder = t.closest?.("[data-pl-folder]");
  if (folder) {
    try { await invoke("open_folder", { path: await invoke("plugins_folder", { id: folder.dataset.plFolder }) }); } catch (err) { alert(String(err)); }
    return;
  }
  const link = t.closest?.(".pl-card a[data-url]");
  if (link) { e.preventDefault(); invoke("open_url", { url: link.dataset.url }).catch(() => {}); }
});
document.addEventListener("change", async (e) => {
  const tg = e.target.closest?.("[data-pl-toggle]");
  if (!tg) return;
  try { await invoke("plugin_set_enabled", { id: tg.dataset.plToggle, enabled: tg.checked }); } catch (err) { alert(String(err)); }
  try { plState.installed = await invoke("plugins_installed", { withCode: false }); } catch {}
  renderPlugins();
});
$("pl-folder").onclick = async () => {
  try { await invoke("open_folder", { path: await invoke("plugins_folder", {}) }); } catch (err) { alert(String(err)); }
};
let plSourceTimer = null;
$("pl-source").addEventListener("input", (e) => {
  settings.general.plugin_source = e.target.value.trim();
  save();
  clearTimeout(plSourceTimer);
  plSourceTimer = setTimeout(loadPluginLists, 800);
});
$("pl-reload").onclick = () => loadPluginLists();
document.querySelector('#ptabs button[data-tab="plugins"]').addEventListener("click", () => { if (!plState.catalog && !plState.loading) loadPluginLists(); });
invoke("about_info").then((i) => { plState.appVersion = i.version; }).catch(() => {});

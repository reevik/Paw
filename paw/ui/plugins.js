// Plugins: small JavaScript programs that extend the terminal (Settings ›
// Plugins installs them; the catalog is plugins/ in Paw's repository).
//
// Each runs in its own web worker, away from the window: it sees a `paw`
// object and nothing of Paw's own code. What it asks for goes through the
// host below, which checks the permissions its manifest declares (and the
// user approved when installing):
//   commands  — slash commands; printing in a tab
//   statusbar — a short text in the status bar
//   events    — prompts sent, agent turns (time, tokens), shell commands
//   prompt    — put text in the prompt, or send it to the tab's agent
//   shell     — run a command in the tab's shell (shown there like typed)
//   network   — fetch and friends (without it they're taken away)
// The worker API is described in plugins/README.md.

const pluginHost = {
  plugins: new Map(),   // id → { manifest, perms, worker, error }
  commands: new Map(),  // name → { id, description, usage }
  status: new Map(),    // id → { text, title }
  subs: new Map(),      // event → Set of ids
  calls: new Map(),     // req → { resolve, reject, timer }
  storage: new Map(),   // id → object
  seq: 1,
};

/** Names a plugin can't take. */
const BUILTIN_COMMANDS = new Set(["help", "model", "agent", "approval", "restart", "stop", "new", "task", "tasks", "sessions", "session",
  "stats", "clear", "cd", "history", "plugins", "exit", "quit"]);

const PERMISSION_TEXT = {
  commands: "add slash commands and print in your tabs",
  statusbar: "show text in the status bar",
  events: "see your prompts, agent turns (time, tokens) and shell commands",
  prompt: "put text in your prompt or send it to an agent",
  shell: "run commands in your tab's shell",
  network: "connect to the internet",
};

// Runs first in every plugin's worker. `cfg` is filled in per plugin.
const PLUGIN_BOOTSTRAP = String.raw`
"use strict";
(() => {
  const cfg = self.__pawConfig;
  delete self.__pawConfig;
  const can = (p) => cfg.permissions.includes(p);
  if (!can("network")) {
    // Best effort: the ways a worker reaches the network, gone.
    for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "WebTransport"]) {
      for (const o of [self, Object.getPrototypeOf(self), self.WorkerGlobalScope?.prototype]) { try { if (o) delete o[k]; } catch {} }
      try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch {}
    }
  }
  let seq = 0;
  const pending = new Map(), handlers = new Map(), listeners = new Map();
  const post = (m) => postMessage(m);
  const call = (m) => new Promise((resolve, reject) => { const req = ++seq; pending.set(req, { resolve, reject }); post({ ...m, req }); });
  const tabId = (t) => (t && typeof t === "object" ? t.id : t ?? null);
  self.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "reply") {
      const p = pending.get(m.req); pending.delete(m.req);
      if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
    } else if (m.type === "command") {
      const h = handlers.get(m.name);
      try {
        const out = h ? await h(m.args, m.tab) : "";
        post({ type: "done", req: m.req, value: out == null ? "" : typeof out === "string" ? out : JSON.stringify(out, null, 2) });
      } catch (err) { post({ type: "done", req: m.req, error: String(err && err.message || err) }); }
    } else if (m.type === "event") {
      for (const fn of listeners.get(m.event) || []) { try { await fn(m.data); } catch (err) { console.error(err); } }
    }
  };
  self.paw = Object.freeze({
    id: cfg.id,
    version: cfg.version,
    /** A slash command: handler(args, tab) returns Markdown to show (or nothing). */
    command(name, opts, fn) {
      if (typeof opts === "function") { fn = opts; opts = {}; }
      handlers.set(name, fn);
      post({ type: "command", name, description: (opts && opts.description) || "", usage: (opts && opts.usage) || "" });
    },
    /** "prompt" { tab, text } · "turn" { tab, ok, ms, input, output, model, agent } · "command" { tab, command, code } */
    on(event, fn) {
      if (!listeners.has(event)) { listeners.set(event, []); post({ type: "subscribe", event }); }
      listeners.get(event).push(fn);
    },
    /** Text in the status bar ("" removes it). */
    status(text, opts) { post({ type: "status", text: String(text == null ? "" : text), title: (opts && opts.title) || "" }); },
    /** Markdown in a tab's transcript. */
    print(tab, markdown) { post({ type: "print", tab: tabId(tab), markdown: String(markdown) }); },
    /** Put text in a tab's prompt, or send it ({ send: true }). */
    prompt(tab, text, opts) { return call({ type: "prompt", tab: tabId(tab), text: String(text), send: !!(opts && opts.send) }); },
    /** Run a command in a tab's shell; resolves to { code, output }. */
    run(tab, command) { return call({ type: "run", tab: tabId(tab), command: String(command) }); },
    /** The open tabs: { id, title, agent, model, cwd, active }. */
    tabs() { return call({ type: "tabs" }); },
    /** The plugin's own storage, kept between launches. */
    storage: Object.freeze({
      get: (key) => call({ type: "storage-get", key }),
      set: (key, value) => call({ type: "storage-set", key, value }),
    }),
  });
})();
`;

/** A tab as plugins see it. */
function pluginTab(S) {
  return S ? { id: S.pawId, title: tabLabel(S), agent: S.agent.name, model: modelOf(S), cwd: S.cwd, active: S.sid === activeId } : null;
}
const tabByPluginId = (id) => (id ? [...sessions.values()].find((S) => S.pawId === id) : curS()) ?? curS();

function stopPlugins() {
  for (const p of pluginHost.plugins.values()) p.worker?.terminate();
  for (const c of pluginHost.calls.values()) { clearTimeout(c.timer); c.reject(new Error("The plugin was stopped")); }
  pluginHost.plugins.clear();
  pluginHost.commands.clear();
  pluginHost.status.clear();
  pluginHost.subs.clear();
  pluginHost.calls.clear();
}

/** Start the plugins that are on (at launch, and when Settings changes them). */
function loadPlugins() {
  stopPlugins();
  pluginHost.loading = (async () => {
    let list = [];
    try { list = await invoke("plugins_installed", { withCode: true }); } catch { return; }
    for (const p of list) if (p.enabled && p.code) startPlugin(p.manifest, p.code);
    renderPluginStatus();
  })().finally(() => { pluginHost.loading = null; });
  return pluginHost.loading;
}

function startPlugin(m, code) {
  const perms = new Set(m.permissions ?? []);
  const cfg = JSON.stringify({ id: m.id, version: m.version, permissions: [...perms] });
  // "ready" once its script has run: its commands are registered by then.
  const src = `self.__pawConfig = ${cfg};\n${PLUGIN_BOOTSTRAP}\n;\n${code}\n;postMessage({ type: "ready" });\n//# sourceURL=paw-plugin-${m.id}.js`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const entry = { manifest: m, perms, worker: null, error: null };
  entry.ready = new Promise((resolve) => { entry.markReady = resolve; });
  try {
    entry.worker = new Worker(url);
  } catch (e) {
    entry.error = String(e);
    entry.markReady();
    pluginLog(m.id, `couldn't start: ${entry.error}`);
    pluginHost.plugins.set(m.id, entry);
    return;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  entry.worker.onmessage = (e) => pluginMessage(entry, e.data).catch((err) => console.error(`plugin ${m.id}:`, err));
  entry.worker.onerror = (e) => {
    entry.error = `${e.message || "error"}${e.lineno ? ` (line ${e.lineno})` : ""}`;
    entry.markReady();
    console.error(`plugin ${m.id}: ${entry.error}`);
    pluginLog(m.id, `error: ${entry.error}`);
  };
  pluginHost.plugins.set(m.id, entry);
}

const pluginLog = (id, message) => invoke("plugin_log", { id, message }).catch(() => {});
const reply = (entry, req, value, error) => entry.worker?.postMessage({ type: "reply", req, value, error });

async function pluginStorage(id) {
  if (!pluginHost.storage.has(id)) pluginHost.storage.set(id, await invoke("plugin_storage_get", { id }).catch(() => ({})));
  return pluginHost.storage.get(id);
}

async function pluginMessage(entry, m) {
  const id = entry.manifest.id;
  const need = (perm) => {
    if (entry.perms.has(perm)) return true;
    console.warn(`plugin ${id}: needs the “${perm}” permission for ${m.type}`);
    pluginLog(id, `refused ${m.type}: needs the “${perm}” permission`);
    if (m.req) reply(entry, m.req, null, `This plugin doesn't have the “${perm}” permission.`);
    return false;
  };
  switch (m.type) {
    case "ready":
      entry.markReady();
      pluginLog(id, `started (${[...pluginHost.commands.entries()].filter(([, c]) => c.id === id).map(([n]) => "/" + n).join(" ") || "no commands"})`);
      return;
    case "command": {
      if (!need("commands")) return;
      const name = String(m.name ?? "").replace(/^\//, "").toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(name) || BUILTIN_COMMANDS.has(name)) return console.warn(`plugin ${id}: can't use /${name}`);
      const taken = pluginHost.commands.get(name);
      if (taken && taken.id !== id) return console.warn(`plugin ${id}: /${name} belongs to ${taken.id}`);
      pluginHost.commands.set(name, { id, description: String(m.description ?? ""), usage: String(m.usage ?? "") });
      return;
    }
    case "subscribe":
      if (!need("events")) return;
      if (!["prompt", "turn", "command"].includes(m.event)) return;
      if (!pluginHost.subs.has(m.event)) pluginHost.subs.set(m.event, new Set());
      pluginHost.subs.get(m.event).add(id);
      return;
    case "status":
      if (!need("statusbar")) return;
      if (m.text) pluginHost.status.set(id, { text: String(m.text).slice(0, 60), title: String(m.title ?? "").slice(0, 300) });
      else pluginHost.status.delete(id);
      renderPluginStatus();
      return;
    case "print": {
      if (!need("commands")) return;
      const S = tabByPluginId(m.tab);
      if (S) info(S, pluginOutputHtml(entry.manifest, m.markdown));
      return;
    }
    case "prompt": {
      if (!need("prompt")) return;
      const S = tabByPluginId(m.tab);
      if (!S) return reply(entry, m.req, null, "No such tab");
      if (m.send) { await sendToAgent(S, m.text); return reply(entry, m.req, true); }
      if (S.sid === activeId) {
        const ta = $("input");
        ta.value = m.text;
        autosize();
        updateGlyph();
        ta.focus();
      } else S.draft = m.text;
      return reply(entry, m.req, true);
    }
    case "run": {
      if (!need("shell")) return;
      const S = tabByPluginId(m.tab);
      if (!S) return reply(entry, m.req, null, "No such tab");
      if (S.shellBusy) return reply(entry, m.req, null, "That tab's shell is busy");
      (S.pluginRuns ??= []).push({ entry, req: m.req });
      runShell(S, m.command);
      return;
    }
    case "tabs":
      return reply(entry, m.req, openTabs.map((sid) => pluginTab(sessions.get(sid))).filter(Boolean));
    case "storage-get": {
      const data = await pluginStorage(id);
      return reply(entry, m.req, m.key == null ? data : data[m.key] ?? null);
    }
    case "storage-set": {
      const data = await pluginStorage(id);
      if (m.value === undefined || m.value === null) delete data[m.key];
      else data[m.key] = m.value;
      try { await invoke("plugin_storage_set", { id, data }); reply(entry, m.req, true); } catch (e) { reply(entry, m.req, null, String(e)); }
      return;
    }
    case "done": {
      const c = pluginHost.calls.get(m.req);
      if (!c) return;
      pluginHost.calls.delete(m.req);
      clearTimeout(c.timer);
      m.error ? c.reject(new Error(m.error)) : c.resolve(m.value);
      return;
    }
  }
}

function pluginOutputHtml(m, markdown) {
  return `<div class="plugin-out"><span class="plugin-tag">${esc(m.name)}</span><div class="md">${renderMarkdown(String(markdown ?? ""), true)}</div></div>`;
}

/** A plugin's slash command; false when no plugin has it. */
async function runPluginCommand(S, name, args, echo) {
  // Plugins still starting (launch, or just changed in Settings): wait for them, briefly.
  if (!pluginHost.commands.has(name) && pluginHost.loading) await pluginHost.loading;
  const pending = [...pluginHost.plugins.values()].map((p) => p.ready);
  if (!pluginHost.commands.has(name) && pending.length) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 2000))]);
  const cmd = pluginHost.commands.get(name);
  const entry = cmd && pluginHost.plugins.get(cmd.id);
  if (!entry?.worker) return false;
  echo();
  const req = pluginHost.seq++;
  const out = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pluginHost.calls.delete(req); reject(new Error(`/${name} didn't answer within 60 s`)); }, 60_000);
    pluginHost.calls.set(req, { resolve, reject, timer });
  });
  entry.worker.postMessage({ type: "command", req, name, args, tab: pluginTab(S) });
  try {
    const md = await out;
    if (String(md).trim()) info(S, pluginOutputHtml(entry.manifest, md));
  } catch (e) {
    sys(S, `✗ ${entry.manifest.name}: ${e.message}`);
  }
  return true;
}

/** Tell the plugins that listen. */
function pluginEvent(event, data) {
  const ids = pluginHost.subs.get(event);
  if (!ids?.size) return;
  for (const id of ids) pluginHost.plugins.get(id)?.worker?.postMessage({ type: "event", event, data });
}

/** A shell command a plugin ran has finished: give it the output. */
function pluginShellDone(S, code) {
  const run = S.pluginRuns?.shift();
  if (!run) return;
  reply(run.entry, run.req, { code, output: (S.shellPending?.out ?? []).join("\n") });
}

function renderPluginStatus() {
  const items = [...pluginHost.status.entries()].map(([id, s]) => {
    const m = pluginHost.plugins.get(id)?.manifest;
    return `<span class="sl-plugin" title="${esc(`${m?.name ?? id}${s.title ? ": " + s.title : ""}`)}">${esc(s.text)}</span>`;
  }).join("");
  for (const P of panes.values()) {
    const el = P.root.querySelector('[data-id="sl-plugins"]');
    if (el) el.innerHTML = items;
  }
}

/** /plugins: what's installed and running, and their commands. */
async function pluginsListHtml() {
  let list = [];
  try { list = await invoke("plugins_installed", { withCode: false }); } catch {}
  if (!list.length) return `<span class="dim">No plugins installed. Settings › Plugins lists the ones available.</span>`;
  const rows = list.map((p) => {
    const m = p.manifest;
    const run = pluginHost.plugins.get(m.id);
    const state = !p.enabled ? `<span class="dim">off</span>` : run?.error ? `<span class="err">error: ${esc(run.error)}</span>` : `<span class="ok">on</span>`;
    const cmds = [...pluginHost.commands.entries()].filter(([, c]) => c.id === m.id).map(([n]) => `<span class="cmd">/${esc(n)}</span>`).join(" ");
    return `${esc(m.name)} <span class="dim">${esc(m.version)} · ${esc(m.author || "unknown author")}</span>  ${state}${cmds ? "  " + cmds : ""}`;
  });
  return `<span class="help-h">Plugins</span>\n${rows.join("\n")}\n<span class="dim">Settings › Plugins installs, updates and turns them off.</span>`;
}

/** Help rows for plugin commands. */
function pluginHelpRows(row) {
  return [...pluginHost.commands.entries()].map(([n, c]) => row(`/${n}${c.usage ? " " + c.usage : ""}`, c.description || `from ${pluginHost.plugins.get(c.id)?.manifest.name ?? c.id}`));
}

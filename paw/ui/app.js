// Paw main window — terminal-style sessions, one agent per tab.
//
// A *session* is what a tab shows. It owns the scrollback and one agent
// process at a time:
//   - "claude"  : one long-lived `claude` process; every prompt goes to stdin
//                 as stream-json. Started as soon as the tab opens.
//   - "stdin"   : any long-lived process whose template has no {prompt};
//                 prompts are written to stdin as plain text.
//   - "oneshot" : CLIs that take the prompt as an argument (codex exec,
//                 ollama run…). Each prompt runs the command once, in the
//                 same tab, like typing commands into a shell.
//
// Every tab runs Paw Agent on a model ("provider/model") from a provider the
// user connected (Settings › Agents). The CLI agents above are switched off.

/** CLI process agents (Claude Code, Codex, Copilot CLI…). Off: every tab runs Paw Agent. */
const CLI_AGENTS = false;
// ---------- the daemon ----------
// Agents, shells and Paw Agent sessions run in Paw's daemon (src-tauri/src/
// daemon.rs), which keeps running when this window quits. Its commands go
// through `daemon_call`; its events arrive like any other. Every handler is
// kept, so events the window missed while it was gone can be replayed.
const tauriInvoke = window.__TAURI__.core.invoke;
const tauriListen = window.__TAURI__.event.listen;
const DAEMON_COMMANDS = new Set([
  "spawn_agent", "send_input", "close_input", "stop_agent", "remove_agent", "list_agents", "agent_output",
  "shell_open", "shell_run", "shell_write", "shell_interrupt", "shell_close", "shell_write_raw", "shell_resize", "shell_raw_exit",
  "paw_agent_start", "paw_agent_send", "paw_agent_note", "paw_agent_cancel", "paw_agent_close", "paw_agent_approve", "paw_agent_sandbox",
  "factory_answer", "factory_decide", "factory_conversation", "factory_set_parallel",
  "tray_update", "daemon_attach",
  "factory_list", "factory_get", "factory_run", "factory_stop", "factory_retry", "factory_skip", "factory_new", "factory_delete", "factory_set_layout", "factory_pause",
]);
const invoke = (cmd, args) => (DAEMON_COMMANDS.has(cmd) ? tauriInvoke("daemon_call", { cmd, args: args ?? {} }) : tauriInvoke(cmd, args));
const eventHandlers = new Map(); // event → [handler]
const listen = (event, fn) => {
  if (!eventHandlers.has(event)) eventHandlers.set(event, []);
  eventHandlers.get(event).push(fn);
  return tauriListen(event, (e) => { noteDseq(event, e.payload); fn(e); });
};
/** The daemon this window talks to; a tab's process ids only mean something to it. */
const daemon = { instance: null, last: 0 };

/** Remember the newest daemon event a tab has seen (session.json keeps it). */
function noteDseq(event, p) {
  const n = p && typeof p === "object" ? p.__dseq : null;
  if (!n) return;
  const S = sessions.get(event.startsWith("shell:") ? shellToSid.get(p.id) : procToSid.get(p.id));
  if (S && n > (S.dseq ?? 0)) S.dseq = n;
}

/** Events a window missed, through the same handlers, in order. */
function replayEvents(events) {
  for (const ev of events) {
    const payload = ev.payload && typeof ev.payload === "object" ? { ...ev.payload, __dseq: ev.dseq } : ev.payload;
    noteDseq(ev.event, payload);
    for (const fn of eventHandlers.get(ev.event) ?? []) {
      try { fn({ event: ev.event, payload }); } catch (e) { console.error(e); }
    }
  }
}
// Ids inside the session view exist once per pane; they resolve inside the
// pane being rendered (activePane). Everything else is a normal page id.
const PANE_IDS = new Set(["session", "terminal", "output", "xterm-wrap", "xterm-title", "xterm-int", "xterm-back",
  "xterm-hosts", "busy", "busy-spin", "busy-text", "busy-time", "ac", "prompt-line", "att-tray", "input",
  "attach-btn", "input-wrap", "input-backdrop", "mode-pill", "task-split", "task-lower", "task-timeline", "sl-left", "sl-sandbox", "sl-path", "sl-path-text", "sl-plugins", "sl-sessions", "eof", "prompt-glyph", "task-view"]);
let activePane = null;
const $ = (id) => (PANE_IDS.has(id) ? activePane?.root.querySelector(`[data-id="${id}"]`) : document.getElementById(id));
/** The session shown in the pane being rendered (the focused one, normally). */
const curS = () => sessions.get(activePane?.sid);

const sessions = new Map(); // sid -> session
const procToSid = new Map(); // backend process id -> sid
let openTabs = [];
let activeId = null;
let nextSid = 1;
let homeDir = "~";
let settings = { general: { default_cwd: "~", only_installed: true, default_agent: "paw" }, agents: [] };
let detections = {};
let detectionsReady = false;

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tildify = (p) => (p && homeDir && p.startsWith(homeDir) ? "~" + p.slice(homeDir.length) : p);
/** A folder for tight spots (the status bar): `~/…/parent/name` when it's long. */
function shortPath(p, max = 36) {
  const t = tildify(p) ?? "";
  if (t.length <= max) return t;
  const parts = t.split("/");
  const head = parts[0] === "~" ? "~" : "";
  const tail2 = parts.slice(-2).join("/");
  const short = `${head}/…/${tail2}`;
  return short.length <= max + 4 ? short : `…/${parts.at(-1)}`;
}
const basename = (p) => (p === homeDir ? "~" : String(p).split("/").filter(Boolean).pop() || "/");

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------- registry ----------
/** Paw Agent: Paw's own agent, running inside Paw (no process). */
const isPaw = (a) => a?.io === "paw";
const needsModel = (a) => isPaw(a) || /\{model\}/.test(a.template.replace(/\[\[[\s\S]*?\]\]/g, ""));
// Paw Agent speaks the same events as Claude Code's stream-json.
const sessionMode = (a) =>
  a.io === "claude-stream-json" || isPaw(a) ? "claude" : a.template.includes("{prompt}") ? "oneshot" : "stdin";
/** Whether the agent can follow Paw's approval levels (/approval). */
const hasLevels = (a) => isPaw(a) || a.template.includes("{permission}");

function availableAgents() {
  if (!CLI_AGENTS) return settings.agents.filter(isPaw).slice(0, 1);
  // Deprecated: CLI agents (CLI_AGENTS).
  return settings.agents
    .filter((a) => a.enabled && (!settings.general.only_installed || detections[a.id]?.installed))
    .sort((a, b) =>
      (isPaw(a) ? 0 : 1) - (isPaw(b) ? 0 : 1) ||
      (detections[a.id]?.installed ? 0 : 1) - (detections[b.id]?.installed ? 0 : 1) || a.name.localeCompare(b.name));
}
function defaultAgent() {
  const list = availableAgents();
  return list.find((a) => a.id === settings.general.default_agent) ?? list[0] ?? null;
}
function modelsFor(a) {
  if (!CLI_AGENTS) return visibleModels();
  // Deprecated: CLI agents (CLI_AGENTS).
  const list = [...(detections[a.id]?.models ?? [])];
  for (const m of a.custom_models) if (!list.includes(m)) list.push(m);
  if (a.default_model && !list.includes(a.default_model)) list.push(a.default_model);
  return list;
}
function defaultModel(a) {
  if (!CLI_AGENTS) return defaultPawModel();
  // Deprecated: CLI agents (CLI_AGENTS).
  return a.default_model ?? (needsModel(a) ? modelsFor(a)[0] ?? "" : "");
}

// ---------- models ----------
// A model is "provider/model" (anthropic/claude-sonnet-5-5, ollama/qwen3:8b,
// openrouter/anthropic/claude-sonnet-4.6); the model part may hold "/" itself,
// so only the first segment is the provider.
const PROVIDER_NAMES = { anthropic: "Anthropic", copilot: "GitHub Copilot", chatgpt: "ChatGPT", openrouter: "OpenRouter", ollama: "Ollama" };
/** The provider as Settings › Agents lists it (detections.paw.providers), if it does. */
const providerView = (p) => (detections.paw?.providers ?? []).find((v) => v.id === p);
const providerName = (p) => providerView(p)?.name || PROVIDER_NAMES[p] || p;
/** The provider part of a full model id, or "" for a bare id. */
function providerOf(model) {
  const m = String(model ?? "");
  const i = m.indexOf("/");
  const p = i > 0 ? m.slice(0, i) : "";
  return p && (PROVIDER_NAMES[p] || providerView(p)) ? p : "";
}
/** A custom (OpenAI-compatible) provider's settings entry, if `p` is one. */
const customProvider = (p) => (settings.providers?.custom ?? []).find((c) => c.id === p);
/** The model without its provider: claude-sonnet-5-5. */
const modelShort = (model) => (providerOf(model) ? String(model).slice(providerOf(model).length + 1) : String(model ?? ""));
/** Models of the connected providers, minus the ones hidden in Settings. */
function visibleModels() {
  const hidden = new Set(settings.models?.hidden ?? []);
  return (detections.paw?.models ?? []).filter((m) => !hidden.has(m));
}
/** New tabs' model: the one picked in Settings if it's there, else the first one. */
function defaultPawModel() {
  const list = visibleModels();
  const d = settings.models?.default;
  return d && list.includes(d) ? d : list[0] ?? "";
}
/** A saved model: a full id stays; a bare one becomes the first model with that
 *  name; else (or none saved) the default model. */
function savedModel(model) {
  if (providerOf(model)) return model;
  const id = String(model ?? "").trim();
  return (id && (detections.paw?.models ?? []).find((m) => m.endsWith("/" + id))) || defaultPawModel();
}
/** What `/model <id>` and `/new <id>` mean: a full id, or a bare one only one model has. */
function findModel(arg) {
  const want = String(arg ?? "").trim();
  const list = visibleModels();
  if (list.includes(want)) return want;
  const hits = list.filter((m) => modelShort(m) === want);
  return hits.length === 1 ? hits[0] : null;
}
/** Visible models by provider, in the providers' order: [[provider, [models]]]. */
function modelsByProvider() {
  const byProvider = new Map();
  for (const m of visibleModels()) {
    const p = providerOf(m);
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(m);
  }
  return [...byProvider];
}
/** /model: the models by provider, `cur` marked. */
function modelListHtml(cur) {
  const groups = modelsByProvider();
  if (!groups.length) return `<span class="dim">${tx("No models yet: connect a provider in {link}.", { link: `</span>${connectLink()}<span class="dim">` })}</span>`;
  const out = [];
  if (cur && !visibleModels().includes(cur)) out.push(`<span class="ok">● ${esc(cur)}</span>  <span class="dim">${tx("this tab's (hidden, or its provider isn't connected)")}</span>`, "");
  for (const [p, list] of groups) {
    if (out.length && out.at(-1) !== "") out.push("");
    out.push(`<span class="help-h">${esc(providerName(p))}</span>`);
    for (const m of list) out.push(m === cur ? `<span class="ok">● ${esc(m)}</span>` : `<span class="dim">○</span> ${esc(m)}`);
  }
  return out.join("\n");
}
/** Why `/model <arg>` found nothing. */
function modelMiss(arg) {
  const hits = visibleModels().filter((m) => modelShort(m) === arg.trim());
  return hits.length > 1 ? tx("✗ “{arg}” is offered by more than one provider: write {models}", { arg, models: hits.join(tx(" or ")) }) : tx("✗ no model “{arg}” here", { arg });
}
/** "Connect a provider" links open Settings › Agents. */
const connectLink = (text = tx("Settings › Agents")) => `<a href="#" class="task-link" data-open-prefs="agents">${esc(text)}</a>`;
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-open-prefs]");
  if (!a) return;
  e.preventDefault();
  invoke("open_preferences", { tab: a.dataset.openPrefs });
});

// ---------- sessions ----------
const isRunning = (S) => S.info?.status === "running";
const agentBusy = (S) => isRunning(S) && (S.mode === "claude" ? S.busy : S.mode === "oneshot");
const isBusy = (S) => agentBusy(S) || !!S.shellBusy;

function sessionState(S) {
  // A factory node's tab: how its node is doing (it has no agent of its own).
  if (S.nodeOf) { const r = nodeRunOf(S); return r?.question || r?.gate ? "ready" : r?.state === "running" ? "running" : "idle"; }
  if (isBusy(S)) return "running";
  if (S.terminalOnly) return "ready"; // no agent yet: a terminal
  if (S.mode === "oneshot") return S.info && S.info.status === "failed" ? "failed" : "idle";
  if (!S.info) return "starting";
  return isRunning(S) ? "ready" : S.info.status;
}

function pushLine(S, line) {
  S.lines.push(line);
  if (S.lines.length > 10000) S.lines.shift();
  trackShellContext(S, line);
  inPane(S, () => appendLine(S, line));
  saveWorkspaceSoon();
}
const sys = (S, text) => pushLine(S, { stream: "system", text, ts: Date.now() });
const info = (S, html) => pushLine(S, { stream: "info", html, ts: Date.now() });

// ---------- session folders ----------
// Every tab has an id and a folder, ~/.paw/session/<id>: its state
// (session.json), Paw Agent's conversations, copies of attached and pasted
// files (files/), helper scripts the agents write (scripts/), a log of
// every command run in it, yours and the agent's (commands.log), and the
// command its agent was last started with (launch.sh).

/** A tab's id: 8 hex characters, not used by an open or stored session. */
function newPawId() {
  const taken = new Set([...sessions.values()].map((S) => S.pawId).concat(archive.ids ?? []));
  for (;;) {
    const id = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0");
    if (!taken.has(id)) return id;
  }
}
/** The tab's folder (created on first use). */
async function sessionDir(S) {
  S.sessionDir ??= await invoke("session_dir", { id: S.pawId }).catch(() => null);
  return S.sessionDir;
}
const stampNow = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
/** One entry in commands.log: when, who, how it went, the command. */
function logCommand(S, who, outcome, command) {
  const cmd = String(command).trim().replace(/\n/g, "\n" + " ".repeat(37));
  const line = `${stampNow()}  ${who.padEnd(6)} ${String(outcome).padEnd(9)} ${cmd}`;
  invoke("session_log", { id: S.pawId, text: line }).catch(() => {});
}
/** Shell commands the agent ran (Bash / shell tool calls), logged when their result comes. */
const SHELL_TOOLS = new Set(["Bash", "shell", "run_shell_command", "bash"]);
function logAgentCommands(S, text) {
  if (!text.startsWith('{"type":"assistant"') && !text.startsWith('{"type":"user"')) return;
  let ev;
  try { ev = JSON.parse(text); } catch { return; }
  for (const c of ev.message?.content ?? []) {
    if (c.type === "tool_use" && SHELL_TOOLS.has(c.name) && c.input?.command) (S.toolCmds ??= new Map()).set(c.id, c.input.command);
    if (c.type === "tool_result" && S.toolCmds?.has(c.tool_use_id)) {
      logCommand(S, "agent", c.is_error ? "error" : "ok", S.toolCmds.get(c.tool_use_id));
      S.toolCmds.delete(c.tool_use_id);
    }
  }
}
/** Claude Code: the scripts folder is one it may write to, and it's told what it's for.
 *  Deprecated: CLI agents (CLI_AGENTS). */
async function scriptsArgs(S) {
  if (S.agent.io !== "claude-stream-json") return "";
  const dir = await sessionDir(S);
  if (!dir) return "";
  const scripts = `${dir}/scripts`;
  const note = `Scripts folder for this session: ${scripts}\nWrite one-off helper scripts (anything that isn't part of the project) there, not into the working folder, and run them from there.`;
  return ` --add-dir ${shq(scripts)} --append-system-prompt ${shq(note)}`;
}

/** opts: cwd, model, approval; background (don't switch to it), after (a task
 *  tab: open right after it and its steps); task / stepOf (see tasks.js). */
async function newSession(agentId, opts = {}) {
  closeMenu();
  // Without CLI agents every tab runs Paw Agent, whatever agent was asked for.
  const agent = agentId && CLI_AGENTS ? settings.agents.find((a) => a.id === agentId) : defaultAgent();
  if (!agent) {
    invoke("open_preferences", { tab: "agents" });
    return null;
  }
  let cwd = opts.cwd ?? settings.general.default_cwd ?? "~";
  try { cwd = await invoke("resolve_dir", { path: cwd, base: homeDir }); } catch { cwd = homeDir; }

  const S = {
    sid: nextSid++,
    pawId: newPawId(),
    createdAt: Date.now(),
    agent: structuredClone(agent),
    mode: sessionMode(agent),
    cwd,
    model: opts.model ?? defaultModel(agent),
    approval: defaultApproval(agent),
    proc: null,
    info: null,
    lines: [],
    busy: false,
    history: [],
    histIdx: 0,
    draft: "",
    unread: 0,
    shell: null, // id of this tab's background PTY shell
    shellBusy: false,
    inputMode: settings.general.input_mode || "auto", // auto | shell | agent
  };
  if (opts.approval) S.approval = opts.approval;
  if (opts.task) S.task = opts.task;
  if (opts.factory) S.factory = opts.factory;
  if (opts.stepOf) S.stepOf = opts.stepOf;
  if (opts.nodeOf) S.nodeOf = opts.nodeOf; // a factory node's session: its agent is the node's
  // A fork: the tab it comes from, its conversation so far (a copy), and how it was set up.
  const F = opts.fork;
  if (F) {
    S.lines = structuredClone(F.lines ?? []);
    S.history = [...(F.history ?? [])];
    S.histIdx = S.history.length;
    S.turns = structuredClone(F.turns ?? []);
    S.inputMode = F.inputMode ?? S.inputMode;
    if (F.sandboxMode) S.sandboxMode = F.sandboxMode;
    if (F.sandboxPrograms?.length) S.sandboxPrograms = [...F.sandboxPrograms];
    if (F.session) {
      try {
        S.session = await invoke("paw_agent_fork_conversation", { from: F.pawId, conversation: F.session, to: S.pawId });
      } catch (e) {
        S.lines.push({ stream: "system", ts: Date.now(), text: `✗ ${e}` });
      }
    }
    S.lines.push({ stream: "system", ts: Date.now(), text: tx("— forked from “{tab}”: the conversation so far comes along; from here on, each tab goes its own way.", { tab: tabLabel(F) }) });
    // Told apart from the tab it comes from (Rename… changes it).
    S.title = tx("{tab} (fork)", { tab: tabLabel(F) });
  }
  sessions.set(S.sid, S);
  openTabs.splice(opts.after ? tabInsertIndex(opts.after) : openTabs.length, 0, S.sid);
  // A task and its steps are a group; a step joins its task's.
  if (opts.task) ensureTaskGroup(S);
  if (opts.stepOf && opts.after) addToGroup(S, ensureTaskGroup(opts.after), false);
  if (!F) banner(S);
  if (opts.background) { renderTabs(); saveWorkspaceSoon(); } else select(S.sid);
  openShell(S);
  // A fork's agent goes on from the copy of the conversation.
  if (S.mode !== "oneshot" && !S.nodeOf) await startProc(S, undefined, { resume: !!(F && S.session) });
  return S;
}

function banner(S) {
  if (S.nodeOf) return;
  if (S.task) return taskBanner(S);
  if (S.factory) return factoryBanner(S);
  const d = detections[S.agent.id];
  const ver = isPaw(S.agent) ? ` <span class="dim">${tx("built-in")}${providerOf(S.model) ? " · " + esc(providerName(providerOf(S.model))) : ""}</span>`
    : d?.version ? ` <span class="dim">${esc(d.version)}</span>` : "";
  info(S,
    `<b>${esc(S.agent.name)}</b>${ver}\n` +
    `<span class="dim">${tx("model")}</span> ${esc(S.model || (isPaw(S.agent) ? tx("none") : tx("default")))}  <span class="dim">cwd</span> ${esc(tildify(S.cwd))}\n` +
    `<span class="dim">${S.mode === "oneshot" ? tx("Each prompt runs the agent once in this folder.") : tx("Type a prompt to start.")} ` +
    `${tx("Shell commands (<span class=\"sh\">$</span> ls, git status…) run in your shell. /help for more.")}</span>`);
}

const shq = (s) => (/^[\w\-./:=@+,]+$/.test(s) ? s : "'" + s.replace(/'/g, `'\\''`) + "'");

async function startProc(S, prompt, { resume = false } = {}) {
  if (S.nodeOf) { refresh(S); return; } // a factory node's tab runs no agent of its own
  if (isPaw(S.agent)) return pawStart(S, { resume });
  // Deprecated: CLI agents (CLI_AGENTS). Tabs only run Paw Agent while they're off.
  if (!CLI_AGENTS) { sys(S, tx("✗ CLI agents are turned off in this build.")); refresh(S); return; }
  try {
    // Which session to continue: a long-lived agent only when asked to resume
    // (restart, /model…); a one-shot agent on every prompt after the first.
    const useSession = S.agent.continuity === "session" && S.session && (resume || S.mode === "oneshot");
    let command = await invoke("render_command", {
      agent: S.agent,
      prompt: prompt ?? "",
      model: S.model,
      permission: approvalValue(S),
      session: useSession ? S.session : "",
    });
    command += allowArgs(S);
    command += await skillsArgs(S);
    command += await scriptsArgs(S);
    if (!useSession) S.skillsNoteSig = null; // a new conversation hasn't heard of any skills
    S.runWithSession = !!useSession;
    S.resuming = !!useSession; // cleared once the agent reports the session id
    S.runStarted = Date.now();
    S.runLines = [];
    S.runOut = []; // stdout only: a one-shot agent's answer
    // The agent runs with its own configuration, in the tab's folder — so its
    // skills, instructions and settings load exactly as on the command line.
    // A new tab never passes a session to resume: it is a brand-new conversation.
    const dir = await sessionDir(S);
    const pinfo = await invoke("spawn_agent", {
      name: `${S.agent.name} — ${basename(S.cwd)}`, command, cwd: S.cwd, noStdin: S.mode === "oneshot",
      env: dir ? { PAW_SESSION_DIR: dir } : null,
    });
    invoke("session_launch", { id: S.pawId, cwd: S.cwd, command }).catch(() => {});
    logCommand(S, "paw", "started", `${S.agent.name} (the command is in launch.sh)`);
    S.proc = pinfo.id;
    S.info = pinfo;
    S.agentCwd = S.cwd;
    procToSid.set(pinfo.id, S.sid);
    if (S.mode === "oneshot") S.busySince = Date.now();
  } catch (e) {
    sys(S, `✗ ${e}`);
  }
  refresh(S);
}

async function stopProc(S, force = false) {
  if (!isRunning(S)) return;
  if (isPaw(S.agent)) await invoke("paw_agent_close", { id: S.proc }).catch(() => {});
  else if (CLI_AGENTS) await invoke("stop_agent", { id: S.proc, force }); // Deprecated: CLI agents (CLI_AGENTS).
}

// ---------- Paw Agent ----------
// A session lives in the Paw process. Its conversation is saved there after
// every prompt (by S.session), so restarts and a new Paw continue it.
async function pawStart(S, { resume = false } = {}) {
  // A tab opened (or restored) before any provider was connected takes the default model now.
  if (!S.model) S.model = defaultPawModel();
  if (!S.model) {
    // No provider yet: the tab is a terminal (Paw is one first); every line
    // goes to its shell until a provider is connected (agentsAvailable).
    if (!S.terminalOnly) {
      S.terminalOnly = true;
      S.modeBefore = S.inputMode;
      S.inputMode = "shell";
      info(S, `<span class="dim">${tx("No agent yet, so this tab is a terminal: every line runs in the shell. Connect a provider in {link} and Paw Agent starts here.", { link: `</span>${connectLink()}<span class="dim">` })}</span>`);
    }
    inPane(S, () => { renderModePill(); updateGlyph(); renderHeader(); });
    refresh(S);
    return;
  }
  S.terminalOnly = false;
  try {
    const ext = await externalSetup();
    S.skillsSig = ext.signature; // its system prompt lists the skills
    const saved = (settings.allow_rules ?? []).filter((r) => r.agent === S.agent.id && r.folder === S.cwd).map((r) => r.rule);
    const provider = providerOf(S.model) || "ollama";
    const reply = await invoke("paw_agent_start", { opts: {
      name: `${S.agent.name} — ${basename(S.cwd)}`,
      provider,
      model: S.model,
      base_url: (customProvider(provider) ? customProvider(provider).base_url : settings.providers?.[provider]?.base_url) || "",
      cwd: S.cwd,
      approval: S.approval,
      allow_rules: saved,
      sandbox: (S.sandboxStarted = tabSandbox(S)),
      session: resume && S.session ? S.session : null,
      key_source: settings.providers?.anthropic?.key_source || "",
      paw_session: S.pawId,
    } });
    const { lines, session, ...pinfo } = reply;
    S.runWithSession = !!(resume && S.session);
    S.resuming = false;
    S.proc = pinfo.id;
    S.info = pinfo;
    S.agentCwd = S.cwd;
    procToSid.set(pinfo.id, S.sid);
    if (session && session !== S.session) { S.session = session; saveWorkspaceSoon(); }
    // Its first lines (init with the conversation id) come with the reply.
    for (const l of lines ?? []) onAgentOutput(l);
  } catch (e) {
    sys(S, `✗ ${e}`);
  }
  refresh(S);
}

listen("paw:delta", ({ payload: d }) => {
  const S = sessions.get(procToSid.get(d.id));
  if (!S || S.proc !== d.id) return;
  S.partial = d.text || null;
  S.partialMd = true;
  inPane(S, () => renderPartial(S));
});

// ---------- the sandbox ----------
/** A tab's sandbox: Settings' policy, turned on or off for this tab, with the programs allowed in it. */
function tabSandbox(S) {
  const p = structuredClone(settings.sandbox ?? {});
  if (S.sandboxMode === "on") p.enabled = true;
  else if (S.sandboxMode === "off") p.enabled = false;
  if (S.sandboxPrograms?.length) p.programs = [...new Set([...(p.programs ?? []), ...S.sandboxPrograms])];
  return p;
}

/** The sandbox in a few words (the status-bar button's tooltip). */
function sandboxSummary(p) {
  const programs = p.any_program !== false ? tx("any program") : tx("{n} programs", { n: (p.programs ?? []).length });
  const net = p.network === "off" ? tx("no network") : p.network === "listed" ? tx("network for {list}", { list: (p.network_programs ?? []).join(", ") }) : tx("network");
  const extra = (p.write ?? []).length ? ` · ${tx("also writes {list}", { list: p.write.join(", ") })}` : "";
  return tx("Sandbox: changes only in its folder{extra} · {programs} · {net}", { extra, programs, net });
}

/** A factory node's sandbox: its factory's (the file's section over Settings'), else Settings'. */
function nodeSandbox(S) {
  const def = factoryState.runs.get(S.nodeOf.run)?.def ?? factoryById(S.nodeOf.factory)?.factory;
  return def?.sandbox ? factorySandbox(def.sandbox) : settings.sandbox ?? {};
}

function renderSandboxPill(S) {
  const b = $("sl-sandbox");
  if (!b) return;
  const show = isPaw(S.agent);
  b.classList.toggle("hidden", !show);
  if (!show) return;
  // A factory node's tab: its factory's sandbox, shown (set in the factory, not here).
  if (S.nodeOf) {
    const p = nodeSandbox(S);
    b.classList.toggle("on", !!p.enabled);
    b.textContent = p.enabled ? tx("Sandbox") : tx("No sandbox");
    b.title = (p.enabled ? sandboxSummary(p) : tx("This factory's nodes run without a sandbox.")) + "\n" +
      tx("Set by the factory: the sandbox section in its file, else Settings › Sandbox.");
    return;
  }
  const p = runningSandbox(S);
  b.classList.toggle("on", !!p.enabled);
  b.textContent = p.enabled ? tx("Sandbox") : tx("No sandbox");
  const changed = S.sandboxStarted && !S.sandboxMode && !!settings.sandbox?.enabled !== !!p.enabled;
  b.title = (p.enabled ? sandboxSummary(p) : tx("Paw Agent runs without a sandbox in this tab. Click to turn it on.")) +
    (changed ? "\n" + tx("Settings › Sandbox has changed since this tab started: new tabs get the new setting, this one keeps its own.") : "");
  // A factory's tab: this is the agent that changes its file, not its nodes.
  if (S.factory) b.title = tx("The Paw Agent of this tab, which changes the factory's file (its nodes' sandbox is on the boxes and in the summary):") + "\n" + b.title;
}

/** The sandbox this tab's agent runs with (it keeps it when Settings change),
 *  or will start with. */
const runningSandbox = (S) => (S.proc != null && S.sandboxStarted ? S.sandboxStarted : tabSandbox(S));

/** The status-bar button: this tab's sandbox on or off (the conversation goes on), or Settings. */
/** The tab's sandbox on, or off (the conversation continues). */
async function toggleTabSandbox(S) {
  const on = !!runningSandbox(S).enabled;
  S.sandboxMode = on ? "off" : "on";
  saveWorkspaceSoon();
  await restart(S, on ? tx("sandbox off · conversation continues") : tx("sandbox on · conversation continues"), { resume: true });
  renderHeader();
}

function sandboxMenu(e) {
  const S = curS();
  if (!S) return;
  // A node's sandbox is its factory's: where to change it.
  if (S.nodeOf) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.top - 60, [
      { label: tx("Open the factory"), run: () => openFactory(S.nodeOf.factory) },
      { label: tx("Settings › Sandbox…"), run: () => invoke("open_preferences", { tab: "sandbox" }) },
    ]);
    return;
  }
  const on = !!runningSandbox(S).enabled;
  const r = e.currentTarget.getBoundingClientRect();
  contextMenu(r.left, r.top - 90, [
    { label: on ? tx("Turn the sandbox off in this tab") : tx("Turn the sandbox on in this tab"), run: () => toggleTabSandbox(S) },
    { label: tx("Settings › Sandbox…"), run: () => invoke("open_preferences", { tab: "sandbox" }) },
  ]);
}

// Paw Agent's sandbox stopped something: say so, and offer to allow it.
listen("paw:sandbox", ({ payload: e }) => {
  const S = sessions.get(procToSid.get(e.id));
  if (!S || S.proc !== e.id) return;
  // A factory node's tab: its sandbox is the factory's (its file, or Settings').
  if (S.nodeOf) {
    info(S, `<span class="sb-blocked">${e.program ? tx("Blocked by the sandbox: {program} isn't on the list of programs this tab may run.", { program: `<code>${esc(e.program)}</code>` })
      : tx("Blocked by the sandbox: {path} is outside the folders this tab may change.", { path: `<code>${esc(tildify(e.path ?? ""))}</code>` })}</span> <span class="dim">${tx("Allow it in the factory's sandbox section, or in Settings › Sandbox.")}</span>`);
    return;
  }
  if (e.program) {
    info(S, `<span class="sb-blocked">${tx("Blocked by the sandbox: {program} isn't on the list of programs this tab may run.", { program: `<code>${esc(e.program)}</code>` })}</span>` +
      ` <span class="sb-acts"><button class="tk-btn" data-sb-allow="${esc(e.program)}">${tx("Allow in this tab")}</button><button class="tk-btn" data-sb-add="${esc(e.program)}">${tx("Add to the list")}</button></span>`);
  } else if (e.path) {
    info(S, `<span class="sb-blocked">${tx("Blocked by the sandbox: {path} is outside the folders this tab may change.", { path: `<code>${esc(tildify(e.path))}</code>` })}</span>` +
      ` <span class="sb-acts"><button class="tk-btn" data-sb-settings>${tx("Settings › Sandbox…")}</button></span>`);
  }
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-sb-allow], [data-sb-add], [data-sb-settings]");
  if (!b) return;
  const S = curS();
  if (b.dataset.sbSettings !== undefined) { invoke("open_preferences", { tab: "sandbox" }); return; }
  if (!S) return;
  const program = b.dataset.sbAllow ?? b.dataset.sbAdd;
  const acts = b.closest(".sb-acts");
  if (b.dataset.sbAllow) {
    S.sandboxPrograms = [...new Set([...(S.sandboxPrograms ?? []), program])];
    saveWorkspaceSoon();
  } else {
    settings.sandbox ??= {};
    settings.sandbox.programs ??= [];
    if (!settings.sandbox.programs.includes(program)) settings.sandbox.programs.push(program);
    await invoke("save_settings", { settings }).catch(() => {});
  }
  if (S.proc != null) await invoke("paw_agent_sandbox", { id: S.proc, program }).catch(() => {});
  if (acts) acts.innerHTML = `<span class="dim">${esc(b.dataset.sbAllow ? tx("{program} may run in this tab now: ask Paw Agent to try again.", { program })
    : tx("{program} is on the list now (Settings › Sandbox): ask Paw Agent to try again.", { program }))}</span>`;
  renderHeader();
});

listen("paw:approval", ({ payload: r }) => {
  const S = sessions.get(procToSid.get(r.id));
  if (!S || S.proc !== r.id) return;
  S.waitingApproval = (S.waitingApproval ?? 0) + 1;
  addApprovalCard(S, { kind: "paw", proc: r.id, request: r.request, tool: r.tool, canAllow: true,
    items: [{ label: r.label, rule: r.rule, broad: r.broad, detail: r.detail, why: r.why }] });
  refresh(S);
});

/** Cards of a turn that ended (or of an earlier run) can't be answered any more. */
function expirePawCards(S) {
  let n = 0;
  for (const l of S.lines) if (l.stream === "approval" && l.kind === "paw" && l.state === "pending") { l.state = "expired"; n++; }
  S.waitingApproval = 0;
  if (n) { inPane(S, renderOutput); saveWorkspaceSoon(); }
}

/** Restart the agent process. `resume` continues the Claude conversation;
 *  it's off after /cd because Claude stores sessions per project folder. */
async function restart(S, reason, { resume = true, quiet = false } = {}) {
  if (quiet && S.proc != null) (S.quietProcs ??= new Set()).add(S.proc);
  await stopProc(S);
  S.busy = false;
  if (!resume) { S.session = null; S.turns = []; }
  if (reason) sys(S, reason);
  if (S.mode !== "oneshot") await startProc(S, undefined, { resume });
  else refresh(S);
}

// ---------- forking a tab ----------
/** A new tab next to this one, going on from its conversation (a copy): the
 *  same model, folder and sandbox, its transcript and prompt history; from
 *  there each tab goes its own way. Plain Paw Agent tabs only. */
async function forkTab(F) {
  if (!F) return null;
  if (!isPaw(F.agent) || F.nodeOf || F.factory || F.task || F.stepOf) {
    sys(F, tx("Only a Paw Agent tab can be forked, not a plan's, a factory's or a factory node's."));
    return null;
  }
  if (F.working || isBusy(F)) {
    sys(F, tx("{name} is still answering: fork the tab once it's done.", { name: F.agent.name }));
    return null;
  }
  const T = await newSession("paw", { cwd: F.cwd, model: F.model, approval: F.approval, after: F, fork: F });
  if (T && F.group && groups.has(F.group)) addToGroup(T, F.group, false);
  return T;
}
const canFork = (S) => !!S && isPaw(S.agent) && !S.nodeOf && !S.factory && !S.task && !S.stepOf && !S.working && !isBusy(S);

// ---------- "Are you sure…?" in the tab ----------
// Destructive actions ask in the tab, not in a dialog: the question with Yes
// and No under it. y / n (+ Enter) in the prompt answer it too, Esc says no.
const sureAsks = new Map(); // id -> { S, line, resolve }
let sureSeq = 0;

/** Ask in tab S (shown first), or the current one; resolves true for Yes. */
function askSure(question, { S = curS(), yes = tx("Yes"), detail = "" } = {}) {
  if (!S) return Promise.resolve(confirm(question + (detail ? `\n\n${detail}` : "")));
  if (S !== curS()) select(S.sid);
  // One question at a time in a tab: a new one answers the old one with no.
  for (const [id, a] of sureAsks) if (a.S === S) answerSure(id, false);
  const id = `s${++sureSeq}`;
  const line = { stream: "info", ts: Date.now(), html: "" };
  line.html = sureHtml(id, question, detail, yes);
  return new Promise((resolve) => {
    sureAsks.set(id, { S, line, resolve, question, detail, yes });
    pushLine(S, line);
    $("input")?.focus();
  });
}

function sureHtml(id, question, detail, yes, answer) {
  const q = `<span class="sure-q">${esc(tx("Are you sure?"))}</span> ${esc(question)}` + (detail ? `\n<span class="dim">${esc(detail)}</span>` : "");
  if (answer !== undefined) return `<span class="sure" data-sure-done>${q}\n<span class="dim">${answer ? `→ ${esc(yes)}` : `→ ${esc(tx("No: nothing changed."))}`}</span></span>`;
  return `<span class="sure" data-sure="${id}">${q}\n<span class="sb-acts sure-acts"><button class="tk-btn danger" data-sure-yes="${id}">${esc(yes)}</button><button class="tk-btn" data-sure-no="${id}">${esc(tx("No"))}</button></span> <span class="dim">${esc(tx("or type y / n"))}</span></span>`;
}

function answerSure(id, yes) {
  const a = sureAsks.get(id);
  if (!a) return false;
  sureAsks.delete(id);
  a.line.html = sureHtml(id, a.question, a.detail, a.yes, yes);
  const el = document.querySelector(`[data-sure="${id}"]`);
  if (el) el.outerHTML = a.line.html;
  saveWorkspaceSoon();
  a.resolve(yes);
  return true;
}

/** The question waiting in tab S, if any. */
const sureIn = (S) => [...sureAsks].find(([, a]) => a.S === S)?.[0];

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-sure-yes], [data-sure-no]");
  if (!b) return;
  const id = b.dataset.sureYes ?? b.dataset.sureNo;
  // From before a restart: nothing waits on it any more.
  if (!answerSure(id, b.dataset.sureYes !== undefined)) b.closest(".sure-acts")?.replaceWith(Object.assign(document.createElement("span"), { className: "dim", textContent: tx("(no longer asked)") }));
});

async function closeSession(sid) {
  const S = sessions.get(sid);
  if (!S) return;
  if (isBusy(S) && !await askSure(tx("{name} is still working. Close the tab and stop it?", { name: S.agent.name }), { S, yes: tx("Close and stop") })) return;
  if (S.task?.state === "running" && !await askSure(tx("This plan is running. Close it and stop its steps? Their tabs stay open."), { S, yes: tx("Close and stop") })) return;
  if (!sessions.has(sid)) return;
  if (sureIn(S)) answerSure(sureIn(S), false);
  taskTabClosing(S);
  closeBoardView(S);
  keepClosedSession(S);
  dropWaiting(S);
  if (S.working) { S.working = false; setTimeout(pumpAgents, 0); }
  // A factory node's agent belongs to its run: closing the tab leaves it be.
  if (S.proc != null && !S.nodeOf) invoke(isPaw(S.agent) ? "paw_agent_close" : "remove_agent", { id: S.proc }).catch(() => {});
  disposeTerm(S);
  if (S.shell != null) { invoke("shell_close", { id: S.shell }); shellToSid.delete(S.shell); }
  const P = paneOf(S);
  sessions.delete(sid);
  saveWorkspaceSoon();
  const idx = openTabs.indexOf(sid);
  openTabs.splice(idx, 1);
  dropEmptyGroups();
  if (P && panes.size > 1) {
    // Closing a session in a split closes its pane.
    P.sid = null;
    removePane(P);
  } else if (P) {
    focusPane(P, false);
    // The next tab, preferring ones not folded away in a group.
    const order = openTabs.slice(Math.min(idx, openTabs.length - 1)).concat(openTabs).filter((t) => !paneOf(sessions.get(t)));
    const folded = (t) => groups.get(sessions.get(t)?.group)?.collapsed;
    const next = order.find((t) => !folded(t)) ?? order[0];
    select(next ?? null);
  } else { renderTabs(); renderSidebar(); }
}

// ---------- input ----------
async function submit(text) {
  const S = curS();
  if (!S || (!text.trim() && !S.attachments?.length)) return;
  // Badges in the text become their references ("[shot.png]"): what history,
  // commands and agents see. Pasted text and paths go in at them later.
  text = tokensToRefs(text, S.attachments ?? []);
  // A line typed while a shell command runs is input for it (y/N, a
  // password…): it stays out of history, which is saved and shown by ⌃R.
  const forRunning = S.shellBusy && !text.startsWith("/");
  if (!forRunning && text.trim() && S.history[S.history.length - 1] !== text) S.history.push(text);
  S.histIdx = S.history.length;
  S.draft = "";

  if (text.startsWith("/") && (await slashCommand(S, text.trim()))) return;

  // A shell command is still running: the line is input for it.
  if (S.shellBusy) {
    await invoke("shell_write", { id: S.shell, text }).catch((e) => sys(S, `✗ ${e}`));
    return;
  }
  let route = routeFor(S, text);
  if (!route.shell && S.inputMode === "auto" && (await lookupFirstWord(S, text))) route = routeFor(S, text);
  // Attachments only, no text, or pasted text: that's for the agent.
  const typed = (S.attachments ?? []).reduce((t, a) => t.split(refOf(a)).join(""), text);
  if (!typed.trim() || S.attachments?.some(isPasted)) route = { shell: false };
  // No agent yet (a terminal tab): a line for it stays in the prompt.
  if (!route.shell && S.terminalOnly && !S.task && !S.factory) {
    sys(S, tx("There's no agent to send this to yet: connect a provider in Settings › Agents. (Your line is back in the prompt.)"));
    inPane(S, () => { $("input").value = text; autosize(); });
    return;
  }
  const atts = takeAttachments(S);
  if (route.shell) {
    // Like dropping files into a terminal: each badge becomes its quoted
    // path where it is; any without a place go at the end.
    let cmd = route.command;
    const rest = [];
    for (const a of atts) {
      if (a.token && cmd.includes(refOf(a))) cmd = cmd.split(refOf(a)).join(shq(a.path));
      else rest.push(a);
    }
    await runShell(S, [cmd, ...rest.map((a) => shq(a.path))].join(" "));
    return;
  }
  if (S.task) return taskSubmit(S, text, atts);
  if (S.factory) return factorySubmit(S, text, atts);
  await sendToAgent(S, text, atts);
}

/** opts.wrap(text): what the agent gets around the text you see (tasks add their context). */
// ---------- agents at once ----------
// Settings › General › Agents at once: how many agents may work at the same
// time, across tabs and task steps. A prompt beyond it waits its turn and
// starts when one finishes; task steps wait the same way (prompts you typed
// go first). A tab "works" from sending a prompt until its turn ends.

const waitingPrompts = []; // { S, text, atts, opts, since }
const maxAgents = () => { const n = Number(settings.general.max_agents ?? 3); return n > 0 ? n : Infinity; };
/** Agents working now: tabs mid-turn, and task steps whose tab isn't working yet. */
function agentsWorking() {
  let n = 0;
  for (const S of sessions.values()) if (S.working) n++;
  for (const T of sessions.values()) {
    if (!T.task) continue;
    for (const st of T.task.steps) if (activeStep(st) && !sessions.get(st.sid)?.working) n++;
  }
  return n;
}
const atCapacity = () => agentsWorking() >= maxAgents();

/** A turn ended (or never started): free its slot and start what waits. */
function turnFinished(S) {
  if (!S.working) return;
  S.working = false;
  setTimeout(pumpAgents, 0);
}

/** Start waiting prompts (oldest first), then task steps, while there's room. */
function pumpAgents() {
  for (let i = 0; i < waitingPrompts.length && !atCapacity(); ) {
    const w = waitingPrompts[i];
    if (!sessions.has(w.S.sid)) { waitingPrompts.splice(i, 1); continue; }
    if (w.S.working) { i++; continue; } // its own tab is still busy: wait for it
    waitingPrompts.splice(i, 1);
    sendToAgent(w.S, w.text, w.atts, { ...w.opts, slot: true });
    inPane(w.S, renderBusy);
  }
  for (const T of sessions.values()) if (T.task?.state === "running") taskPump(T);
}

/** Drop a tab's waiting prompts (⌘., closing it). Returns how many. */
function dropWaiting(S) {
  let n = 0;
  for (let i = waitingPrompts.length - 1; i >= 0; i--) if (waitingPrompts[i].S === S) { waitingPrompts.splice(i, 1); n++; }
  return n;
}

async function sendToAgent(S, text, atts = [], opts = {}) {
  if (S.nodeOf) return nodeSessionSend(S, text);
  // Too many agents working: this prompt waits its turn.
  if (!opts.slot && !S.working && atCapacity()) {
    waitingPrompts.push({ S, text, atts, opts, since: Date.now() });
    const n = agentsWorking();
    sys(S, tx(n === 1 ? "⏳ waiting: {n} agent is working (Settings › General › Agents at once: {max}). This prompt starts when one finishes; ⌘. drops it." : "⏳ waiting: {n} agents are working (Settings › General › Agents at once: {max}). This prompt starts when one finishes; ⌘. drops it.", { n, max: maxAgents() }));
    inPane(S, renderBusy);
    return;
  }
  S.working = true;
  pluginEvent("prompt", { tab: pluginTab(S), text });
  // Pasted text badges go along as text after what was typed; files as files.
  const pasted = atts.filter(isPasted);
  atts = atts.filter((a) => !isPasted(a));
  const body = withPasted(text, pasted);
  const echoed = [...atts, ...pasted];
  const skillNote = await syncExternalSkills(S);
  const ctx = takeShellContext(S);
  const full = [skillNote.text, ctx.text, opts.wrap ? opts.wrap(body) : body].filter(Boolean).join("\n\n");
  S.lastAnswer = "";
  // This prompt's tokens and time (working line, done line, /stats).
  S.turnUsage = null;
  S.msgUsage = new Map();
  S.turnStarted = Date.now();
  renderAttachments();
  // Deprecated: CLI agents (CLI_AGENTS). One-shot CLIs run once per prompt.
  if (CLI_AGENTS && S.mode === "oneshot") {
    if (isRunning(S)) {
      sys(S, tx("still running — wait for it to finish, or ⌘. to stop"));
      return;
    }
    // Changed folder: like Claude, every agent starts a new conversation there.
    if (S.agentCwd && S.agentCwd !== S.cwd && (S.session || S.turns?.length)) {
      S.session = null;
      S.turns = [];
      sys(S, tx("folder changed to {folder} · new conversation", { folder: tildify(S.cwd) }));
    }
    pushLine(S, { stream: "stdin", text, attachments: echoed, shared: ctx.count, skills: skillNote.count, ts: Date.now(), turn: newTurn(S) });
    const prompt = S.agent.continuity === "replay" ? withReplay(S, full) : full;
    if (S.agent.continuity === "replay") (S.turns ??= []).push({ user: body, assistant: "", open: true });
    S.lastPrompt = withPaths(full, atts);
    await startProc(S, withPaths(prompt, atts));
    if (!isRunning(S)) turnFinished(S);
    skillNote.sent();
    return;
  }

  // The shell moved (cd) since the agent started: follow it. Paw Agent keeps
  // its conversation (its sandbox moves with it); Claude keeps conversations
  // per folder, so a CLI agent starts a fresh one.
  if (isRunning(S) && S.agentCwd && S.agentCwd !== S.cwd) {
    const keep = isPaw(S.agent);
    await restart(S, keep ? tx("agent moved to {folder} (conversation continues)", { folder: tildify(S.cwd) })
      : tx("agent moved to {folder} (new conversation)", { folder: tildify(S.cwd) }), { resume: keep });
    if (keep && isRunning(S)) invoke("paw_agent_note", { id: S.proc, text: `The user moved this session to ${S.cwd}: work there from now on.` }).catch(() => {});
  }
  if (!isRunning(S)) {
    sys(S, tx("agent was not running — starting it"));
    await startProc(S);
    if (!isRunning(S)) { turnFinished(S); return; }
  }
  // Echo the prompt (with its attachments) ourselves; the backend's copy of
  // the stdin line would carry the raw JSON / image data.
  pushLine(S, { stream: "stdin", text, attachments: echoed, shared: ctx.count, skills: skillNote.count, ts: Date.now(), turn: newTurn(S) });
  if (isPaw(S.agent)) {
    S.busy = true;
    S.busySince = Date.now();
    refresh(S);
    try {
      // Attached files go as paths; the agent reads them (images too).
      await invoke("paw_agent_send", { id: S.proc, text: withPaths(full, atts) });
    } catch (e) {
      S.busy = false;
      turnFinished(S);
      sys(S, `✗ ${e}`);
    }
    refresh(S);
    return;
  }
  // Deprecated: CLI agents (CLI_AGENTS). Claude Code's stream-json and plain stdin.
  const payload = S.mode === "claude"
    ? JSON.stringify({ type: "user", message: { role: "user", content: claudeContent(full, atts) } })
    : withPaths(full, atts);
  if (S.mode === "claude") { S.busy = true; S.busySince = Date.now(); }
  try {
    await invoke("send_input", { id: S.proc, text: payload });
    skillNote.sent();
  } catch (e) {
    S.busy = false;
    turnFinished(S);
    sys(S, `✗ ${e}`);
  }
  refresh(S);
}

/** /help: grouped, and specific to this tab's agent and conversation. */
function helpHtml(S) {
  const row = (k, d) => `<span class="cmd">${esc(k.padEnd(17))}</span><span class="dim">${esc(d)}</span>`;
  const head = (t) => `<span class="help-h">${esc(t)}</span>`;
  // The keys as set in Settings › Keys (each action's first).
  const kl = (...ids) => ids.map((id) => { const k = keysOf(settings, id)[0]; return k ? keyLabel(k) : "–"; }).join(" · ");
  const name = S.agent.name;
  const turns = (S.turns ?? []).filter((t) => !t.open).length;
  const convo = {
    session: S.session
      ? tx("continues in {name} session {id}, also after a restart", { name, id: String(S.session).slice(0, 8) })
      : tx("a {name} session starts with your first prompt and continues after a restart", { name }),
    replay: !turns ? tx("Paw keeps it and sends it with each prompt; it continues after a restart")
      : tx(turns === 1 ? "Paw keeps it ({n} turn so far) and sends it with each prompt; it continues after a restart" : "Paw keeps it ({n} turns so far) and sends it with each prompt; it continues after a restart", { n: turns }),
    none: tx("every prompt stands alone"),
  }[S.agent.continuity || "replay"];
  const modeName = { auto: tx("Auto"), shell: tx("Shell"), agent: tx("Agent") }[S.inputMode] ?? tx("Auto");
  const out = [
    head(tx("This tab")),
    `<span class="dim">${esc(name)} · ${esc(S.model || tx("default model"))} · ${esc(tildify(S.cwd))} · ${tx("input mode {mode}", { mode: modeName })}` +
      (approvalValue(S) ? ` · ${tx("approval {level}", { level: esc(S.approval) })}` : "") + "</span>",
    `<span class="dim">${tx("Conversation: {convo}. A new tab always starts a new one.", { convo: esc(convo) })}</span>`,
    "",
    head(tx("Typing")),
    row("<text>", S.inputMode === "shell" ? tx("runs in this tab's shell (Shell mode)") :
      S.inputMode === "agent" ? tx("goes to {name} (Agent mode)", { name }) : tx("goes to {name}; lines that look like commands run in the shell", { name })),
    row("!<command>", tx("always run in the shell")),
    row("/ask <text>", tx("always send to {name}", { name })),
    row(kl("input-mode"), tx("switch input mode: Auto → Shell → Agent")),
    row(kl("history-search"), tx("search earlier prompts and commands")),
    row("/", tx("the commands as you type, then their parameters (models, factories, folders…); Tab takes one")),
    row("Tab · ↑↓", tx("complete commands and paths · previous prompts")),
    row("+ · ⌘V · drop", tx("attach files · paste an image · drop files on the prompt · each goes in as a badge at the cursor (Backspace removes it; double-click pasted text to edit it)")),
  ];
  if (settings.general.share_shell !== false) {
    out.push(row(tx("shell output"), isPaw(S.agent)
      ? tx("short output goes to {name} right away; long output only if you click “Follow up” under it", { name })
      : tx("short output goes to {name} with your next message; long output only if you click “Follow up” under it", { name })));
    out.push(row(tx("$ badge"), tx("shared long output waiting for your next message (× leaves it out)")));
  }
  out.push("", head(tx("Agent")),
    row("/model [model]", CLI_AGENTS ? tx("show or switch the model (conversation continues)")
      : tx("show the models, or switch to one: provider/model, or its name if only one provider has it (conversation continues)")),
    // Deprecated: CLI agents (CLI_AGENTS).
    ...(CLI_AGENTS ? [row("/agent [id]", tx("switch the agent in this tab (new conversation)"))] : []));
  const levels = approvalLevels(S.agent);
  if (levels.length && hasLevels(S.agent)) {
    out.push(row("/approval [level]", tx("how much {name} may do on its own: {levels}", { name, levels: levels.join(" · ") })));
  }
  out.push(
    row("/restart", tx("restart the agent (conversation continues)")),
    row("/stop", tx("stop the agent or running command (⌘. · Ctrl-C)")),
    row(CLI_AGENTS ? "/new [agent]" : "/new [model]", tx("open a new tab with a new conversation")),
    row("/fork [prompt]", tx("a new tab that goes on from this conversation (and sends the prompt there)")),
    row("/plan [what]", CLI_AGENTS ? tx("make a plan with {name} and run its steps on several agents (pasted text counts too)", { name }) : tx("make a plan with {name} and run its steps on several models (pasted text counts too)", { name })),
    row("/plans", tx("list the open plans and how far each one is (click one to open it)")),
    row("/factories", tx("list your factories and their last runs (click one to open it)")),
    row("/factory <name>", tx("open a factory; /factory new <name> makes one")),
    row("/factory run <name> [task]", tx("start a run of a factory in this tab's folder, with the task")),
    row("/factory delete <name>", tx("delete a factory (asks first; it goes to the Trash)")),
    row("/sessions", tx("list stored sessions, open and closed; click one to reopen it in a new tab")),
    row("/stats [day|week|month]", tx("tokens, queries, plans and time per model: today, this week, this month")),
    row("/clear", tx("clear the screen ({key})", { key: kl("clear") })),
    row("/session", tx("open this tab's folder: its conversation, files, scripts and command log")),
    row("/plugins", tx("the plugins installed and their commands (Settings › Plugins adds more)")),
    ...(pluginHost.commands.size ? ["", head(tx("Plugins")), ...pluginHelpRows(row)] : []),
    "", head(tx("Shell")),
    row("/cd <dir>", tx("change folder; the agent follows with a new conversation")),
    row("history [n | -c]", tx("show the last n shell commands, or clear the history")),
    row("vim, top, ssh…", tx("full-screen and interactive programs open in a terminal view")),
    "", head(tx("Window")),
    row(kl("new-tab", "new-tab-with", "close-tab"), CLI_AGENTS ? tx("new tab · new tab with another agent · close tab") : tx("new tab · new tab with another model · close tab")),
    row(`⌘1–9 · ${kl("prev-tab", "next-tab")}`, tx("go to tab · previous / next tab")),
    row(kl("split-row", "split-column"), tx("split side by side · split stacked")),
    row(kl("delete-line", "delete-word"), tx("delete to the start of the line · the word before the cursor")),
    row("⌘⌥ arrows", tx("move between panes")),
    row(kl("toggle-sidebar", "toggle-panel", "settings"), tx("show / hide the sidebar (specs, factories, sessions) · the right panel (MCPs, skills) · settings")),
  );
  return out.join("\n");
}

async function slashCommand(S, line) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ");
  const echo = () => pushLine(S, { stream: "stdin", text: line, ts: Date.now(), local: true });
  switch (cmd) {
    case "/help":
      echo();
      info(S, helpHtml(S));
      return true;
    case "/clear":
      S.lines = [];
      renderOutput();
      return true;
    case "/cd":
      // Same as typing `cd` — the shell reports the new folder and the agent follows.
      await runShell(S, arg ? `cd ${shq(arg)}` : "cd");
      return true;
    case "/ask":
      if (arg || S.attachments?.length) await sendToAgent(S, arg, takeAttachments(S));
      return true;
    case "/model": {
      echo();
      if (!CLI_AGENTS) {
        if (!arg) { info(S, modelListHtml(S.model)); return true; }
        const m = findModel(arg);
        if (!m) { sys(S, modelMiss(arg)); info(S, modelListHtml(S.model)); return true; }
        S.model = m;
        await restart(S, tx("model → {model} (conversation kept)", { model: m }));
        refresh(S);
        return true;
      }
      // Deprecated: CLI agents (CLI_AGENTS).
      if (!arg) {
        const list = needsModel(S.agent) ? modelsFor(S.agent) : ["default", ...modelsFor(S.agent)];
        const cur = S.model || "default";
        info(S, list.length
          ? list.map((m) => (m === cur ? `<span class="ok">● ${esc(m)}</span>` : `<span class="dim">○</span> ${esc(m)}`)).join("\n")
          : `<span class="dim">${tx("No known models. Use /model &lt;name&gt; or add some in Settings.")}</span>`);
        return true;
      }
      S.model = arg === "default" ? "" : arg;
      if (S.mode === "oneshot") sys(S, tx("model → {model}", { model: S.model || tx("default") }));
      else await restart(S, tx("model → {model} (conversation kept)", { model: S.model || tx("default") }));
      refresh(S);
      return true;
    }
    case "/agent": {
      echo();
      if (!CLI_AGENTS) {
        info(S, `<span class="dim">${tx("Tabs run Paw Agent. Pick its model with /model (/model alone lists them).")}</span>`);
        return true;
      }
      // Deprecated: CLI agents (CLI_AGENTS).
      const list = availableAgents();
      if (!arg) {
        info(S, list.map((a) => (a.id === S.agent.id ? `<span class="ok">● ${esc(a.id)}</span>` : `<span class="dim">○</span> ${esc(a.id)}`) + `  <span class="dim">${esc(a.name)}</span>`).join("\n"));
        return true;
      }
      const a = list.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
      if (!a) { sys(S, tx("✗ unknown agent: {arg}", { arg })); return true; }
      await stopProc(S);
      S.agent = structuredClone(a);
      S.mode = sessionMode(a);
      S.model = defaultModel(a);
      S.busy = false;
      S.proc = null;
      S.info = null;
      S.session = null;
      S.turns = [];
      banner(S);
      if (S.mode !== "oneshot") await startProc(S);
      refresh(S);
      return true;
    }
    case "/approval": {
      echo();
      const levels = approvalLevels(S.agent);
      if (!levels.length || !hasLevels(S.agent)) {
        info(S, `<span class="dim">${tx("{name} has no approval levels set up. Add them in Settings › Agents › {name} › Approval levels.", { name: esc(S.agent.name) })}</span>`);
        return true;
      }
      if (!arg || !levels.includes(arg)) {
        if (arg) sys(S, tx("✗ {name} doesn't support \"{arg}\"", { name: S.agent.name, arg }));
        info(S, levels.map((l) => (l === S.approval ? `<span class="ok">● ${l.padEnd(6)}</span>` : `<span class="dim">○</span> ${l.padEnd(6)}`) +
          ` <span class="dim">${esc(approvalText(S.agent, l))}</span>`).join("\n"));
        return true;
      }
      S.approval = arg;
      if (S.mode === "oneshot") sys(S, tx("approval → {level}", { level: arg }));
      else await restart(S, tx("approval → {level} (conversation continues)", { level: arg }));
      refresh(S);
      return true;
    }
    case "/restart":
      echo();
      await restart(S, tx("restarting agent"));
      return true;
    case "/stop":
      echo();
      await interrupt(S);
      return true;
    case "/fork": {
      const T = await forkTab(S);
      if (T && arg) { T.draft = ""; await submit(arg); }
      return true;
    }
    case "/new": {
      if (CLI_AGENTS || !arg) { await newSession(arg || undefined); return true; }
      const m = findModel(arg);
      if (!m) { echo(); sys(S, modelMiss(arg)); info(S, modelListHtml(null)); return true; }
      await newSession("paw", { model: m });
      return true;
    }
    case "/session": {
      echo();
      const dir = await sessionDir(S);
      if (!dir) { sys(S, tx("✗ couldn't make this tab's session folder")); return true; }
      info(S, `<span class="dim">${tx("This tab's folder")}</span> ${esc(tildify(dir))}\n` +
        `<span class="dim">${tx("session.json · conversations/ · files/ (attached and pasted) · scripts/ · commands.log · launch.sh")}</span>`);
      if (arg !== "path") invoke("session_dir", { id: S.pawId, reveal: true }).catch(() => {});
      return true;
    }
    case "/plans":
    case "/tasks": // the old name
      echo();
      info(S, tasksListHtml());
      return true;
    case "/factories":
      echo();
      info(S, await factoriesListHtml().catch((e) => `<span class="err">✗ ${esc(e)}</span>`));
      return true;
    case "/factory": {
      echo();
      const m = /^new\s+(.+)$/i.exec(arg);
      if (m) { await newFactory(m[1].trim()); return true; }
      // /factory delete <name>: asks first, then to the Trash.
      const d = /^delete(?:\s+([\s\S]+))?$/i.exec(arg);
      if (d) {
        const which = (d[1] ?? "").trim();
        if (!which) { sys(S, tx("Which factory? /factory delete <name>")); return true; }
        await loadFactories();
        const w = which.toLowerCase();
        const hit = factoryState.list.find((x) => x.id === which) ?? factoryState.list.find((x) => x.id.toLowerCase() === w || x.factory?.name?.toLowerCase() === w);
        if (!hit) { sys(S, tx("No factory “{arg}”. /factories lists them.", { arg: which })); return true; }
        await deleteFactory(hit.id);
        return true;
      }
      // /factory run <id> [task]: a run in this tab's folder, with the task.
      const r = /^run\s+(\S+)\s*([\s\S]*)$/i.exec(arg);
      if (r) { await runFactoryFromTab(S, r[1], r[2].trim()); return true; }
      if (!arg) { info(S, await factoriesListHtml().catch((e) => `<span class="err">✗ ${esc(e)}</span>`)); return true; }
      await loadFactories();
      const want = arg.toLowerCase();
      const f = factoryState.list.find((x) => x.id === want || x.factory?.name?.toLowerCase() === want);
      if (f) { await openFactory(f.id); return true; }
      sys(S, tx("No factory “{arg}”. /factories lists them; /factory new {arg} makes it.", { arg }));
      return true;
    }
    case "/stats":
      echo();
      info(S, await statsHtml(arg).catch((e) => `<span class="err">✗ ${esc(e)}</span>`));
      return true;
    case "/sessions":
      echo();
      info(S, await sessionsListHtml().catch((e) => `<span class="err">✗ ${esc(e)}</span>`));
      return true;
    case "/plan":
    case "/task": { // the old name
      // Plan it with this tab's agent, in this tab's folder. Pasted text
      // badges are part of the goal ("/task" alone: the pasted text is it).
      const pasted = (S.attachments ?? []).filter(isPasted);
      if (pasted.length) { S.attachments = S.attachments.filter((a) => !isPasted(a)); renderAttachments(); }
      await newTask({ model: S.model, cwd: S.cwd, goal: arg, atts: pasted });
      return true;
    }
    case "/plugins":
      echo();
      info(S, await pluginsListHtml());
      return true;
    default:
      // A plugin's command, else not ours: it goes to the agent unchanged.
      return runPluginCommand(S, cmd.slice(1).toLowerCase(), arg, echo);
  }
}

// ---------- background shell (one PTY per tab) ----------
// Every tab owns a hidden login shell. Lines that look like commands run
// there; `cd` in it moves the tab (and the agent, on its next prompt).
const shellToSid = new Map();
let shellCommands = new Set();
let commandsTimer = null;
/** Re-read the command names on PATH (debounced). */
function refreshShellCommands() {
  clearTimeout(commandsTimer);
  commandsTimer = setTimeout(() => {
    invoke("shell_commands").then((list) => { shellCommands = new Set(list); updateGlyph(); }).catch(() => {});
  }, 300);
}

async function openShell(S) {
  try {
    S.shell = await invoke("shell_open", { cwd: S.cwd });
    shellToSid.set(S.shell, S.sid);
  } catch (e) {
    S.shell = null;
    sys(S, tx("✗ could not start a shell: {error}", { error: e }));
  }
}

async function runShell(S, command) {
  command = command.trim();
  if (!command) return;
  closeAc();
  if (await historyBuiltin(S, command)) return;
  recordHistory(command);
  pushLine(S, { stream: "cmd", text: command, ts: Date.now() });
  if (S.shell == null) await openShell(S);
  if (S.shell == null) return;
  S.shellBusy = true;
  S.shellCmd = command;
  S.shellSince = Date.now();
  refresh(S);
  try {
    await invoke("shell_run", { id: S.shell, command, raw: needsTty(command) });
  } catch (e) {
    S.shellBusy = false;
    sys(S, `✗ ${e}`);
    refresh(S);
  }
}

/** Ctrl-C / ⌘. — interrupt the shell command if one runs, else stop the agent. */
async function interrupt(S) {
  const dropped = dropWaiting(S);
  if (dropped) { sys(S, dropped === 1 ? tx("dropped the waiting prompt") : tx("dropped {n} waiting prompts", { n: dropped })); inPane(S, renderBusy); return; }
  if (S.raw && S.shell != null) return invoke("shell_write_raw", { id: S.shell, data: "\x03" });
  if (S.shellBusy && S.shell != null) return invoke("shell_interrupt", { id: S.shell });
  if (isPaw(S.agent)) return isRunning(S) && invoke("paw_agent_cancel", { id: S.proc }).catch(() => {});
  return stopProc(S);
}

// ---------- what counts as a command ----------
// 1. executables on PATH (shellCommands, scanned by the backend)
// 2. aliases / functions / builtins the tab's own shell reports (S.shellNames)
// 3. words a background lookup confirmed (fresh PATH, or a path to an executable)
const confirmedCommands = new Set(); // bare names found on PATH after the last scan
const confirmedPaths = new Set();    // "cwd|./script" style paths that are executable
const lookupCache = new Map();       // key → true/false (checked already)

function isKnownCommand(word, S) {
  if (!word) return false;
  if (word.includes("/")) return confirmedPaths.has(`${S?.cwd}|${word}`);
  return shellCommands.has(word) || confirmedCommands.has(word) || !!S?.shellNames?.has(word);
}

/** Ask the backend about the first word if we don't know it yet. Resolves to
 *  true when the word turned out to be a command. */
async function lookupFirstWord(S, text) {
  const t = text.trim().replace(/^!/, "");
  const word = t.split(/\s+/).find((w) => !/^[A-Za-z_]\w*=/.test(w)) ?? "";
  if (!S || !word || isKnownCommand(word, S) || !/^[\w.+~\/@:-]{1,96}$/.test(word)) return false;
  const key = word.includes("/") ? `${S.cwd}|${word}` : word;
  if (lookupCache.has(key)) return false;
  lookupCache.set(key, false);
  const ok = await invoke("command_exists", { word, cwd: S.cwd }).catch(() => false);
  lookupCache.set(key, ok);
  if (ok) (word.includes("/") ? confirmedPaths : confirmedCommands).add(key);
  return ok;
}

let lookupTimer = null;
function scheduleLookup() {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(async () => {
    const S = curS();
    if (S?.inputMode === "auto" && (await lookupFirstWord(S, $("input").value))) {
      updateGlyph();
      scheduleAutocomplete();
    }
  }, 120);
}

listen("shell:names", ({ payload: n }) => {
  const S = sessions.get(shellToSid.get(n.id));
  if (!S) return;
  S.shellNames = new Set(n.names);
  inPane(S, updateGlyph);
});
// New installs and PATH changes make old "not found" answers stale.
const forgetLookups = () => { for (const [k, v] of lookupCache) if (!v) lookupCache.delete(k); };

// ---------- approval levels ----------
// Paw's own, vendor-neutral levels. Each agent maps them to its flags
// (Settings › Agents › Approval levels); `{permission}` gets the mapped value.
const APPROVAL_LEVELS = ["ask", "edits", "auto", "plan", "full"];
const APPROVAL_TEXT = {
  ask: tx("ask before acting (actions that need approval are declined)"),
  edits: tx("may edit files without asking"),
  auto: tx("decides routine actions itself; asks before risky ones"),
  plan: tx("read-only: plan, don't change anything"),
  full: tx("no confirmations at all — use with care"),
};
/** Paw Agent asks instead of declining. */
const PAW_APPROVAL_TEXT = {
  ...APPROVAL_TEXT,
  ask: tx("asks before every file change and command"),
  edits: tx("edits files on its own; asks before commands"),
  auto: tx("edits files in this folder and runs routine commands on its own; asks before risky ones"),
};
const approvalText = (agent, l) => (isPaw(agent) ? PAW_APPROVAL_TEXT : APPROVAL_TEXT)[l];
const approvalLevels = (agent) => APPROVAL_LEVELS.filter((l) => agent.approvals?.[l]);
const approvalValue = (S) => (hasLevels(S.agent) ? S.agent.approvals?.[S.levelOverride ?? S.approval] ?? "" : "");
/** The level new tabs start at; an agent without Auto starts at Edits instead. */
const defaultApproval = (agent) => {
  const l = settings.general.approval || "edits";
  const levels = agent ? approvalLevels(agent) : [];
  return l === "auto" && levels.length && !levels.includes("auto") && levels.includes("edits") ? "edits" : l;
};
/** Old workspaces stored Claude's mode names. */
const approvalFromLegacy = (perm) =>
  ({ acceptEdits: "edits", auto: "auto", plan: "plan", bypassPermissions: "full", default: "ask", manual: "ask" })[perm] ?? null;

// ---------- input mode ----------
// Auto guesses per line (see classify); Shell and Agent send every line one
// way. `!cmd` always means the shell, whatever the mode.
const INPUT_MODES = ["auto", "shell", "agent"];
const MODE_LABEL = { auto: tx("Auto"), shell: tx("Shell"), agent: tx("Agent") };

function routeFor(S, text) {
  const t = text.trim();
  if (t.startsWith("!")) return { shell: true, command: t.slice(1).trim() };
  if (S?.inputMode === "shell") return { shell: true, command: t };
  if (S?.inputMode === "agent") return { shell: false };
  return classify(text, S);
}

function setInputMode(S, mode) {
  S.inputMode = mode;
  closeAc();
  renderModePill();
  updateGlyph();
  scheduleAutocomplete();
}
const cycleInputMode = (S) => setInputMode(S, INPUT_MODES[(INPUT_MODES.indexOf(S.inputMode) + 1) % INPUT_MODES.length]);

function renderModePill() {
  const S = curS();
  const pill = $("mode-pill");
  if (!S) return;
  pill.dataset.mode = S.inputMode;
  pill.textContent = MODE_LABEL[S.inputMode];
  pill.title = {
    auto: tx("Auto: commands go to the shell, everything else to the agent. ⇧Tab to switch."),
    shell: tx("Shell: every line runs in the shell. ⇧Tab to switch."),
    agent: tx("Agent: every line goes to the agent (!cmd still runs in the shell). ⇧Tab to switch."),
  }[S.inputMode];
}

// Words that are both executables and common ways to start a sentence.
const AMBIGUOUS = new Set(("make find open say time watch test which help sort kill top man file wait touch " +
  "history read look join split paste expand fold cut units script last who w more less what yes go run set " +
  "type print install sum tail head diff link stat apply write list update check show fix add remove delete " +
  "move copy rename build start stop review describe tell can do is are why how please create implement " +
  "refactor summarize compare convert clean format debug deploy search replace rewrite generate document " +
  "analyze optimize improve let lets i we you explain").split(" "));
// Punctuation that almost never appears in a natural-language request.
const SHELL_SYNTAX = /[|&;<>`$*=]|(^|\s)--?[\w-]|(^|\s)(\.{0,2}\/|~\/)|\w\.\w+(\s|$)/;

/** Decide whether a line is a shell command or a prompt for the agent. */
function classify(raw, S = curS()) {
  const text = raw.trim();
  if (text.startsWith("!")) return { shell: true, command: text.slice(1).trim() };
  if (!text || text.includes("\n") || text.endsWith("?")) return { shell: false };
  if (/^history(\s+(-c|\d+))?$/.test(text)) return { shell: true, command: text }; // Paw's own builtin
  const words = text.split(/\s+/);
  const first = words[0];
  if (/^[A-Za-z_]\w*=\S*$/.test(first)) return { shell: true, command: text }; // FOO=1 cmd
  // ./run.sh, ../x, ~/bin/x are clearly paths; an absolute /x only once the
  // background lookup confirms an executable (else it's e.g. an agent's /command).
  if (/^(\.{1,2}\/|~\/)/.test(first)) return { shell: true, command: text };
  if (first.startsWith("/") && isKnownCommand(first, S)) return { shell: true, command: text };
  if (!isKnownCommand(first, S)) return { shell: false };
  const rest = words.slice(1).join(" ");
  if (words.length === 1 || SHELL_SYNTAX.test(rest) || /^[\d\s%:.-]+$/.test(rest)) return { shell: true, command: text };
  // "Yes start", "Run the tests": commands are lowercase, sentences start capitalised.
  if (/^[A-Z][a-z]+[,.!]?$/.test(first) && words.length > 1) return { shell: false };
  if (AMBIGUOUS.has(first.toLowerCase())) {
    // "make test", "man ls", "which git" — but not "make the tests pass".
    const two = words.length === 2;
    return { shell: two && (first === "make" || isKnownCommand(words[1], S)), command: text };
  }
  // Known command plus a few plain words ("git status", "npm run build").
  return { shell: words.length <= 4, command: text };
}

function renderPartial(S) {
  const out = $("output");
  let el = out.querySelector(".partial-line");
  if (!S.partial) { el?.remove(); return; }
  if (!el) {
    el = div(S.partialMd ? "tl say md-msg partial partial-line" : "tl out partial partial-line");
    // The agent's text being written goes in its turn's block; a shell's at the end.
    ((S.partialMd && S.turnId != null && turnBlock(out, S.turnId)) || out).appendChild(el);
  }
  el.innerHTML = S.partialMd ? `<span class="b">⏺</span><div class="md">${renderMarkdown(S.partial)}</div>` : ansi(S.partial);
  out.scrollTop = out.scrollHeight;
}

listen("shell:output", ({ payload: o }) => {
  const S = sessions.get(shellToSid.get(o.id));
  if (!S) return;
  if (o.lines?.length) {
    S.partial = null;
    const ts = Date.now();
    pushLines(S, o.lines.map((text) => ({ stream: "shell", text, ts })));
    if (!paneOf(S)) { S.unread += o.lines.length; renderTabs(); renderSidebar(); }
  }
  if (o.partial != null) {
    S.partial = o.partial;
    S.partialMd = false;
    inPane(S, () => renderPartial(S));
  }
});

listen("shell:done", ({ payload: d }) => {
  const S = sessions.get(shellToSid.get(d.id));
  if (!S) return;
  leaveTermView(S);
  S.shellBusy = false;
  if (S.partial) {
    // Keep a trailing unfinished line (e.g. printf without \n) as real output.
    pushLine(S, { stream: "shell", text: S.partial, ts: Date.now() });
    S.partial = null;
    inPane(S, () => $("output").querySelector(".partial-line")?.remove());
  }
  if (d.code !== 0) pushLine(S, { stream: "shellexit", code: d.code, ts: Date.now() });
  if (S.shellCmd) logCommand(S, "you", `exit ${d.code}`, S.shellCmd);
  if (d.cwd) S.cwd = d.cwd;
  inPane(S, renderAttachments);
  pluginShellDone(S, d.code);
  if (S.shellCmd) pluginEvent("command", { tab: pluginTab(S), command: S.shellCmd, code: d.code });
  shareShortOutput(S);
  refreshShellCommands(); // pick up anything just installed (brew install …)
  forgetLookups();
  refresh(S);
  inPane(S, updateGlyph);
});

listen("shell:exit", ({ payload: id }) => {
  const S = sessions.get(shellToSid.get(id));
  shellToSid.delete(id);
  if (!S) return;
  leaveTermView(S);
  S.shell = null;
  S.shellBusy = false;
  sys(S, tx("shell exited — the next command starts a new one"));
  refresh(S);
});

// ---------- shell history & autocomplete ----------
// History is shared by all tabs and stored by the backend (size: Settings ›
// General). The popup suggests, in order: history lines, command names (first
// word) and file/folder paths (later words, relative to the tab's folder).
let shellHistory = [];
const ac = { items: [], sel: -1, open: false, seq: 0, full: false, search: false, slash: false, usage: "" };

function recordHistory(command) {
  const max = settings.general.history_size ?? 1000;
  shellHistory = shellHistory.filter((c) => c !== command);
  shellHistory.push(command);
  if (shellHistory.length > max) shellHistory.splice(0, shellHistory.length - max);
  invoke("history_add", { command }).catch(() => {});
}

/** `history`, `history 50`, `history -c` — answered from Paw's own history. */
async function historyBuiltin(S, command) {
  const m = command.match(/^history(?:\s+(-c|\d+))?\s*$/);
  if (!m) return false;
  pushLine(S, { stream: "cmd", text: command, ts: Date.now() });
  if (m[1] === "-c") {
    await invoke("history_clear");
    shellHistory = [];
    sys(S, tx("history cleared"));
    return true;
  }
  const n = m[1] ? Number(m[1]) : 25;
  const start = Math.max(0, shellHistory.length - n);
  const width = String(shellHistory.length).length;
  shellHistory.slice(start).forEach((c, i) =>
    pushLine(S, { stream: "shell", text: `${String(start + i + 1).padStart(width)}  ${c}`, ts: Date.now() }));
  if (!shellHistory.length) sys(S, tx("history is empty"));
  return true;
}

let acTimer = null;
function scheduleAutocomplete() {
  clearTimeout(acTimer);
  // While ⌃R search is open, typing refines the search instead.
  acTimer = setTimeout(() => (ac.search ? historySearch() : updateAutocomplete()), 40);
}

/**
 * Refresh the popup, like a shell's completion: command names for the first
 * word ("gre" → grep), files and folders for the words after it. While typing
 * (`full` = false) once a word has two characters; on Tab (`full` = true) for
 * any word, an empty one too. History only when you ask: ⌃R (historySearch).
 */
async function updateAutocomplete(full = false) {
  const S = curS();
  const ta = $("input");
  const value = ta.value;
  if (!S || S.shellBusy || !value.trim() || value.includes("\n") || ta.selectionStart !== value.length) return closeAc();
  // A slash command: its name, then its parameters, while you type.
  if (value.startsWith("/")) return slashAutocomplete(S, value);
  const forced = value.startsWith("!");
  if (S.inputMode === "agent" && !forced) return closeAc();
  const looksShell = forced || S.inputMode === "shell" || classify(value, S).shell;

  const seq = ++ac.seq;
  const bang = forced ? "!" : "";
  const items = [];
  const seen = new Set();
  const add = (it) => {
    if (it.value === value || seen.has(it.value)) return;
    seen.add(it.value);
    items.push(it);
  };
  const word = value.match(/(\S*)$/)[1];
  const start = value.length - word.length;
  const head = value.slice(0, start);
  const w = word.replace(/^!/, "");
  const first = !head.replace(/^!/, "").trim();
  // While typing: a command name from two characters on (whatever the line
  // looks like so far: "gre" isn't a command yet); a path from the first
  // character, for a line that goes to the shell (a prompt gets none).
  if (!full && (first ? w.length < 2 : !w || !looksShell)) return closeAc();
  if (first) {
    let n = 0;
    if (w) {
      for (const c of shellCommands) {
        if (c.startsWith(w) && c !== w) {
          add({ kind: "command", value: bang + c + " ", label: c, match: [0, w.length] });
          if (++n >= 30) break;
        }
      }
    }
  } else {
    const cmd = head.replace(/^!/, "").trim().split(/\s+/)[0];
    const dirsOnly = ["cd", "pushd", "rmdir"].includes(cmd);
    const paths = await invoke("complete_path", { cwd: S.cwd, word }).catch(() => []);
    if (seq !== ac.seq) return;
    for (const p of paths ?? []) {
      if (dirsOnly && !p.is_dir) continue;
      add({ kind: p.is_dir ? "dir" : "file", value: head + p.value, label: p.value, match: [0, word.length] });
    }
  }
  if (seq !== ac.seq) return;
  ac.full = full;
  ac.slash = false;
  ac.search = false;
  ac.usage = "";
  ac.items = items.slice(0, 50);
  ac.sel = -1;
  ac.items.length ? renderAc() : closeAc();
}

// ---------- slash commands ----------
// Typing / lists the commands (with their parameters); after a command and a
// space, its parameter's values: models, approval levels, factories, folders…
// A free-text parameter (/plan's goal) shows what to type instead.

/** The commands this tab offers: { cmd, usage, desc, args(words, S) → { options, free } }. */
function slashSpecs(S) {
  const name = S.agent.name;
  const opt = (value, desc = "", more = false) => ({ value, desc, more });
  const models = () => ({ options: visibleModels().map((m) => opt(m)), match: "contains" });
  const levels = approvalLevels(S.agent);
  const factories = () => {
    if (!factoryState.loaded && !factoryState.loading) loadFactories().then(() => ac.slash && scheduleAutocomplete());
    return factoryState.list.map((f) => opt(f.id, f.factory?.name ?? tx("can't be read")));
  };
  const specs = [
    { cmd: "/help", desc: tx("what you can type here") },
    { cmd: "/ask", usage: "<text>", desc: tx("send to {name}, even if it looks like a command", { name }), args: () => ({ free: tx("your message to {name}", { name }) }) },
    { cmd: "/model", usage: "[model]", desc: tx("show the models, or switch to one (conversation continues)"), args: (w) => (w.length ? {} : models()) },
    ...(CLI_AGENTS ? [{ cmd: "/agent", usage: "[id]", desc: tx("switch the agent in this tab"), args: (w) => (w.length ? {} : { options: settings.agents.map((a) => opt(a.id, a.name)) }) }] : []),
    ...(levels.length && hasLevels(S.agent) ? [{ cmd: "/approval", usage: "[level]", desc: tx("how much {name} may do on its own", { name }), args: (w) => (w.length ? {} : { options: levels.map((l) => opt(l)) }) }] : []),
    { cmd: "/restart", desc: tx("restart the agent (conversation continues)") },
    { cmd: "/stop", desc: tx("stop the agent or running command") },
    { cmd: "/new", usage: "[model]", desc: tx("open a new tab with a new conversation"), args: (w) => (w.length ? {} : models()) },
    { cmd: "/fork", usage: "[prompt]", desc: tx("fork this tab: a new tab going on from its conversation"), args: () => ({ free: tx("what to ask in the new tab (optional)") }) },
    { cmd: "/plan", usage: "[what]", desc: tx("make a plan with {name} and run its steps", { name }), args: () => ({ free: tx("what you want done (or leave it out, and describe it in the plan's tab)") }) },
    { cmd: "/plans", desc: tx("the open plans and how far each one is") },
    { cmd: "/factories", desc: tx("your factories and their last runs") },
    { cmd: "/factory", usage: "<name> · new <name> · run <name> [task] · delete <name>", desc: tx("open, make, run or delete a factory"), args: (w) => {
      if (!w.length) return { options: [opt("run", tx("start a run in this tab's folder"), true), opt("new", tx("make a new factory"), true), opt("delete", tx("delete a factory"), true), ...factories()] };
      if (w[0] === "new") return { free: tx("the new factory's name") };
      if (w[0] === "delete") return w.length === 1 ? { options: factories() } : {};
      if (w[0] === "run" && w.length === 1) return { options: factories().map((o) => ({ ...o, more: true })) };
      if (w[0] === "run") return { free: tx("the task for this run (optional)") };
      return {};
    } },
    { cmd: "/sessions", desc: tx("stored sessions, open and closed") },
    { cmd: "/stats", usage: "[day|week|month]", desc: tx("tokens, queries, plans and time per model"), args: (w) => (w.length ? {} : { options: [opt("day", tx("today")), opt("week", tx("this week")), opt("month", tx("this month"))] }) },
    { cmd: "/clear", desc: tx("clear the screen") },
    { cmd: "/session", desc: tx("open this tab's folder: conversation, files, scripts") },
    { cmd: "/plugins", desc: tx("the plugins installed and their commands") },
    { cmd: "/cd", usage: "<dir>", desc: tx("change folder (the agent follows)"), dirs: true },
    ...[...pluginHost.commands.entries()].map(([n, c]) => ({ cmd: `/${n}`, usage: c.usage, desc: c.description || tx("from {name}", { name: pluginHost.plugins.get(c.id)?.manifest.name ?? c.id }),
      args: () => (c.usage ? { free: c.usage } : {}) })),
  ];
  return specs;
}

async function slashAutocomplete(S, value) {
  const seq = ++ac.seq;
  const specs = slashSpecs(S);
  const items = [];
  let usage = "";
  const sp = value.indexOf(" ");
  if (sp < 0) {
    // The command's name, fuzzy (like fzf): "/pl" finds /plan, /plans, /plugins; the best first.
    const w = value.slice(1);
    const found = [];
    specs.forEach((c, order) => {
      const m = w ? fuzzyMatch(w, c.cmd.slice(1)) : { score: 0, positions: [] };
      if (m) found.push({ c, m, order });
    });
    found.sort((x, y) => y.m.score - x.m.score || x.order - y.order);
    for (const { c, m } of found) {
      const takes = !!(c.usage || c.args || c.dirs);
      if (c.cmd === value && !takes) continue; // typed in full: ⏎ runs it
      items.push({ kind: "slash", value: c.cmd + (takes ? " " : ""), label: c.cmd + (c.usage ? ` ${c.usage}` : ""), positions: [0, ...m.positions.map((p) => p + 1)], desc: c.desc, more: takes });
    }
  } else {
    const spec = specs.find((c) => c.cmd === value.slice(0, sp));
    if (!spec) return closeAc();
    const rest = value.slice(sp + 1);
    const word = rest.match(/(\S*)$/)[1];
    const done = rest.slice(0, rest.length - word.length).trim().split(/\s+/).filter(Boolean);
    const head = value.slice(0, value.length - word.length);
    if (spec.dirs) {
      const paths = await invoke("complete_path", { cwd: S.cwd, word }).catch(() => []);
      if (seq !== ac.seq) return;
      for (const p of paths) if (p.is_dir) items.push({ kind: "dir", value: head + p.value, label: p.value, match: [0, word.length] });
      if (!items.length) usage = `${spec.cmd} ${spec.usage}: ${tx("a folder")}`;
    } else {
      const a = spec.args?.(done, S) ?? {};
      // Its values, fuzzy (models, levels, factories…): the best first.
      (a.options ?? []).forEach((o, order) => {
        if (o.value === word) return;
        const m = fuzzyMatch(word, o.value);
        if (!m) return;
        items.push({ kind: "arg", value: head + o.value + (o.more ? " " : ""), label: o.value, positions: m.positions, score: m.score, order, desc: o.desc, more: o.more });
      });
      if (word) items.sort((x, y) => y.score - x.score || x.order - y.order);
      if (a.free) usage = `${spec.cmd}${spec.usage ? " " + spec.usage : ""} · ${a.free}`;
    }
  }
  if (seq !== ac.seq) return;
  ac.full = true; // Tab takes the first one
  ac.slash = true;
  ac.usage = usage;
  ac.search = false;
  ac.items = items.slice(0, 60);
  ac.sel = -1;
  ac.items.length || usage ? renderAc() : closeAc();
}

// ---------- fuzzy matching (like fzf) ----------
// A query is terms separated by spaces; every term has to match, in any
// order. A term's letters match in that order with gaps between them ("gtst"
// finds "git status"); 'term matches as written, ^term at the start, term$ at
// the end. A term with a capital letter matches case exactly, else any case.
// The score favours letters that follow each other and the starts of words
// (after a space, / - _ . : = or a lower-case letter before a capital), and
// shorter text; it's null when something doesn't match.

const FZ_BOUNDARY = /[\s/\-_.:=,;()[\]{}'"`@#]/;
function fzBoundary(text, i) {
  if (i === 0) return 2;
  if (FZ_BOUNDARY.test(text[i - 1])) return 1.6;
  return /[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]) ? 1.2 : 0;
}
/** The best way a term's letters match in the text, in order: { score, positions } or null. */
function fzSubsequence(text, t, q) {
  let best = null;
  for (let s = t.indexOf(q[0]); s >= 0; s = t.indexOf(q[0], s + 1)) {
    const pos = [s];
    let at = s + 1, ok = true;
    for (let k = 1; k < q.length; k++) {
      // Prefer the next letter right after the last one, else the next word start, else the nearest.
      if (t[at] === q[k]) { pos.push(at++); continue; }
      let next = -1, i = t.indexOf(q[k], at);
      for (let j = i; j >= 0 && next < 0; j = t.indexOf(q[k], j + 1)) if (fzBoundary(text, j)) next = j;
      if (next < 0) next = i;
      if (next < 0) { ok = false; break; }
      pos.push(next); at = next + 1;
    }
    if (!ok) break; // a later start can't match either
    let score = 0, prev = -2;
    for (const p of pos) {
      score += 16 + 10 * fzBoundary(text, p);
      if (p === prev + 1) score += 9;
      else if (prev >= 0) score -= 3 + Math.min(p - prev - 1, 12) * 0.6;
      prev = p;
    }
    if (!best || score > best.score) best = { score, positions: pos };
  }
  return best;
}
function fuzzyMatch(query, text) {
  const terms = String(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, positions: [] };
  let score = 0;
  const all = new Set();
  for (let raw of terms) {
    let exact = false, start = false, end = false;
    if (raw.startsWith("'") && raw.length > 1) { exact = true; raw = raw.slice(1); }
    if (raw.startsWith("^") && raw.length > 1) { exact = start = true; raw = raw.slice(1); }
    if (raw.endsWith("$") && raw.length > 1) { exact = end = true; raw = raw.slice(0, -1); }
    const smart = /[A-Z]/.test(raw);
    const t = smart ? text : text.toLowerCase(), q = smart ? raw : raw.toLowerCase();
    let m;
    if (exact) {
      let i = start ? (t.startsWith(q) ? 0 : -1) : end ? (t.endsWith(q) ? t.length - q.length : -1) : t.indexOf(q);
      if (start && end && t !== q) i = -1;
      if (i < 0) return null;
      m = { score: 25 * q.length + 10 * fzBoundary(text, i), positions: Array.from({ length: q.length }, (_, k) => i + k) };
    } else {
      m = fzSubsequence(text, t, q);
      if (!m) return null;
    }
    score += m.score;
    for (const p of m.positions) all.add(p);
  }
  // Shorter text first among equals.
  score -= Math.min(text.length, 300) * 0.08;
  return { score, positions: [...all].sort((a, b) => a - b) };
}
/** A label with the given letters in bold. */
function fzHighlight(label, positions) {
  if (!positions?.length) return esc(label);
  const on = new Set(positions);
  let out = "", run = "", bold = false;
  const flush = () => { if (run) out += bold ? `<b>${esc(run)}</b>` : esc(run); run = ""; };
  for (let i = 0; i < label.length; i++) {
    const b = on.has(i);
    if (b !== bold) { flush(); bold = b; }
    run += label[i];
  }
  flush();
  return out;
}

// ---------- ⌃R: history search ----------
// Like a shell's reverse search: what's in the prompt is the search text, the
// popup lists matching lines (this tab's prompts and commands, then Paw's
// shell history), newest first. ⌃R again or ↑↓ moves, ⏎/Tab puts the line in
// the prompt, Esc closes.
function historySearch(step = false) {
  const S = curS();
  if (!S) return;
  if (step && ac.open && ac.search) {
    if (ac.items.length) { ac.sel = (ac.sel + 1) % ac.items.length; renderAc(); }
    return;
  }
  const q = $("input").value;
  const items = [];
  const seen = new Set();
  const inShell = new Set(shellHistory);
  // Like fzf: fuzzy, the best matches first, the newest among equals.
  const add = (line, kind) => {
    if (!line.trim() || seen.has(line)) return;
    const label = line.replace(/\n/g, " ⏎ ");
    const m = fuzzyMatch(q, label);
    if (!m) return;
    seen.add(line);
    items.push({ kind, value: line, label, positions: m.positions, score: m.score, order: items.length });
  };
  for (const h of [...S.history].reverse()) add(h, inShell.has(h) ? "history" : "prompt");
  for (const h of [...shellHistory].reverse()) add(h, "history");
  if (q.trim()) items.sort((a, b) => b.score - a.score || a.order - b.order);
  ac.seq++;
  ac.search = true;
  ac.full = false;
  ac.items = items.slice(0, 100);
  ac.sel = ac.items.length ? 0 : -1;
  renderAc();
}

const AC_ICON = { history: "↺", command: "›_", dir: "▸", file: "·", prompt: "❯", slash: "/", arg: "›" };
/** The kind shown at a suggestion's right. */
const AC_KIND = { history: tx("history"), command: tx("command"), dir: tx("dir"), file: tx("file"), prompt: tx("prompt") };
function renderAc() {
  const el = $("ac");
  el.innerHTML = "";
  if (ac.search && !ac.items.length) {
    el.insertAdjacentHTML("beforeend", `<div class="ac-empty">${tx("No earlier line contains “{text}”", { text: esc($("input").value.trim()) })}</div>`);
  }
  ac.items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "ac-item" + (i === ac.sel ? " sel" : "");
    const [a, b] = it.match ?? [0, 0];
    const label = it.positions ? fzHighlight(it.label, it.positions) : `${esc(it.label.slice(0, a))}<b>${esc(it.label.slice(a, b))}</b>${esc(it.label.slice(b))}`;
    row.innerHTML = `<span class="ac-icon ${it.kind}">${AC_ICON[it.kind]}</span><span class="ac-label">${label}</span>` +
      (it.desc != null ? `<span class="ac-desc">${esc(it.desc)}</span>` : `<span class="ac-kind">${AC_KIND[it.kind] ?? it.kind}</span>`);
    row.onmousedown = (e) => { e.preventDefault(); acceptAc(i); };
    row.onmousemove = () => { if (ac.sel !== i) { ac.sel = i; renderAc(); } };
    el.appendChild(row);
  });
  if (ac.slash && ac.usage) el.insertAdjacentHTML("beforeend", `<div class="ac-usage">${esc(ac.usage)}</div>`);
  const hint = document.createElement("div");
  hint.className = "ac-hint";
  hint.textContent = ac.slash ? (ac.items.length ? tx("↑↓ select · Tab accept · ⏎ run · Esc close") : tx("⏎ run · Esc close")) : ac.search ? tx("History search, fuzzy · 'exact ^start end$ · ⌃R / ↑↓ next · ⏎ / Tab use · Esc close")
    : ac.full ? tx("↑↓ select · Tab / ⏎ accept · Esc close")
    : tx("History · ↑↓ select · ⏎ accept · Tab for commands & files · Esc close");
  el.appendChild(hint);
  el.classList.remove("hidden");
  ac.open = true;
  el.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function closeAc() {
  ac.open = false;
  ac.search = false;
  ac.slash = false;
  ac.usage = "";
  ac.items = [];
  ac.sel = -1;
  ac.seq++;
  $("ac").classList.add("hidden");
}

function acceptAc(i) {
  const it = ac.items[i];
  if (!it) return;
  const ta = $("input");
  ta.value = it.value;
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize();
  updateGlyph();
  ta.focus();
  // Keep completing into folders, after a command name, and into a command's next parameter.
  if (it.kind === "dir" || it.kind === "command") updateAutocomplete(true);
  else if ((it.kind === "slash" || it.kind === "arg") && it.more) updateAutocomplete();
  else closeAc();
}

/** Handles popup keys; returns true when the key was consumed. */
function autocompleteKey(e) {
  if (keyIs(settings, e, "history-search")) {
    e.preventDefault();
    historySearch(true);
    return true;
  }
  if (ac.search && e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    if (ac.sel >= 0) acceptAc(ac.sel);
    return true;
  }
  if (keyIs(settings, e, "input-mode")) {
    e.preventDefault();
    const S = curS();
    if (S) cycleInputMode(S);
    return true;
  }
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    if (ac.open && (ac.sel >= 0 || ac.full)) acceptAc(ac.sel >= 0 ? ac.sel : 0);
    else updateAutocomplete(true).then(() => { if (ac.items.length === 1) acceptAc(0); });
    return true;
  }
  if (!ac.open) return false;
  const n = ac.items.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    ac.sel = e.key === "ArrowDown" ? (ac.sel + 1) % n : ac.sel <= 0 ? n - 1 : ac.sel - 1;
    renderAc();
    return true;
  }
  if (e.key === "Enter" && !e.shiftKey && ac.sel >= 0) {
    e.preventDefault();
    acceptAc(ac.sel);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeAc();
    return true;
  }
  return false;
}

// ---------- terminal mode (embedded xterm.js) ----------
// Full-screen programs (vim, top, less…) and interactive sessions (ssh,
// python, psql…) need a real terminal. The backend switches the tab's shell to
// raw mode — automatically on the alternate screen, or because we asked — and
// streams bytes here; keystrokes go straight back to the PTY.

const TTY_ALWAYS = new Set(("ssh mosh telnet ftp sftp tmux screen vim vi nvim nano emacs pico micro htop top btop " +
  "less more most man watch su mc ranger nnn lazygit tig k9s").split(" "));
const TTY_REPL = new Set(("python python3 ipython node irb ruby ghci lua R julia scala clj " +
  "bash zsh sh fish deno bun claude codex gemini aider").split(" "));
const TTY_DB = new Set("sqlite3 psql mysql redis-cli mongosh mongo".split(" "));

/** Does this command line need a real terminal? */
function needsTty(command) {
  const cmd = command.trim();
  if (/[|>]/.test(cmd)) return false; // piped / redirected output
  const words = cmd.split(/\s+/);
  let i = 0;
  while (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) i++; // FOO=1 cmd
  let w = words[i] ?? "";
  if (w === "sudo") {
    const rest = words.slice(i + 1);
    if (rest.includes("-i") || rest.includes("-s") || rest[0] === "su") return true;
    i = i + 1 + rest.findIndex((x) => !x.startsWith("-"));
    w = words[i] ?? "";
  }
  w = w.split("/").pop();
  const args = words.slice(i + 1);
  if (TTY_ALWAYS.has(w)) return true;
  if (TTY_DB.has(w)) {
    // Database shells take a database as an argument and stay interactive.
    return !args.some((a) => /^(-c|-e|-f|--command|--execute|--file|--eval)(=|$)/.test(a)) && !/[<]/.test(cmd);
  }
  if (TTY_REPL.has(w)) {
    // A REPL only when there's no script / -c / --version style argument.
    if (args.some((a) => ["-c", "-e", "-m", "-v", "-V", "--version", "-h", "--help", "-p", "--print"].includes(a))) return false;
    return args.every((a) => a.startsWith("-"));
  }
  if (["docker", "podman", "kubectl"].includes(w)) return /\s(-it|-ti|--tty|-i\s+-t|-t\s+-i)\b/.test(" " + args.join(" "));
  return false;
}

function xtermTheme() {
  const { theme } = PawThemes.activeTheme(settings);
  const p = theme.palette;
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const t = {
    background: "rgba(0, 0, 0, 0)", foreground: theme.foreground, cursor: theme.cursor,
    cursorAccent: theme.background, selectionBackground: theme.selection,
  };
  names.forEach((n, i) => {
    t[n] = p[i];
    t["bright" + n[0].toUpperCase() + n.slice(1)] = p[i + 8];
  });
  return t;
}

function ensureTerm(S) {
  if (S.term) return S.term;
  const host = document.createElement("div");
  host.className = "xterm-host";
  $("xterm-park").appendChild(host);
  const term = new Terminal({
    fontFamily: fontFamilyCss(),
    fontSize: fontSize(),
    lineHeight: 1.2,
    cursorBlink: true,
    macOptionIsMeta: true,
    scrollback: 5000,
    allowTransparency: true,
    theme: xtermTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // ⌘C with text selected in the terminal copies it. (The Edit menu's Copy
  // needs a selection in the page, which a terminal selection isn't.)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyC" && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      e.preventDefault();
      return false;
    }
    return true;
  });
  term.onData((data) => invoke("shell_write_raw", { id: S.shell, data }).catch(() => {}));
  term.onResize(({ cols, rows }) => invoke("shell_resize", { id: S.shell, cols, rows }).catch(() => {}));
  S.term = { term, fit, host };
  return S.term;
}

function fitTerm(S) {
  if (!S?.term || !paneOf(S)) return;
  try {
    S.term.fit.fit();
    invoke("shell_resize", { id: S.shell, cols: S.term.term.cols, rows: S.term.term.rows }).catch(() => {});
  } catch {}
}

/** Show the embedded terminal for the active tab (or the normal view). */
function showTermView() {
  const S = curS();
  const P = activePane;
  const on = !!S?.raw && !!S.term;
  $("terminal").classList.toggle("raw", on);
  const hosts = $("xterm-hosts");
  for (const h of [...hosts.children]) if (!on || h !== S.term.host) $("xterm-park").appendChild(h);
  if (on) {
    if (S.term.host.parentElement !== hosts) hosts.appendChild(S.term.host);
    S.term.host.classList.remove("hidden");
    $("xterm-title").textContent = S.rawCmd ? `${tx("Terminal")} · ${S.rawCmd}` : tx("Terminal");
    requestAnimationFrame(() => { fitTerm(S); if (P === focusedPane) S.term.term.focus(); });
  }
}

function disposeTerm(S) {
  if (!S.term) return;
  S.term.term.dispose();
  S.term.host.remove();
  S.term = null;
}

/** What an interactive session left on screen, as plain lines. */
function termTranscript(term) {
  const buf = term.buffer.normal;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines;
}

function leaveTermView(S) {
  if (!S.raw) return;
  S.raw = false;
  if (S.term && S.rawForced) {
    for (const line of termTranscript(S.term.term)) pushLine(S, { stream: "shell", text: line, ts: Date.now() });
  }
  disposeTerm(S);
  // Back to the wide line-mode PTY.
  if (S.shell != null) invoke("shell_resize", { id: S.shell, cols: 160, rows: 50 }).catch(() => {});
  inPane(S, () => {
    showTermView();
    if (S.sid === activeId) $("input").focus();
  });
  refresh(S);
}

listen("shell:raw", ({ payload: r }) => {
  const S = sessions.get(shellToSid.get(r.id));
  if (!S) return;
  if (r.on) {
    S.raw = true;
    S.rawForced = r.forced;
    // Its startup files wait for an answer (oh-my-zsh's "update? [Y/n]", a
    // passphrase…): what the shell said, to answer here; a command waits.
    S.rawCmd = r.startup ? tx("your shell is starting") : S.shellBusy ? S.shellCmd : "";
    if (r.startup) sys(S, tx("Your shell is asking something while it starts (from its startup files). Answer it in the terminal; commands run once the shell is ready."));
    ensureTerm(S);
    inPane(S, showTermView);
    refresh(S);
  } else {
    leaveTermView(S);
  }
});

listen("shell:data", ({ payload: d }) => {
  const S = sessions.get(shellToSid.get(d.id));
  if (!S) return;
  const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
  ensureTerm(S).term.write(bytes);
});


// ---------- attachments ----------
// "+" (or pasting an image) attaches files to the next line you send.
// Claude gets images inline and other files by path; one-shot / stdin agents
// get the paths in the prompt; shell commands get the paths as arguments.

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const isInlineImage = (a) => !!(a.data && a.mime);

function makeThumb(a) {
  if (!isInlineImage(a)) return;
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 96 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    a.thumb = c.toDataURL("image/png");
    renderAttachments();
    if (a.echoEl) a.echoEl.src = a.thumb;
  };
  img.src = `data:${a.mime};base64,${a.data}`;
}

/** Attach files (or pasted text) to tab S's next line: each goes in the
 *  prompt at the caret as a badge (a token in the text, see tokenOf). */
function addAttachments(S, list) {
  S.attachments ??= [];
  const added = [];
  for (const a of list) {
    if (S.attachments.some((x) => x.path === a.path)) continue;
    a.token = tokenOf(S, a);
    S.attachments.push(a);
    added.push(a);
    makeThumb(a);
  }
  if (added.length) insertTokens(S, added.map((a) => a.token));
  renderAttachments();
  updateGlyph();
}

// ---------- badges in the prompt's text ----------
// An attachment sits in the prompt where you put it, as a token in the text:
// "[Pasted text #1 · 12 lines ×]" or "[shot.png ×]". The layer behind the
// textarea (input-backdrop) draws each token as a badge. Backspace right
// after one (Delete right before) takes the whole badge out, × removes it,
// and a double-click on pasted text puts the text back. Sending turns each
// token into its reference (refOf): pasted text goes in at its place, a file
// is "[name]" for an agent and its quoted path for a shell command.

/** The token for a new attachment: unique in the tab. */
function tokenOf(S, a) {
  const label = isPasted(a) ? `${a.name} · ${tx(a.lines === 1 ? "{n} line" : "{n} lines", { n: a.lines })}` : a.name;
  // Not one an undo could bring back either.
  const taken = new Set([...(S.attachments ?? []), ...(S.goneAttachments ?? [])].map((x) => x.token));
  let t = `[${label} ×]`;
  for (let n = 2; taken.has(t); n++) t = `[${label} #${n} ×]`;
  return t;
}
/** What a token stands for once sent: the same without its ×. */
const refOf = (a) => (a.token ? a.token.replace(/ ×\]$/, "]") : `[${a.name}]`);
/** The text as sent: each badge's token turned into its reference. */
function tokensToRefs(text, atts) {
  for (const a of atts) if (a.token) text = text.split(a.token).join(refOf(a));
  return text;
}
/** The text without its badges (is anything typed besides them?). */
const withoutTokens = (text, atts) => atts.reduce((t, a) => (a.token ? t.split(a.token).join("") : t), text);

/** Put tokens in tab S's prompt at the caret (or at the end of its draft when it isn't shown). */
function insertTokens(S, tokens) {
  const P = paneOf(S);
  if (!P) {
    const d = S.draft ?? "";
    S.draft = d + (d && !/\s$/.test(d) ? " " : "") + tokens.join(" ") + " ";
    return;
  }
  inPane(S, () => {
    const ta = $("input");
    const at = ta.selectionStart, end = ta.selectionEnd;
    // Not inside another badge.
    const inside = tokenAt(S, ta.value, at);
    const s = inside ? inside.end : at, e = inside ? inside.end : end;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const ins = (before && !/\s$/.test(before) ? " " : "") + tokens.join(" ") + (/^\s/.test(after) ? "" : " ");
    editPrompt(ta, ins, s, e);
    autosize();
    renderBackdrop(S);
  });
}

/** Replace a range of the prompt so ⌘Z can undo it (setRangeText can't be undone). */
function editPrompt(ta, text, start, end) {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
  if (!ok) ta.setRangeText(text, start, end, "end");
}

/** The token (of one of S's attachments) around position i: {a, start, end}. */
function tokenAt(S, text, i, strict = true) {
  for (const a of S.attachments ?? []) {
    if (!a.token) continue;
    for (let at = text.indexOf(a.token); at >= 0; at = text.indexOf(a.token, at + 1)) {
      const end = at + a.token.length;
      if (strict ? at < i && i < end : at <= i && i <= end) return { a, start: at, end };
    }
  }
  return null;
}

// The last arrow key in a prompt: a held key moves the cursor between its
// keydowns, so each cursor move soon after one is checked too.
let arrowMove = null;
document.addEventListener("selectionchange", () => {
  const m = arrowMove;
  if (m && Date.now() - m.at < 400 && document.activeElement === m.ta) snapCaret(m.S, m.ta, m.dir);
});

/** The cursor (the moving end of a selection) inside a badge: to its edge,
 *  the way it was going (dir -1 / 1), or the nearer one (0). */
function snapCaret(S, ta, dir) {
  const back = ta.selectionDirection === "backward";
  const focus = back ? ta.selectionStart : ta.selectionEnd;
  const anchor = back ? ta.selectionEnd : ta.selectionStart;
  const t = tokenAt(S, ta.value, focus);
  if (!t) return;
  const to = dir < 0 ? t.start : dir > 0 ? t.end : focus - t.start < t.end - focus ? t.start : t.end;
  if (anchor === focus) ta.setSelectionRange(to, to);
  else if (to < anchor) ta.setSelectionRange(to, anchor, "backward");
  else ta.setSelectionRange(anchor, to, "forward");
}

/** Take a badge out of the prompt: its token (and a space after it) and the attachment. */
function removeToken(S, a) {
  inPane(S, () => {
    const ta = $("input");
    const at = ta.value.indexOf(a.token);
    if (at >= 0) {
      const end = at + a.token.length + (ta.value[at + a.token.length] === " " ? 1 : 0);
      editPrompt(ta, "", at, end);
    }
    // The attachment waits in case ⌘Z brings its token back.
    syncTokens(S);
    autosize();
  });
  if ((S.attachments ?? []).includes(a)) { S.attachments = S.attachments.filter((x) => x !== a); renderAttachments(); }
  updateGlyph();
}

/** After an edit: attachments whose token is gone go too (an undo brings them back). */
function syncTokens(S) {
  const ta = $("input");
  if (!S || !ta) return;
  const text = ta.value;
  S.goneAttachments ??= [];
  const keep = [], gone = [];
  for (const a of S.attachments ?? []) (!a.token || text.includes(a.token) ? keep : gone).push(a);
  const back = S.goneAttachments.filter((a) => text.includes(a.token));
  if (gone.length || back.length) {
    S.attachments = [...keep, ...back];
    S.goneAttachments = [...S.goneAttachments.filter((a) => !back.includes(a)), ...gone].slice(-20);
    renderAttachments();
  }
  renderBackdrop(S);
}

/** Draw the prompt's text behind the textarea, its tokens as badges. */
function renderBackdrop(S = curS()) {
  const wrap = $("input-wrap"), back = $("input-backdrop"), ta = $("input");
  if (!wrap || !back || !ta) return;
  const atts = (S?.attachments ?? []).filter((a) => a.token);
  const text = ta.value;
  const spots = [];
  for (const a of atts) for (let at = text.indexOf(a.token); at >= 0; at = text.indexOf(a.token, at + 1)) spots.push({ a, at });
  wrap.classList.toggle("has-tokens", spots.length > 0);
  if (!spots.length) { back.textContent = ""; return; }
  spots.sort((x, y) => x.at - y.at);
  let html = "", i = 0;
  for (const { a, at } of spots) {
    if (at < i) continue;
    html += esc(text.slice(i, at));
    const inner = a.token.slice(1, -3); // between "[" and " ×]"
    html += `<span class="tok${isPasted(a) ? " text" : ""}" data-tok="${esc(a.token)}"><span class="tok-b">[</span>${esc(inner)} <span class="tok-x">×</span><span class="tok-b">]</span></span>`;
    i = at + a.token.length;
  }
  // A last newline needs something after it to take up its line.
  html += esc(text.slice(i)) + (text.endsWith("\n") ? " " : "");
  back.innerHTML = html;
  back.scrollTop = ta.scrollTop;
}

/** The badge (or its ×) under a point in the prompt, from the layer behind it. */
function tokenUnder(S, x, y) {
  const back = $("input-backdrop");
  if (!back || !$("input-wrap")?.classList.contains("has-tokens")) return null;
  const hit = (el) => [...el.getClientRects()].some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
  for (const el of back.querySelectorAll(".tok")) {
    if (!hit(el)) continue;
    const a = (S.attachments ?? []).find((x) => x.token === el.dataset.tok);
    if (a) return { a, el, onX: hit(el.querySelector(".tok-x")) };
  }
  return null;
}

/** Pasted text back into the prompt in place of its badge. */
function expandToken(S, a) {
  inPane(S, () => {
    const ta = $("input");
    const at = ta.value.indexOf(a.token);
    if (at >= 0) editPrompt(ta, a.text, at, at + a.token.length);
    syncTokens(S);
    autosize();
  });
  if ((S.attachments ?? []).includes(a)) { S.attachments = S.attachments.filter((x) => x !== a); renderAttachments(); }
  updateGlyph();
}

// ---------- files dropped on the window ----------
// Finder (or anything else) dropping files: they go into the prompt of the
// pane under the pointer, as badges at its caret. Paw gets the drop from the
// window (tauri://drag-*), with the paths, not from the page.
/** The pane under a drop's position (physical pixels), else the focused one. */
function paneAtDrop(pos) {
  const k = window.devicePixelRatio || 1;
  const el = pos ? document.elementFromPoint(pos.x / k, pos.y / k) : null;
  const id = el?.closest?.("[data-pane]")?.dataset.pane;
  return (id != null && panes.get(Number(id))) || focusedPane;
}
function showDropTarget(pos) {
  const P = pos === null ? null : paneAtDrop(pos);
  for (const Q of panes.values()) withPane(Q, () => $("input-wrap")?.classList.toggle("drop-here", Q === P && Q.sid != null));
}
listen("tauri://drag-enter", (e) => showDropTarget(e.payload?.position));
listen("tauri://drag-over", (e) => showDropTarget(e.payload?.position));
listen("tauri://drag-leave", () => showDropTarget(null));
listen("tauri://drag-drop", async (e) => {
  showDropTarget(null);
  const paths = e.payload?.paths ?? [];
  const P = paneAtDrop(e.payload?.position);
  const S = P?.sid != null ? sessions.get(P.sid) : null;
  if (!S || !paths.length) return;
  if (focusedPane !== P) focusPane(P, false);
  let r;
  try {
    r = await invoke("attach_paths", { paths, session: S.pawId });
  } catch (err) {
    sys(S, `✗ ${err}`);
    return;
  }
  inPane(S, () => $("input").focus());
  if (r.attached.length) addAttachments(S, r.attached);
  for (const k of r.skipped) {
    const why = k.why === "folder" ? tx("folders can't be attached") : k.why === "missing" ? tx("it isn't there") : k.why;
    sys(S, tx("✗ couldn't attach {path}: {why}", { path: tildify(k.path), why }));
  }
});

// Long pasted text becomes a badge ("Pasted text · 12 lines") so the prompt
// stays readable; the text goes along with the message, after what you type.
// Clicking the badge puts the text back into the prompt.
const PASTE_BADGE_LINES = 4;
const PASTE_BADGE_CHARS = 600;
const isPasted = (a) => a?.kind === "text";
let nextPaste = 1;
function pastedAttachment(text) {
  const n = nextPaste++;
  return { kind: "text", text, name: tx("Pasted text #{n}", { n }), path: `pasted:${Date.now()}:${n}`, size: new Blob([text]).size, lines: text.split("\n").length };
}
const shouldBadge = (text) => text.split("\n").length >= PASTE_BADGE_LINES || text.length > PASTE_BADGE_CHARS;
/** The message: what was typed, each pasted text in place of its badge's
 *  reference (or after the text, for pasted text without one). */
function withPasted(text, atts = []) {
  const after = [];
  for (const a of atts.filter(isPasted)) {
    const ref = refOf(a);
    if (a.token && text.includes(ref)) text = text.split(ref).join(a.text);
    else after.push(a.text);
  }
  return [text, ...after].filter((t) => t?.trim()).join("\n\n");
}
const pastedLabel = (a) => tx(a.lines === 1 ? "Pasted text · {n} line" : "Pasted text · {n} lines", { n: a.lines });

/** The badge nearest the caret (the tray's last): an attachment, else the $ badge. */
function removeLastBadge(S) {
  // Badges in the text: Backspace after one takes it (see the prompt's keys);
  // here only ones in the tray (the $ shell outputs, attachments without a token).
  const loose = (S.attachments ?? []).filter((a) => !a.token);
  if (loose.length) {
    S.attachments = S.attachments.filter((a) => a !== loose.at(-1));
  } else if (shareShell() && S.shellContext?.length) {
    S.shellContext = [];
  } else return false;
  renderAttachments();
  updateGlyph();
  return true;
}

/** Hand over the tab's attachments to whatever is sending them. */
function takeAttachments(S) {
  const list = S.attachments ?? [];
  S.attachments = [];
  S.goneAttachments = [];
  renderAttachments();
  return list;
}

function chipHtml(a, removable) {
  if (isPasted(a)) {
    return `<span class="att-icon">TXT</span><span class="att-name" title="${esc(String(a.text ?? "").slice(0, 600))}">${esc(pastedLabel(a))}</span>` +
      (removable ? `<button class="att-x" title="${tx("Remove")}">×</button>` : "");
  }
  const ext = (a.name.split(".").pop() || "file").slice(0, 4).toUpperCase();
  const icon = a.thumb ? `<img class="att-thumb" src="${a.thumb}" alt="">`
    : `<span class="att-icon">${isInlineImage(a) ? "IMG" : esc(ext)}</span>`;
  return `${icon}<span class="att-name" title="${esc(a.path)}">${esc(a.name)}</span>` +
    `<span class="att-size">${fmtSize(a.size)}</span>` + (removable ? `<button class="att-x" title="${tx("Remove")}">×</button>` : "");
}

function renderAttachments() {
  const S = curS();
  const tray = $("att-tray");
  // Badges with a token are drawn in the text (renderBackdrop).
  const list = (S?.attachments ?? []).filter((a) => !a.token);
  const ctx = shareShell() ? S?.shellContext ?? [] : [];
  renderBackdrop(S);
  tray.classList.toggle("hidden", !list.length && !ctx.length);
  tray.innerHTML = "";
  if (ctx.length) {
    const el = div("att-badge ctx-badge",
      `<span class="att-badge-icon">$</span><span class="att-badge-name">${tx(ctx.length > 1 ? "{n} shell outputs" : "{n} shell output", { n: ctx.length })}</span><button class="att-x" title="${tx("Don't share with the agent")}">×</button>`);
    el.title = tx("Sent to the agent with your next message:") + "\n" + ctx.map((e) => `$ ${e.cmd}${e.code ? `  (exit ${e.code})` : ""}`).join("\n");
    el.querySelector(".att-x").onclick = (e) => { e.stopPropagation(); S.shellContext = []; renderAttachments(); $("input").focus(); };
    tray.appendChild(el);
  }
  list.forEach((a, i) => {
    if (isPasted(a)) {
      const el = div("att-badge paste-badge", `<span class="att-badge-icon">TXT</span><span class="att-badge-name">${esc(pastedLabel(a))}</span><button class="att-x" title="${tx("Remove")}">×</button>`);
      el.title = a.text.length > 600 ? a.text.slice(0, 600) + "…" : a.text;
      el.title += "\n\n" + tx("Click to edit it in the prompt.");
      el.querySelector(".att-x").onclick = (e) => { e.stopPropagation(); S.attachments = S.attachments.filter((x) => x !== a); renderAttachments(); $("input").focus(); };
      // Back into the prompt, at the cursor.
      el.onclick = () => {
        const ta = $("input");
        S.attachments = S.attachments.filter((x) => x !== a);
        ta.setRangeText(a.text, ta.selectionStart, ta.selectionEnd, "end");
        renderAttachments();
        autosize();
        updateGlyph();
        ta.focus();
      };
      tray.appendChild(el);
      return;
    }
    // One-line badge: thumbnail or type icon, name, ×.
    const ext = (a.name.split(".").pop() || "file").slice(0, 4).toUpperCase();
    const icon = a.thumb ? `<img class="att-badge-img" src="${a.thumb}" alt="">`
      : `<span class="att-badge-icon">${isInlineImage(a) ? "IMG" : esc(ext)}</span>`;
    const el = div("att-badge", `${icon}<span class="att-badge-name">${esc(a.name)}</span><button class="att-x" title="${tx("Remove")}">×</button>`);
    el.title = `${a.path} · ${fmtSize(a.size)}`;
    el.querySelector(".att-x").onclick = (e) => { e.stopPropagation(); S.attachments = S.attachments.filter((x) => x !== a); renderAttachments(); $("input").focus(); };
    tray.appendChild(el);
  });
}

/** Claude message content: text (with file paths) + inline images. */
function claudeContent(text, atts) {
  const imgs = atts.filter(isInlineImage);
  const files = atts.filter((a) => !isInlineImage(a));
  const parts = [text.trim()];
  if (files.length) parts.push("Attached files:\n" + files.map((f) => `- ${f.path}`).join("\n"));
  if (imgs.length) parts.push((imgs.length === 1 ? "Attached image: " : "Attached images: ") + imgs.map((i) => i.path).join(", "));
  const content = [{ type: "text", text: parts.filter(Boolean).join("\n\n") }];
  for (const i of imgs) content.push({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } });
  return content;
}

/** Plain-text agents: list the paths after the prompt. */
const withPaths = (text, atts) =>
  atts.length ? `${text.trim()}${text.trim() ? "\n\n" : ""}Attached files:\n${atts.map((a) => `- ${a.path}`).join("\n")}` : text;



// ---------- markdown ----------
// Agents' replies are markdown. marked turns them into HTML and DOMPurify
// strips anything active (scripts, handlers, forms, frames, remote images).
marked.setOptions({ gfm: true, breaks: false });
/** `breaks`: single newlines stay line breaks (plain-text CLI output). */
function renderMarkdown(md, breaks = false) {
  try {
    const html = marked.parse(md, { async: false, breaks });
    // HTML only: no SVG or MathML, whose <image href> would load a URL. No
    // tag or attribute that fetches anything (img, background, srcset…):
    // a reply could otherwise send data to any server just by being shown.
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "img", "video", "audio", "picture", "source", "track"],
      FORBID_ATTR: ["style", "background", "srcset", "poster", "ping"],
    });
  } catch {
    return esc(md);
  }
}

// Links open in the default browser, never inside Paw's window.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href");
  if (/^(https?:|mailto:)/i.test(href)) invoke("open_url", { url: href }).catch(() => {});
});

// ---------- shared shell context ----------
// Commands run in a tab (and their output) reach the agent, so "why did that
// fail?" works. Small output is shared on its own: straight into a Paw Agent
// conversation, or along with the next message to other agents (a note under
// the output says which). Large output isn't: a Follow up button under it shares it, and
// then a $ badge in the prompt shows it will go along (× leaves it out).
const SHELL_CTX_LINES = 150;     // per command, newest lines kept
const SHELL_CTX_BUDGET = 12000;  // characters for the whole block

const shareShell = () => settings.general.share_shell !== false;

function trackShellContext(S, line) {
  if (line.stream === "cmd") {
    S.shellPending = { cmd: line.text, cwd: S.cwd, out: [], code: 0 };
  } else if (line.stream === "shell") {
    const e = S.shellPending;
    if (e) { e.out.push(PawThemes.stripAnsi(line.text)); if (e.out.length > 400) { e.cut = (e.cut ?? 0) + e.out.length - 300; e.out.splice(0, e.out.length - 300); } }
  } else if (line.stream === "shellexit") {
    const e = S.shellPending;
    if (e) e.code = line.code;
  }
}

/** One command and its output, as the agent sees it. */
function shellBlock(e, showCwd, budget = SHELL_CTX_BUDGET) {
  let lines = e.out;
  let head = "";
  if (lines.length > SHELL_CTX_LINES) {
    head = `… (${lines.length - SHELL_CTX_LINES} earlier lines omitted)\n`;
    lines = lines.slice(-SHELL_CTX_LINES);
  }
  const body = head + lines.join("\n");
  const where = showCwd ? `  # in ${tildify(e.cwd)}` : "";
  const exit = e.code ? `\n[exit ${e.code === 130 ? "130 (interrupted)" : e.code}]` : "";
  let block = `$ ${e.cmd}${where}\n${body}${exit}`.trimEnd();
  if (block.length > budget) block = `$ ${e.cmd}${where}\n…${body.slice(-(budget - e.cmd.length - 40))}${exit}`;
  return block;
}

// Small enough to share on its own: up to this many lines and characters.
const SHELL_DIRECT_CHARS = 4000;
const SHELL_DIRECT_LINES = 80;
let nextOffer = 1;

/** A command finished: share small output, offer a link for large output. */
async function shareShortOutput(S) {
  const e = S.shellPending;
  S.shellPending = null;
  if (!e || !shareShell() || needsTty(e.cmd)) return;
  const lines = e.out.length + (e.cut ?? 0);
  const small = lines <= SHELL_DIRECT_LINES && shellBlock(e, true, Infinity).length <= SHELL_DIRECT_CHARS;
  if (!small) {
    // Large: shared only if asked (the link under the output).
    const id = `${Date.now().toString(36)}-${nextOffer++}`;
    (S.shellOffers ??= new Map()).set(id, e);
    pushLine(S, { stream: "shareoffer", offer: id, cwd: e.cwd, text: tx("{n} lines", { n: lines }), ts: Date.now() });
    return;
  }
  // A Paw Agent conversation in this folder takes it right away.
  if (isPaw(S.agent) && isRunning(S) && S.proc != null && !(S.agentCwd && S.agentCwd !== S.cwd)) {
    try {
      await invoke("paw_agent_note", { id: S.proc, text: `I ran this in my terminal:\n<terminal>\n${shellBlock(e, true, Infinity)}\n</terminal>` });
      pushLine(S, { stream: "shared", ts: Date.now() });
      return;
    } catch { /* the session ended: it goes with the next message */ }
  }
  (S.shellAuto ??= []).push(e);
  pushLine(S, { stream: "shared", next: true, ts: Date.now() });
}

/** A command and its output, rebuilt from the transcript (after a restart). */
function entryFromLines(S, l) {
  const at = S.lines.indexOf(l);
  if (at < 0) return null;
  let i = at - 1;
  while (i >= 0 && S.lines[i].stream !== "cmd") i--;
  if (i < 0) return null;
  const between = S.lines.slice(i + 1, at);
  return {
    cmd: S.lines[i].text, cwd: l.cwd ?? S.cwd,
    out: between.filter((x) => x.stream === "shell").map((x) => PawThemes.stripAnsi(String(x.text ?? ""))),
    code: between.find((x) => x.stream === "shellexit")?.code ?? 0,
  };
}

/** Follow up under a large output: it goes with the next message (the $ badge).
 *  The button stays; using it again adds the output again for a later message. */
function shareOffer(S, l) {
  if (S.shellContext?.some((x) => x.offer === l.offer)) return true; // already waiting
  const e = S.shellOffers?.get(l.offer) ?? entryFromLines(S, l);
  if (!e) return false;
  (S.shellContext ??= []).push({ ...e, offer: l.offer });
  inPane(S, renderAttachments);
  return true;
}

/** The shell context block for the next message (and forget it). */
function takeShellContext(S) {
  // Small output shared on its own, then what was added with the link, in the order run.
  const entries = [...(S.shellAuto ?? []), ...(S.shellContext ?? [])];
  S.shellAuto = [];
  S.shellContext = [];
  if (!entries.length || !shareShell()) return { text: "", count: 0 };
  let budget = SHELL_CTX_BUDGET;
  const blocks = [];
  // Newest first, so the latest command always fits.
  for (let i = entries.length - 1; i >= 0 && budget > 200; i--) {
    const e = entries[i];
    const block = shellBlock(e, i === 0 || entries[i - 1].cwd !== e.cwd, budget);
    budget -= block.length;
    blocks.unshift(block);
  }
  const text = `For context, here is what I ran in my terminal since my last message:\n<terminal>\n${blocks.join("\n\n")}\n</terminal>`;
  return { text, count: blocks.length };
}

// ---------- workspace: tabs survive a restart ----------
// Saved to workspace.json: each tab's agent, folder, settings, Claude session
// id, history and recent scrollback. Claude tabs resume their conversation.
const WS_LINES = 1000;
let wsTimer = null;
let wsReady = false; // don't overwrite the saved workspace before it's restored

const LINE_KEEP = 20000; // characters of one line kept across restarts

/** Shorten every long string inside a JSON event so the event stays valid JSON. */
function trimEvent(text) {
  let ev;
  try { ev = JSON.parse(text); } catch { return null; }
  delete ev.tool_use_result; // a second copy of the tool output
  const cut = (v) => typeof v === "string" ? (v.length > 4000 ? v.slice(0, 4000) + "\n… (trimmed when saved)" : v)
    : Array.isArray(v) ? v.map(cut)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]))
    : v;
  const t = JSON.stringify(cut(ev));
  return t.length <= LINE_KEEP * 2 ? t : null;
}

function persistableLine(l) {
  const out = { stream: l.stream, ts: l.ts };
  if (l.text != null) {
    const t = String(l.text);
    out.text = t.length <= LINE_KEEP ? t
      : (t.startsWith("{") && trimEvent(t)) || t.slice(0, LINE_KEEP) + "…";
  }
  if (l.html != null) out.html = l.html;
  if (l.code != null) out.code = l.code;
  if (l.local) out.local = true;
  if (l.restore) out.restore = true;
  if (l.turn != null) out.turn = l.turn;
  if (l.next) out.next = true;
  if (l.offer) { out.offer = l.offer; if (l.cwd) out.cwd = l.cwd; }
  if (l.attachments) out.attachments = l.attachments.map((a) => (isPasted(a) ? { kind: "text", name: a.name, path: a.file ?? a.path, size: a.size, lines: a.lines, text: String(a.text).slice(0, 600) } : { name: a.name, path: a.path, size: a.size }));
  if (l.shared) out.shared = l.shared;
  if (l.skills) out.skills = l.skills;
  if (l.stream === "approval") Object.assign(out, { id: l.id, kind: l.kind, items: l.items, state: l.state === "pending" && l.kind === "paw" ? "expired" : l.state,
    target: l.target, canAllow: l.canAllow, agentName: l.agentName, tool: l.tool });
  return out;
}

function workspaceSnapshot() {
  return {
    version: 1,
    active: Math.max(0, openTabs.indexOf(activeId)),
    groups: [...groups.values()],
    tabs: openTabs.map((sid) => sessions.get(sid)).filter(Boolean).map(tabSnapshot),
  };
}

/** What the tab was about, for /sessions: the task, the name it was given, or the first prompt. */
function sessionSummary(S) {
  if (S.task) return S.task.title || S.task.goal?.split("\n")[0] || "";
  if (S.factory) return tx("Factory {name}", { name: factoryTabLabel(S) });
  if (S.title) return S.title;
  const first = S.lines.find((l) => l.stream === "stdin" && !l.local && String(l.text ?? "").trim());
  return first ? String(first.text).trim().split("\n")[0].slice(0, 160) : "";
}
/** When something last happened in the tab (Paw's own notes don't count). */
function lastActive(S) {
  for (let i = S.lines.length - 1; i >= 0; i--) {
    const l = S.lines[i];
    if (l.ts && l.stream !== "system" && l.stream !== "info") return l.ts;
  }
  return S.createdAt ?? Date.now();
}

/** One tab's state, as session.json keeps it. */
function tabSnapshot(S) {
  return {
      id: S.pawId,
      summary: sessionSummary(S),
      lastActive: lastActive(S),
      group: S.group ?? undefined,
      title: S.title ?? undefined,
      agent: S.agent.id,
      cwd: S.cwd,
      model: S.model,
      approval: S.approval,
      inputMode: S.inputMode,
      session: S.agent.continuity === "session" ? S.session ?? null : null,
      turns: (S.turns ?? []).filter((t) => !t.open).slice(-40)
        .map((t) => ({ user: String(t.user).slice(0, 8000), assistant: String(t.assistant).slice(-8000) })),
      history: S.history.slice(-200),
      lines: S.lines.slice(-WS_LINES).map(persistableLine),
      task: taskSnapshot(S) ?? undefined,
      factory: S.factory ?? undefined,
      stepOf: S.stepOf ?? undefined,
      sandboxMode: S.sandboxMode ?? undefined,
      sandboxPrograms: S.sandboxPrograms?.length ? S.sandboxPrograms : undefined,
      // The sandbox its agent runs with (a window started again re-attaches to it).
      sandboxStarted: S.proc != null ? S.sandboxStarted : undefined,
      nodeOf: S.nodeOf ?? undefined,
      // Its processes in the daemon: a window that starts again re-attaches.
      live: daemon.instance && (S.proc != null || S.shell != null) ? {
        instance: daemon.instance, proc: S.nodeOf ? null : S.proc, shell: S.shell, dseq: S.dseq ?? 0,
        busy: !!S.busy, busySince: S.busySince ?? null, working: !!S.working, turnStarted: S.turnStarted ?? null,
        shellBusy: !!S.shellBusy, shellCmd: S.shellCmd ?? null, shellSince: S.shellSince ?? null,
      } : undefined,
  };
}

function saveWorkspaceSoon() {
  if (!wsReady) return;
  clearTimeout(wsTimer);
  wsTimer = setTimeout(() => invoke("save_workspace", { workspace: workspaceSnapshot() }).catch(() => {}), 1500);
}
window.addEventListener("beforeunload", () => {
  if (wsReady) invoke("save_workspace", { workspace: workspaceSnapshot() }).catch(() => {});
});

/** Thumbnails for images attached to restored prompts (re-read from disk). */
async function reloadThumbs(S) {
  const imgs = S.lines.flatMap((l) => l.attachments ?? []).filter((a) => /\.(png|jpe?g|gif|webp)$/i.test(a.name ?? ""));
  if (!imgs.length) return;
  await Promise.all(imgs.map(async (a) => {
    try {
      const d = await invoke("describe_attachment", { path: a.path });
      if (!d.data) return;
      a.data = d.data; a.mime = d.mime;
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 96 / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          a.thumb = c.toDataURL("image/png");
          delete a.data; // only needed for the thumbnail
          resolve();
        };
        img.onerror = resolve;
        img.src = `data:${d.mime};base64,${d.data}`;
      });
    } catch { /* file moved or deleted: keep the type icon */ }
  }));
  inPane(S, renderOutput);
}

// ---------- stored sessions ----------
// A closed tab's folder stays in ~/.paw/session (its last state goes into
// session.json), so /sessions can list and reopen it. Settings › General ›
// Closed sessions sets how many are kept; the oldest go first. A tab closed
// before anything happened in it leaves nothing behind.

const archive = { closed: 0, size: 0, ids: [] };
const maxSessions = () => Math.max(0, Number(settings.general.max_sessions ?? 50) || 0);
const openIds = () => [...sessions.values()].map((S) => S.pawId);

function keepClosedSession(S) {
  const used = S.task || S.lines.some((l) => (l.stream === "stdin" && !l.local) || l.stream === "cmd");
  const done = used ? invoke("save_session", { id: S.pawId, tab: tabSnapshot(S) }) : invoke("delete_session", { id: S.pawId });
  done.catch(() => {}).finally(() => setTimeout(refreshArchive, 300));
}

/** Apply the limit, then count what's kept for the status bar. */
async function refreshArchive() {
  try {
    const open = openIds();
    await invoke("prune_sessions", { max: maxSessions(), open });
    const list = await invoke("list_sessions");
    archive.ids = list.map((x) => x.id);
    const closed = list.filter((x) => !open.includes(x.id));
    archive.closed = closed.length;
    archive.size = closed.reduce((n, x) => n + x.size, 0);
  } catch { /* no folder yet */ }
  for (const P of panes.values()) renderArchive(P.root);
}

function renderArchive(root) {
  const el = root?.querySelector('[data-id="sl-sessions"]');
  if (!el) return;
  const max = maxSessions();
  el.textContent = max ? tx("{n}/{max} sessions", { n: archive.closed, max }) : tx("{n} sessions", { n: archive.closed });
  el.classList.toggle("full", !!max && archive.closed >= max);
  const one = archive.closed === 1, vars = { n: archive.closed, size: fmtSize(archive.size), max };
  el.title = max
    ? tx(one ? "{n} closed session kept ({size}), up to {max}; the oldest go first. Click for /sessions." : "{n} closed sessions kept ({size}), up to {max}; the oldest go first. Click for /sessions.", vars)
    : tx(one ? "{n} closed session kept ({size}). Click for /sessions." : "{n} closed sessions kept ({size}). Click for /sessions.", vars);
}

const ago = (ms) => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return tx("just now");
  if (s < 3600) return tx("{n}m ago", { n: Math.floor(s / 60) });
  if (s < 86400) return tx("{n}h ago", { n: Math.floor(s / 3600) });
  const d = Math.floor(s / 86400);
  return d === 1 ? tx("yesterday") : d < 30 ? tx("{n} days ago", { n: d }) : new Date(ms).toLocaleDateString(I18N.locale());
};

/** /sessions: every stored session, open ones first; click one to open it. */
async function sessionsListHtml() {
  const list = await invoke("list_sessions");
  if (!list.length) return `<span class="dim">${tx("No sessions stored yet.")}</span>`;
  const open = new Map([...sessions.values()].map((S) => [S.pawId, S]));
  const rows = [...list].sort((a, b) => (open.has(b.id) - open.has(a.id)) || b.last_active - a.last_active);
  const closed = rows.filter((x) => !open.has(x.id));
  const max = maxSessions();
  const total = list.reduce((n, x) => n + x.size, 0);
  const head = `<span class="help-h">${tx("Sessions")}</span> <span class="dim">${max ? tx("· {open} active · {closed} of {max} completed kept · {size}", { open: open.size, closed: closed.length, max, size: fmtSize(total) }) : tx("· {open} active · {closed} completed kept · {size}", { open: open.size, closed: closed.length, size: fmtSize(total) })}</span>`;
  const agentName = (id) => settings.agents.find((a) => a.id === id)?.name ?? id;
  const stA = tx("active"), stC = tx("completed"), sw = Math.max(stA.length, stC.length);
  const lines = rows.map((x) => {
    const S = open.get(x.id);
    const desc = (S ? sessionSummary(S) : x.description) || (S ? tabLabel(S) : tx("(no prompt)"));
    const d = desc.length > 44 ? desc.slice(0, 43) + "…" : desc;
    const when = S ? lastActive(S) : x.last_active;
    const status = S ? `<span class="ok">● ${esc(stA.padEnd(sw))}</span>` : `<span class="dim">○ ${esc(stC.padEnd(sw))}</span>`;
    return `${status} <span class="dim">${esc(x.id.length > 8 ? x.id.slice(0, 8) + "…" : x.id)}</span>  ` +
      `<a href="#" class="task-link" data-open-session="${esc(x.id)}" title="${S ? tx("Go to its tab") : tx("Reopen it in a new tab")}">${esc(d)}</a>${" ".repeat(44 - d.length)}` +
      `  ${esc(ago(when).padEnd(10))}  ${esc(fmtSize(x.size).padStart(7))}  <span class="dim">${esc(agentName(x.agent))}${x.cwd ? " · " + esc(tildify(x.cwd)) : ""}${x.task ? ` · ${tx("task")}` : ""}</span>`;
  });
  return `${head}\n${lines.join("\n")}\n<span class="dim">${tx("Click a session to go to it; a completed one reopens in a new tab, its conversation continuing.")}</span>`;
}

/** Reopen a closed session in a new tab. */
async function reopenSession(id) {
  // Links from before session folders got short names carry the long id.
  const isIt = (S) => S.pawId === id || (id.length > 8 && S.pawId === id.replace(/[^0-9a-z]/gi, "").slice(0, 8).toLowerCase());
  const open = [...sessions.values()].find(isIt);
  if (open) return select(open.sid);
  let t;
  try { t = await invoke("load_session", { id }); } catch (e) { const S = curS(); if (S) sys(S, `✗ ${e}`); return; }
  // load_session gives the folder's current id.
  if (sessions.size && [...sessions.values()].some((S) => S.pawId === t.id)) return select([...sessions.values()].find((S) => S.pawId === t.id).sid);
  const S = await restoreTab(t, tx("reopened"));
  if (!S) { const C = curS(); if (C) sys(C, tx("✗ the agent of that session ({agent}) isn't set up any more", { agent: t.agent })); return; }
  if (S.group && !groups.has(S.group)) delete S.group;
  select(S.sid);
  saveWorkspaceSoon();
  refreshArchive();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-open-session]");
  if (!a) return;
  e.preventDefault();
  reopenSession(a.dataset.openSession);
});

/** Restarts add a note each (marked `restore`); the last one is enough (it says the same).
 *  Notes saved before they were marked are recognized by their English text. */
function dropRestoreNotes(S) {
  while (S.lines.length) {
    const l = S.lines[S.lines.length - 1];
    if (l.stream === "system" && (l.restore || /^— (restored after restart|re-attached|reopened)/.test(String(l.text ?? "")))) S.lines.pop();
    else break;
  }
}

/** Open a tab from its saved state (a restart, or a closed session reopened). */
async function restoreTab(t, note = null) {
  const paw = settings.agents.find(isPaw);
  // Without CLI agents, a CLI agent's tab continues on Paw Agent: its
  // transcript stays, its CLI conversation can't come along.
  const fromCli = !CLI_AGENTS && t.agent !== "ollama" && t.agent !== paw?.id;
  // The Ollama agent is gone; Paw Agent runs Ollama models now.
  const agent = fromCli || t.agent === "ollama" ? paw : settings.agents.find((a) => a.id === t.agent);
  if (!agent) return null;
  // Paw Agent's models come with the scan: matching a bare model id (or
  // picking the default) needs it.
  const bare = (m) => !providerOf(m);
  if (isPaw(agent) && !detectionsReady && (fromCli || bare(t.model) || (t.task?.steps ?? []).some((s) => bare(s.model)))) {
    await waitForDetections(15000);
  }
  let cwd = t.cwd;
  try { cwd = await invoke("resolve_dir", { path: cwd, base: homeDir }); } catch { cwd = homeDir; }
  // Tabs from before session folders take their conversation's id (Paw
  // Agent's conversation moved into session/<that id>), or a new one.
  // (its first 8 characters, as the folder is called since ids were shortened).
  const pawId = t.id ?? (isPaw(agent) && !fromCli && /^[0-9a-f-]{8,64}$/i.test(t.session ?? "") ? t.session.slice(0, 8) : newPawId());
  const model = !isPaw(agent) ? t.model ?? defaultModel(agent) : fromCli ? defaultPawModel() : savedModel(t.model);
  const S = {
    sid: nextSid++, pawId, agent: structuredClone(agent), mode: sessionMode(agent), cwd,
    model, approval: t.approval ?? approvalFromLegacy(t.perm) ?? defaultApproval(agent),
    proc: null, info: null, lines: (t.lines ?? []).slice(-WS_LINES), busy: false,
    history: t.history ?? [], histIdx: (t.history ?? []).length, draft: "", unread: 0,
    shell: null, shellBusy: false, inputMode: t.inputMode || settings.general.input_mode || "auto",
    session: fromCli ? null : t.session ?? t.claudeSession ?? null,
    turns: fromCli ? [] : t.turns ?? [],
    ...(t.title ? { title: t.title } : {}),
  };
  const oldName = settings.agents.find((a) => a.id === t.agent)?.name ?? t.agent;
  const convertedNote = () => fromCli && S.lines.push({ stream: "info", ts: Date.now(),
    html: `<span class="dim">${tx("This tab used {old}; it continues on {agent} with {model}.", { old: esc(oldName), agent: esc(agent.name), model: esc(S.model || tx("the default model")) })}</span>` });
  // The daemon that ran this tab still runs: re-attach to its agent and shell
  // (not to a CLI agent's process: the tab runs Paw Agent now).
  const live = t.live && daemon.instance && t.live.instance === daemon.instance ? t.live : null;
  let attach = null;
  if (live) {
    attach = await invoke("daemon_attach", {
      procs: live.proc != null && !fromCli ? [live.proc] : [], shells: live.shell != null ? [live.shell] : [], after: live.dseq ?? 0,
    }).catch(() => null);
  }
  // The last prompt's turn: an answer still coming in goes in its block.
  S.turnId = [...S.lines].reverse().find((l) => l.turn != null)?.turn ?? null;
  if (t.task) S.task = restoreTask(t.task, { live: !!attach });
  if (t.factory) S.factory = t.factory;
  if (t.stepOf) S.stepOf = t.stepOf;
  if (t.nodeOf) S.nodeOf = t.nodeOf;
  if (t.sandboxMode) S.sandboxMode = t.sandboxMode;
  if (t.sandboxPrograms) S.sandboxPrograms = t.sandboxPrograms;
  if (t.sandboxStarted && attach) S.sandboxStarted = t.sandboxStarted;
  if (t.group) S.group = t.group;
  sessions.set(S.sid, S);
  openTabs.push(S.sid);
  const procAlive = attach?.procs?.[String(live.proc)];
  if (procAlive) {
    S.proc = live.proc;
    S.info = procAlive.info;
    S.agentCwd = procAlive.info.cwd;
    procToSid.set(S.proc, S.sid);
    S.busy = procAlive.paw ? !!procAlive.working : live.busy;
    S.busySince = live.busySince;
    S.working = live.working && (procAlive.paw ? !!procAlive.working || live.busy : true);
    S.turnStarted = live.turnStarted;
    S.dseq = live.dseq;
  }
  if (attach?.shells?.includes(live.shell)) {
    S.shell = live.shell;
    shellToSid.set(S.shell, S.sid);
    S.shellBusy = live.shellBusy;
    S.shellCmd = live.shellCmd;
    S.shellSince = live.shellSince;
  }
  // A factory node's tab: its conversation again (live, or as saved).
  if (S.nodeOf) {
    S.lines = [];
    if (S.shell == null) openShell(S);
    loadNodeSession(S);
    return S;
  }
  if (procAlive || S.shell != null) {
    dropRestoreNotes(S);
    S.lines.push({ stream: "system", ts: Date.now(), restore: true,
      text: procAlive?.info.status === "running" ? tx("— re-attached · {name} kept running while Paw's window was closed —", { name: S.agent.name }) : tx("— re-attached —") });
    convertedNote();
    // What happened meanwhile, once every tab is back (restoreWorkspace).
    S.replay = attach.events ?? [];
    reloadThumbs(S);
    if (S.shell == null) openShell(S);
    if (!procAlive && S.mode !== "oneshot") startProc(S, undefined, { resume: !!(S.agent.continuity === "session" && S.session) });
    return S;
  }
  const resumable = S.agent.continuity === "session" && S.session;
  const replay = S.agent.continuity === "replay" && S.turns.length;
  const how = note ?? tx("restored after restart");
  dropRestoreNotes(S);
  S.lines.push({ stream: "system", ts: Date.now(), restore: true,
    text: resumable ? tx("— {how} · attached to {name} session {id} (conversation continues) —", { how, name: S.agent.name, id: String(S.session).slice(0, 8) })
      : replay ? tx(S.turns.length > 1 ? "— {how} · {name} gets the {n} earlier turns with your next prompt (conversation continues) —" : "— {how} · {name} gets the {n} earlier turn with your next prompt (conversation continues) —", { how, name: S.agent.name, n: S.turns.length })
      : tx("— {how} · no earlier conversation to continue —", { how }) });
  convertedNote();
  reloadThumbs(S);
  openShell(S);
  if (S.mode !== "oneshot") {
    startProc(S, undefined, { resume: !!resumable });
  }
  return S;
}

/** Recreate the tabs from the last run. Returns true if anything was restored. */
async function restoreWorkspace() {
  const ws = await invoke("load_workspace").catch(() => null);
  const tabs = ws?.tabs ?? [];
  let restored = 0;
  for (const t of tabs) if (await restoreTab(t)) restored++;
  for (const g of ws?.groups ?? []) if (g?.id && GROUP_COLORS[g.color]) groups.set(g.id, { id: g.id, name: g.name ?? "", color: g.color, collapsed: !!g.collapsed, task: g.task });
  relinkTasks();
  // Tasks from before groups get theirs; tabs of groups that are gone leave them.
  for (const S of sessions.values()) if (S.group && !groups.has(S.group)) delete S.group;
  for (const S of sessions.values()) if (S.task) ensureTaskGroup(S);
  for (const S of sessions.values()) {
    const T = S.stepOf ? [...sessions.values()].find((x) => x.task?.id === S.stepOf.task) : null;
    if (T && !S.group) addToGroup(S, T.group, false);
  }
  dropEmptyGroups();
  // Events the window missed while it was gone (re-attached tabs), in order.
  const missed = [...sessions.values()].flatMap((S) => S.replay ?? []).sort((a, b) => a.dseq - b.dseq);
  for (const S of sessions.values()) delete S.replay;
  replayEvents(missed);
  for (const T of sessions.values()) if (T.task?.state === "running") taskPump(T);
  if (restored) select(openTabs[Math.min(ws.active ?? 0, openTabs.length - 1)]);
  return restored > 0;
}

// ---------- approval cards ----------
// Agents run headless, so an action that needs approval is declined. When an
// agent reports which actions it declined (Claude's `permission_denials`),
// Paw shows a card: Allow once · Always in this folder · Deny. Allowing
// restarts the agent on the same conversation with exactly that action
// allowed (the agent's `allow_template`) and tells it to go ahead.
// Agents that don't report denials but say "needs approval" get a card that
// re-runs once at a higher approval level instead.

let nextCardId = 1;
const LEVEL_ORDER = ["plan", "ask", "edits", "auto", "full"];

/** What the user approves, and the agent's rule for it. */
function denialToItem(d) {
  const i = d.tool_input ?? {};
  if (d.tool_name === "Bash" && i.command) return { label: `$ ${i.command}`, rule: `Bash(${i.command})` };
  const target = i.file_path || i.notebook_path || i.url || i.path || i.pattern || "";
  return { label: `${d.tool_name}${target ? ` ${target}` : ""}`, rule: d.tool_name, broad: true };
}

/** Rules to pass at launch: saved "always" rules for this agent + folder, plus one-time ones. */
function allowRulesFor(S) {
  const saved = (settings.allow_rules ?? []).filter((r) => r.agent === S.agent.id && r.folder === S.cwd).map((r) => r.rule);
  return [...new Set([...saved, ...(S.onceAllow ?? [])])];
}
// Deprecated: CLI agents (CLI_AGENTS). Allow rules as a CLI's command-line flags.
function allowArgs(S) {
  const t = S.agent.allow_template;
  if (!t || !t.includes("{rule}")) return "";
  return allowRulesFor(S).map((r) => " " + t.replaceAll("{rule}", shq(r))).join("");
}

function addApprovalCard(S, card) {
  pushLine(S, { stream: "approval", id: nextCardId++, state: "pending", agentName: S.agent.name, ts: Date.now(), turn: S.turnId ?? undefined, ...card });
  if (!paneOf(S)) { S.unread++; renderTabs(); renderSidebar(); }
}

/** Claude-format result events list what was declined. */
function checkDenials(S, l) {
  if (l.stream !== "stdout" || !l.text.includes('"permission_denials"')) return;
  let ev;
  try { ev = JSON.parse(l.text); } catch { return; }
  S.reportsDenials = true;
  const denials = ev?.permission_denials ?? [];
  if (!denials.length) return;
  // One card per action; repeated attempts at the same action count once.
  const items = [];
  for (const d of denials) {
    const it = denialToItem(d);
    if (!items.some((x) => x.rule === it.rule && x.label === it.label)) items.push(it);
  }
  addApprovalCard(S, { kind: "rules", items, canAllow: !!S.agent.allow_template });
}

const NEEDS_APPROVAL = /requires? (your )?approval|needs? (your )?(approval|permission)|approval (is )?required|permission (was )?denied|not (allowed|permitted) to (run|execute|write|edit|modify)/i;
/** Agents without structured denials: look for the words, offer a higher level. */
function checkApprovalText(S) {
  if (S.reportsDenials || S.mode !== "oneshot") return;
  const out = (S.runLines ?? []).map((t) => PawThemes.stripAnsi(t)).join("\n");
  if (!NEEDS_APPROVAL.test(out)) return;
  const levels = approvalLevels(S.agent);
  const current = LEVEL_ORDER.indexOf(S.approval);
  const target = levels.includes("full") ? "full" : LEVEL_ORDER.slice(current + 1).find((l) => levels.includes(l));
  addApprovalCard(S, { kind: "level", target: target ?? null, items: [{ label: tx("{name} said an action needs approval", { name: S.agent.name }) }] });
}

async function decideApproval(S, card, choice) {
  if (card.state !== "pending") return;
  if (card.kind === "paw") return decidePaw(S, card, choice);
  if (choice === "deny") {
    card.state = "denied";
    inPane(S, renderOutput);
    saveWorkspaceSoon();
    return;
  }
  if (card.kind === "rules") {
    if (choice === "always") {
      settings.allow_rules ??= [];
      for (const it of card.items) {
        if (!settings.allow_rules.some((r) => r.agent === S.agent.id && r.folder === S.cwd && r.rule === it.rule)) {
          settings.allow_rules.push({ agent: S.agent.id, folder: S.cwd, rule: it.rule, label: it.label });
        }
      }
      await invoke("save_settings", { settings }).catch(() => {});
    } else {
      S.onceAllow = [...new Set([...(S.onceAllow ?? []), ...card.items.map((i) => i.rule)])];
      S.onceTurn = true;
    }
  } else {
    if (!card.target) return;
    if (choice === "always") S.approval = card.target;
    else { S.levelOverride = card.target; S.onceTurn = true; }
  }
  card.state = choice;
  inPane(S, renderOutput);
  // Same conversation, now with the allowance; then ask the agent to go ahead.
  if (S.mode !== "oneshot") await restart(S, null, { resume: true, quiet: true });
  const what = card.kind === "rules" ? card.items.map((i) => i.label).join(", ") : "the action you couldn't do";
  await sendToAgent(S, `Approved: ${what}. Please go ahead and do it now.`);
}

/** Paw Agent waits on the tool call: the decision goes straight to it. */
async function decidePaw(S, card, choice) {
  const it = card.items[0] ?? {};
  const decision = choice === "denied" ? "deny" : choice;
  try {
    await invoke("paw_agent_approve", { id: card.proc, request: card.request, decision, rule: it.rule ?? null });
    card.state = choice;
  } catch (e) {
    card.state = "expired";
    sys(S, `✗ ${e}`);
  }
  S.waitingApproval = Math.max(0, (S.waitingApproval ?? 1) - 1);
  if (choice === "always" && card.state === "always") {
    // A factory node's tab: the rule is the factory's (its next nodes and runs have it).
    const agent = S.nodeOf ? `factory:${S.nodeOf.factory}` : S.agent.id;
    settings.allow_rules ??= [];
    if (!settings.allow_rules.some((r) => r.agent === agent && r.folder === S.cwd && r.rule === it.rule)) {
      settings.allow_rules.push({ agent, folder: S.cwd, rule: it.rule, label: it.broad ? "every file change" : it.label });
      await invoke("save_settings", { settings }).catch(() => {});
    }
  }
  inPane(S, renderOutput);
  saveWorkspaceSoon();
  refresh(S);
}

/** After the approved turn, a one-time allowance is withdrawn again. */
async function endOnceAllowance(S) {
  if (!S.onceTurn) return;
  S.onceTurn = false;
  S.onceAllow = [];
  S.levelOverride = null;
  if (S.mode !== "oneshot" && isRunning(S)) await restart(S, null, { resume: true, quiet: true });
}

function renderApprovalCard(S, l) {
  const el = div("tl approval-card " + l.state);
  const title = l.state === "pending"
    ? (l.kind === "rules" || l.kind === "paw" ? tx("{name} needs your approval for:", { name: esc(l.agentName) }) : tx("{name} couldn't do something that needs approval.", { name: esc(l.agentName) }))
    : { once: tx("✓ Allowed once"), always: tx("✓ Always allowed in this folder"), denied: tx("✗ Denied"),
        expired: tx("— No longer waiting (the turn ended)") }[l.state] ?? "";
  const paw = l.kind === "paw";
  const broadText = (i) => (paw ? tx("allows every file change in this folder") : tx("allows every {rule} action", { rule: esc(i.rule) }));
  const list = (l.items ?? []).filter(() => l.kind === "rules" || paw)
    .map((i) => `<div class="ap-item"><code>${esc(i.label)}</code>${i.broad && l.state === "pending" ? ` <span class="dim">${tx("(“Always” {what})", { what: broadText(i) })}</span>` : ""}</div>`).join("");
  // Auto mode stopped to ask: say why.
  const why = paw && l.items?.[0]?.why ? `<div class="ap-why">${tx("Auto mode asks because {why}.", { why: esc(l.items[0].why) })}</div>` : "";
  el.innerHTML = `<div class="ap-title"><span class="ap-icon">${l.state === "pending" ? "⚠" : ""}</span>${title}</div>${list}${why}`;
  // The change or command in full, folded.
  const detail = paw && l.items?.[0]?.detail;
  if (detail && detail !== l.items[0].label.replace(/^\$ /, "")) {
    el.appendChild(fold("ap-detail", `<span class="dim">${l.tool === "shell" ? tx("Show command") : tx("Show change")}</span>`, detail));
  }
  if (l.state !== "pending") return el;
  const row = div("ap-actions");
  const btn = (label, choice, cls = "") => {
    const b = document.createElement("button");
    b.className = "ap-btn " + cls;
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); decideApproval(S, l, choice); };
    row.appendChild(b);
  };
  if ((l.kind === "rules" || paw) && l.canAllow) {
    btn(tx("Allow once"), "once", "primary");
    btn(tx("Always in this folder"), "always");
  } else if (l.kind === "level" && l.target) {
    btn(tx("Run again with “{level}” once", { level: l.target }), "once", "primary");
    btn(tx("Use “{level}” for this tab", { level: l.target }), "always");
  } else {
    row.appendChild(div("dim", l.kind === "rules"
      ? tx("{name} has no way to allow a single action yet — set its allow template in Settings › Agents.", { name: esc(l.agentName) })
      : tx("Set up approval levels for {name} in Settings › Agents to allow more.", { name: esc(l.agentName) })));
  }
  btn(l.kind === "level" ? tx("Dismiss") : tx("Deny"), "denied", "ghost");
  el.appendChild(row);
  return el;
}

// ---------- theme ----------
// The terminal follows the theme picked for the current system appearance
// (Settings › Appearance). Program colors use the theme's 16-color palette
// unless "extended palette" is off for that appearance.
let ansiColors = true;
const ansi = (text) => PawThemes.ansiToHtml(text, ansiColors);

function applyCurrentTheme() {
  const { theme, extended } = PawThemes.activeTheme(settings);
  const opacity = settings.appearance?.opacity ?? 0.94;
  for (const P of panes.values()) PawThemes.applyTheme(P.root, theme, extended, opacity);
  PawThemes.applyChrome(document.documentElement, theme); // the tab bar and sidebar too
  document.documentElement.style.setProperty("--win-opacity", String(opacity));
  for (const s of sessions.values()) if (s.term) s.term.term.options.theme = xtermTheme();
  if (extended !== ansiColors) {
    ansiColors = extended;
    for (const P of panes.values()) withPane(P, renderOutput);
  }
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyCurrentTheme);

// ---------- font ----------
// Settings › Appearance › Font: family, size and line spacing for the
// transcript, prompt and terminal view. ⌘+ / ⌘− / ⌘0 change the size.
const FONT_DEFAULT = 12.5;
const FONT_MIN = 9, FONT_MAX = 28;
const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';
function fontFamilyCss() {
  const f = String(settings.appearance?.font_family ?? "").trim().replace(/["\\]/g, "");
  return f ? `"${f}", ${MONO_FALLBACK}` : MONO_FALLBACK;
}
const fontSize = () => Math.min(FONT_MAX, Math.max(FONT_MIN, Number(settings.appearance?.font_size) || FONT_DEFAULT));
const lineHeight = () => Math.min(2.4, Math.max(1, Number(settings.appearance?.line_height) || 1.6));
function applyFonts() {
  const root = document.documentElement.style;
  root.setProperty("--term-family", fontFamilyCss());
  root.setProperty("--term-size", `${fontSize()}px`);
  root.setProperty("--term-lh", String(lineHeight()));
  for (const S of sessions.values()) {
    if (!S.term) continue;
    S.term.term.options.fontFamily = fontFamilyCss();
    S.term.term.options.fontSize = fontSize();
    if (S.raw) requestAnimationFrame(() => fitTerm(S));
  }
}

let fontSaveTimer = null, toastTimer = null;
/** ⌘+ / ⌘− / ⌘0: a bigger, smaller or the default size, saved like the setting. */
function stepFontSize(dir) {
  const now = fontSize();
  const next = dir === 0 ? FONT_DEFAULT : Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round((now + dir) * 2) / 2));
  settings.appearance = { ...(settings.appearance ?? {}), font_size: next };
  applyFonts();
  for (const P of panes.values()) { const out = P.root.querySelector('[data-id="output"]'); if (out) out.scrollTop = out.scrollHeight; }
  let toast = document.querySelector(".font-toast");
  if (!toast) { toast = div("font-toast"); document.body.appendChild(toast); }
  toast.textContent = `${next} px${next === FONT_DEFAULT ? ` · ${tx("default")}` : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 900);
  clearTimeout(fontSaveTimer);
  fontSaveTimer = setTimeout(() => invoke("save_settings", { settings }).catch(() => {}), 400);
}

// ---------- rendering: tabs, sidebar, header ----------
function tabLabel(S) {
  if (S.task) return taskTabLabel(S);
  if (S.factory) return factoryTabLabel(S);
  if (S.title) return S.title; // the name the user gave it
  const step = stepOfTab(S)?.st;
  if (step) return step.title;
  return `${modelShort(S.model) || S.agent.name} · ${basename(S.cwd)}`;
}

function renderTabs() {
  trayUpdateSoon();
  menuState();
  const tabs = $("tabs");
  tabs.innerHTML = "";
  const shown = new Set();
  for (const sid of openTabs) {
    const S = sessions.get(sid);
    if (!S) continue;
    const g = S.group ? groups.get(S.group) : null;
    if (g && !shown.has(g.id)) { shown.add(g.id); tabs.appendChild(groupChip(g)); }
    // A folded group shows only the tab you're on (and ones open in a split).
    if (g?.collapsed && sid !== activeId && !paneOf(S)) continue;
    const t = document.createElement("div");
    const step = stepOfTab(S);
    t.className = "tab" + (sid === activeId ? " active" : paneOf(S) ? " visible" : "") + (S.task ? " task-tab" : step ? " step-tab" : "") + (g ? " in-group" : "");
    if (g) t.style.setProperty("--g", GROUP_COLORS[g.color] ?? GROUP_COLORS.grey);
    const runs = S.model ? `${S.agent.name} · ${S.model}` : S.agent.name;
    t.title = S.task ? tx("Plan: {goal} — by {runs}", { goal: S.task.goal || tx("new"), runs }) : step ? tx("Step of the plan {plan}: {runs} — {folder}", { plan: step.T.task.title, runs, folder: tildify(S.cwd) }) : `${runs} — ${tildify(S.cwd)}`;
    const needs = S.task ? taskNeedsYou(S) : 0;
    t.innerHTML = (S.task ? `<span class="task-ico" aria-hidden="true"></span>` : "") +
      `<span class="dot ${S.task ? taskDotState(S) : S.factory ? factoryDotState(S) : sessionState(S)}"></span><span class="label">${esc(tabLabel(S))}</span>` +
      (needs ? `<span class="tab-badge" title="${tx(needs > 1 ? "{n} steps waiting for your approval" : "{n} step waiting for your approval", { n: needs })}">${needs}</span>` : "") +
      `${S.unread ? `<span class="tab-unread"></span>` : ""}<button class="close" title="${tx("Close tab (⌘W)")}">×</button>`;
    t.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); closeSession(sid); } };
    t.dataset.sid = sid;
    t.addEventListener("pointerdown", (e) => startTabDrag(e, t));
    t.onclick = () => select(sid);
    t.oncontextmenu = (e) => { e.preventDefault(); tabMenu(S, e.clientX, e.clientY); };
    t.querySelector(".close").onclick = (e) => { e.stopPropagation(); closeSession(sid); };
    tabs.appendChild(t);
  }
  renderSessionList();
  renderFactoryNav();
}

// ---------- dragging tabs ----------
// Drag a tab to move it. A tab in a group moves among the group's tabs; any
// other tab moves among the ungrouped tabs and whole groups (it never lands
// inside one). Dragging a group's chip moves the whole group. The tab follows
// the pointer and the others make room; the order is kept when you let go.

const tabSid = (el) => openTabs.find((sid) => String(sid) === el.dataset.sid);

function startTabDrag(e, el) {
  if (e.button !== 0 || e.target.closest(".close, input")) return;
  const x0 = e.clientX;
  let d = null;
  const move = (ev) => {
    if (!d) {
      if (Math.abs(ev.clientX - x0) < 5) return;
      d = beginTabDrag(el, x0);
      if (!d) return stop();
    }
    dragTabTo(d, ev.clientX);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  const up = () => { stop(); if (d) endTabDrag(d); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** What can move where: units of elements (a tab, or a group's chip and tabs). */
function beginTabDrag(el, x0) {
  const kids = [...$("tabs").children];
  const gid = el.classList.contains("tab") ? sessions.get(tabSid(el))?.group : null;
  let units;
  if (gid) {
    units = kids.filter((k) => k.classList.contains("tab") && sessions.get(tabSid(k))?.group === gid).map((k) => [k]);
  } else {
    units = [];
    for (const k of kids) {
      if (k.classList.contains("tab-group")) units.push([k]);
      else if (k.classList.contains("tab") && k.classList.contains("in-group") && units.length) units[units.length - 1].push(k);
      else if (k.classList.contains("tab")) units.push([k]);
    }
  }
  const idx = units.findIndex((u) => u.includes(el));
  if (idx < 0 || units.length < 2) return null;
  const unit = units[idx];
  unit.forEach((u) => u.classList.add("dragging"));
  document.body.classList.add("tab-dragging");
  return { units, idx, gid, el, grab: x0 - unit[0].getBoundingClientRect().left, shift: 0 };
}

const unitBox = (u) => ({ left: u[0].getBoundingClientRect().left, right: u[u.length - 1].getBoundingClientRect().right });

function dragTabTo(d, x) {
  for (let guard = 0; guard < d.units.length; guard++) {
    const unit = d.units[d.idx];
    const natural = unit[0].getBoundingClientRect().left - d.shift;
    d.shift = x - d.grab - natural;
    for (const u of unit) u.style.transform = `translateX(${d.shift}px)`;
    // Its leading edge past the middle of a neighbor: swap places with it
    // (edges, not middles, so a wide group passes a narrow tab, and back).
    const box = unitBox(unit);
    const next = d.units[d.idx + 1], prev = d.units[d.idx - 1];
    const middle = (u) => (unitBox(u).left + unitBox(u).right) / 2;
    if (next && box.right > middle(next)) {
      next[next.length - 1].after(...unit);
      [d.units[d.idx], d.units[d.idx + 1]] = [next, unit];
      d.idx++;
    } else if (prev && box.left < middle(prev)) {
      prev[0].before(...unit);
      [d.units[d.idx], d.units[d.idx - 1]] = [prev, unit];
      d.idx--;
    } else return;
  }
}

function endTabDrag(d) {
  for (const u of d.units[d.idx]) { u.style.transform = ""; u.classList.remove("dragging"); }
  document.body.classList.remove("tab-dragging");
  // The click that ends a drag isn't a click on the tab (or the chip).
  const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 300);
  const members = (gid) => openTabs.filter((sid) => sessions.get(sid)?.group === gid);
  let order;
  if (d.gid) {
    // Within the group; tabs a folded group hides keep their places.
    const shown = d.units.map((u) => tabSid(u[0]));
    let i = 0;
    const inGroup = members(d.gid).map((sid) => (shown.includes(sid) ? shown[i++] : sid));
    order = [];
    let placed = false;
    for (const sid of openTabs) {
      if (sessions.get(sid)?.group !== d.gid) order.push(sid);
      else if (!placed) { order.push(...inGroup); placed = true; }
    }
  } else {
    order = d.units.flatMap((u) => (u[0].classList.contains("tab-group") ? members(u[0].dataset.group) : [tabSid(u[0])]));
  }
  for (const sid of openTabs) if (!order.includes(sid)) order.push(sid); // anything not shown stays
  openTabs = order.filter((sid) => sid !== undefined);
  renderTabs();
  saveWorkspaceSoon();
}

// ---------- tab groups ----------
// Like Chrome's: a colored chip in the tab bar, then its tabs, underlined in
// its color. Clicking the chip folds the group (only the tab you're on stays
// visible). A task and its step tabs are a group of their own, folded by
// default. Right-click a tab to group it; right-click a chip to rename,
// recolor, ungroup or close the group. A group's tabs stay next to each other.

const groups = new Map(); // id → { id, name, color, collapsed, task? }
const GROUP_COLORS = {
  blue: "#4a8cf7", purple: "#9a6bea", green: "#3fa55b", orange: "#e8823a", pink: "#e0609e",
  cyan: "#2fa8b8", red: "#e5534b", yellow: "#d4a72c", grey: "#8b8f98",
};
const GROUP_COLOR_NAMES = {
  blue: tx("blue"), purple: tx("purple"), green: tx("green"), orange: tx("orange"), pink: tx("pink"),
  cyan: tx("cyan"), red: tx("red"), yellow: tx("yellow"), grey: tx("grey"),
};
let groupSeq = 1;
const groupMembers = (gid) => openTabs.map((sid) => sessions.get(sid)).filter((S) => S?.group === gid);
function groupName(g) {
  if (g.name) return g.name;
  if (g.task) return [...sessions.values()].find((S) => S.task?.id === g.task)?.task.title || tx("Task");
  return "";
}
function freeColor() {
  const used = new Set([...groups.values()].map((g) => g.color));
  return Object.keys(GROUP_COLORS).find((c) => !used.has(c)) ?? Object.keys(GROUP_COLORS)[groups.size % 9];
}
function createGroup(members, opts = {}) {
  const g = { id: `g${Date.now().toString(36)}${(groupSeq++).toString(36)}`, name: "", color: freeColor(), collapsed: false, ...opts };
  groups.set(g.id, g);
  for (const S of members) addToGroup(S, g.id, false);
  renderTabs();
  saveWorkspaceSoon();
  return g;
}
/** Join a group, next to its other tabs. */
function addToGroup(S, gid, render = true) {
  const others = groupMembers(gid).filter((x) => x !== S);
  S.group = gid;
  if (others.length) {
    openTabs.splice(openTabs.indexOf(S.sid), 1);
    openTabs.splice(openTabs.indexOf(others[others.length - 1].sid) + 1, 0, S.sid);
  }
  dropEmptyGroups();
  if (render) { renderTabs(); saveWorkspaceSoon(); }
}
/** Leave the group: the tab goes right after it. */
function removeFromGroup(S) {
  const gid = S.group;
  if (!gid) return;
  delete S.group;
  const rest = groupMembers(gid);
  if (rest.length) {
    openTabs.splice(openTabs.indexOf(S.sid), 1);
    openTabs.splice(openTabs.indexOf(rest[rest.length - 1].sid) + 1, 0, S.sid);
  }
  dropEmptyGroups();
  renderTabs();
  saveWorkspaceSoon();
}
function dropEmptyGroups() {
  for (const gid of groups.keys()) if (!groupMembers(gid).length) groups.delete(gid);
}
/** A task tab's group (its steps join it); made on first need. */
function ensureTaskGroup(T) {
  if (T.group && groups.has(T.group)) return T.group;
  return createGroup([T], { task: T.task.id, collapsed: true }).id;
}
function toggleGroup(g) {
  g.collapsed = !g.collapsed;
  renderTabs();
  saveWorkspaceSoon();
}

function groupChip(g) {
  const members = groupMembers(g.id);
  const color = GROUP_COLORS[g.color] ?? GROUP_COLORS.grey;
  const name = groupName(g);
  const busy = members.some((S) => (S.task ? taskDotState(S) : S.factory ? factoryDotState(S) : sessionState(S)) === "running");
  const needs = members.reduce((n, S) => n + (S.task ? taskNeedsYou(S) : 0), 0);
  const el = document.createElement("div");
  el.className = "tab-group" + (g.collapsed ? " collapsed" : "") + (name ? "" : " unnamed");
  el.style.setProperty("--g", color);
  const one = members.length === 1;
  el.title = tx(g.collapsed ? (one ? "{name} · {n} tab — click to show, right-click for more" : "{name} · {n} tabs — click to show, right-click for more")
    : (one ? "{name} · {n} tab — click to fold, right-click for more" : "{name} · {n} tabs — click to fold, right-click for more"), { name: name || tx("Group"), n: members.length });
  el.innerHTML = (g.task ? `<span class="tg-ico" aria-hidden="true"></span>` : "") +
    `<span class="tg-name">${esc(name)}</span>` +
    (g.collapsed ? `<span class="tg-count">${members.length}</span>` : "") +
    (busy ? `<span class="tg-busy" title="${tx("Working")}"></span>` : "") +
    (needs ? `<span class="tab-badge" title="${tx("{n} waiting for your approval", { n: needs })}">${needs}</span>` : "");
  el.onclick = () => toggleGroup(g);
  el.ondblclick = (e) => { e.preventDefault(); renameGroup(g); };
  el.oncontextmenu = (e) => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); };
  el.dataset.group = g.id;
  el.addEventListener("pointerdown", (e) => startTabDrag(e, el));
  return el;
}

/** Name the group in place, on its chip. */
function renameGroup(g) {
  renderTabs();
  const chip = $("tabs").querySelector(`.tab-group[data-group="${g.id}"]`);
  if (!chip) return;
  chip.onclick = null;
  const input = document.createElement("input");
  input.className = "tg-input";
  input.value = groupName(g);
  input.placeholder = tx("Name this group");
  input.size = Math.max(8, input.value.length + 1);
  chip.querySelector(".tg-name").replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) g.name = input.value.trim();
    renderTabs();
    saveWorkspaceSoon();
    $("input").focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.oninput = () => { input.size = Math.max(8, input.value.length + 1); };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

// A context menu in the shared #menu element: items are
// { label, sub?, run } or "-" for a separator, or { swatches: [...] }.
function contextMenu(x, y, items) {
  const menu = $("menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it === "-") { menu.appendChild(div("menu-sep")); continue; }
    if (it.swatches) {
      const row = div("menu-swatches");
      for (const c of Object.keys(GROUP_COLORS)) {
        const b = document.createElement("button");
        b.className = "swatch" + (c === it.current ? " on" : "");
        b.style.background = GROUP_COLORS[c];
        b.title = GROUP_COLOR_NAMES[c] ?? c;
        b.onclick = () => { closeMenu(); it.pick(c); };
        row.appendChild(b);
      }
      menu.appendChild(row);
      continue;
    }
    const b = document.createElement("button");
    b.className = "menu-item" + (it.dot ? " with-dot" : "");
    b.innerHTML = (it.dot ? `<span class="mi-dot" style="background:${it.dot}"></span>` : "") +
      `<span class="mi-name">${esc(it.label)}</span>` + (it.sub ? `<span class="mi-sub">${esc(it.sub)}</span>` : "");
    b.onclick = () => { closeMenu(); it.run(); };
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y))}px`;
}

// ---------- selected text ----------
// Right-click on text selected in a transcript (or a task's board): Copy, or
// Create a task from it, the way /task does: the tab's agent plans it, in the
// tab's folder, in a new task tab. Long selections go along as a pasted-text
// badge, so the task's prompt stays readable.

/** The selection's text, if it's inside a transcript or task board, and that tab. */
function selectionInTranscript() {
  const sel = window.getSelection();
  const text = String(sel ?? "");
  if (!text.trim() || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  if (!node?.closest?.(".output, .task-view")) return null;
  const P = [...panes.values()].find((p) => p.root.contains(node));
  const S = sessions.get(P?.sid) ?? curS();
  return S ? { text, S } : null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function taskFromText(S, text) {
  const goal = text.trim();
  if (shouldBadge(goal)) return newTask({ model: S.model, cwd: S.cwd, goal: "", atts: [pastedAttachment(goal)] });
  return newTask({ model: S.model, cwd: S.cwd, goal });
}

// A right-click (or ⌃-click) inside the selection keeps it: WebKit would
// otherwise move the caret there, or select the word under the pointer.
let heldSelection = null;
const inRange = (range, x, y) => [...range.getClientRects()].some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
document.addEventListener("mousedown", (e) => {
  if (e.button !== 2 && !(e.button === 0 && e.ctrlKey)) { heldSelection = null; return; }
  const sel = window.getSelection();
  const range = sel.rangeCount && String(sel).trim() ? sel.getRangeAt(0).cloneRange() : null;
  heldSelection = range && inRange(range, e.clientX, e.clientY) ? range : null;
  if (heldSelection && selectionInTranscript()) e.preventDefault();
}, true);

document.addEventListener("contextmenu", (e) => {
  if (e.target.closest?.(".tab, .tab-group, textarea, input")) return;
  // Lost on the way here anyway: put it back.
  if (heldSelection && (!String(window.getSelection()).trim() || !inRange(window.getSelection().getRangeAt(0), e.clientX, e.clientY))) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(heldSelection);
  }
  heldSelection = null;
  const hit = selectionInTranscript();
  if (!hit) return;
  e.preventDefault();
  const { text, S } = hit;
  const lines = text.trim().split("\n").length;
  contextMenu(e.clientX, e.clientY, [
    { label: tx("Copy"), sub: "⌘C", run: () => copyText(text) },
    { label: tx("Make a plan"), sub: lines > 1 ? tx("{n} lines", { n: lines }) : "", run: () => taskFromText(S, text) },
  ]);
});

function tabMenu(S, x, y) {
  const items = [{ label: tx("Add to new group"), run: () => { const g = createGroup([S]); renameGroup(g); } }];
  for (const g of groups.values()) {
    if (g.id === S.group) continue;
    items.push({ label: tx("Add to “{group}”", { group: groupName(g) || tx("unnamed group") }), dot: GROUP_COLORS[g.color], run: () => addToGroup(S, g.id) });
  }
  if (S.group) items.push({ label: tx("Remove from group"), run: () => removeFromGroup(S) });
  items.push({ label: isPinned("sessions", S.pawId) ? tx("Unpin in the sidebar") : tx("Pin in the sidebar"), run: () => togglePin("sessions", S.pawId) });
  // A task tab is named by its plan.
  if (!S.task) items.unshift({ label: tx("Rename…"), run: () => renameSession(S) }, "-");
  // A copy of its conversation in a new tab, going its own way from here.
  if (canFork(S)) items.splice(1, 0, { label: tx("Fork Tab"), run: () => forkTab(S) });
  items.push("-", { label: tx("Close tab"), sub: "⌘W", run: () => closeSession(S.sid) });
  contextMenu(x, y, items);
}

function groupMenu(g, x, y) {
  const members = groupMembers(g.id);
  contextMenu(x, y, [
    { label: g.collapsed ? tx("Show tabs") : tx("Fold tabs"), run: () => toggleGroup(g) },
    { label: tx("Rename…"), run: () => renameGroup(g) },
    { swatches: true, current: g.color, pick: (c) => { g.color = c; renderTabs(); saveWorkspaceSoon(); } },
    "-",
    { label: tx("Ungroup"), run: () => { for (const S of members) delete S.group; groups.delete(g.id); renderTabs(); saveWorkspaceSoon(); } },
    { label: tx(members.length === 1 ? "Close {n} tab" : "Close {n} tabs", { n: members.length }), run: async () => { for (const S of members) await closeSession(S.sid); } },
  ]);
}

// The right panel's skills and MCP servers follow the focused session: project
// skills depend on its folder, servers on its agent and folder.
const focusedS = () => sessions.get(focusedPane?.sid);
function renderSidebar() {
  const cwd = focusedS()?.cwd ?? null;
  if (cwd !== skills.cwd) scanSkills();
  syncMcp();
}

// ---------- sidebar: Specs, Factories, Sessions ----------
// They're tabs (one shows at a time). Each has a filter, and
// its items can be pinned: pinned ones come first, under "Pinned" (kept per
// section: specs by path, factories by id, sessions by their session folder).
const PIN_KINDS = ["specs", "factories", "sessions"];
const pins = Object.fromEntries(PIN_KINDS.map((k) => {
  try { return [k, new Set(JSON.parse(localStorage.getItem(`paw.pins.${k}`) || "[]"))]; } catch { return [k, new Set()]; }
}));
function togglePin(kind, key) {
  const set = pins[kind];
  set.has(key) ? set.delete(key) : set.add(key);
  try { localStorage.setItem(`paw.pins.${kind}`, JSON.stringify([...set])); } catch {}
  renderNav(kind);
}
const isPinned = (kind, key) => pins[kind]?.has(key) ?? false;
function renderNav(kind) {
  if (kind === "specs") renderSpecs();
  else if (kind === "factories") renderFactoryNav();
  else renderSessionList();
}
/** The section's filter, lower-cased ("" when empty). */
const navFilter = (kind) => ($(`${kind}-filter`)?.value ?? "").trim().toLowerCase();
const navMatches = (q, ...texts) => !q || texts.some((t) => String(t ?? "").toLowerCase().includes(q));
const PIN_SVG = `<svg viewBox="0 0 12 12"><path d="M4.5 1.5h3l-.5 3 2 1.5v1h-6v-1l2-1.5z"/><path d="M6 7v3.5"/></svg>`;
const pinButton = (kind, key) =>
  `<button class="nav-pin${isPinned(kind, key) ? " on" : ""}" data-pin="${kind}" data-key="${esc(key)}" title="${isPinned(kind, key) ? tx("Unpin") : tx("Pin to the top")}">${PIN_SVG}</button>`;
const pinnedHead = () => `<div class="nav-sub nav-pinned-head"><span class="sk-sec-title">${tx("Pinned")}</span></div>`;
// Pin buttons: before the row's own click (capture), so pinning doesn't also open it.
document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".nav-pin");
  if (!b) return;
  e.stopPropagation();
  e.preventDefault();
  togglePin(b.dataset.pin, b.dataset.key);
}, true);
document.addEventListener("input", (e) => {
  const kind = e.target.dataset?.navFilter;
  if (kind) renderNav(kind);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.dataset?.navFilter) { e.target.value = ""; renderNav(e.target.dataset.navFilter); }
});
// One section at a time, picked with the tabs above them (remembered).
let navTab = (() => { try { return localStorage.getItem("paw.navTab") || "sessions"; } catch { return "sessions"; } })();
function applyNavTab() {
  for (const b of $("nav-tabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.navtab === navTab);
    b.setAttribute("aria-selected", String(b.dataset.navtab === navTab));
  }
  document.querySelectorAll(".sidebar .nav-sec").forEach((s) => s.classList.toggle("hidden", s.dataset.sec !== navTab));
}
function setNavTab(tab) {
  navTab = tab;
  try { localStorage.setItem("paw.navTab", tab); } catch {}
  applyNavTab();
}
$("nav-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.navtab;
  if (tab) setNavTab(tab);
});
applyNavTab();

/** Edit `el`'s text in place: `done(text)` gets the trimmed text, or null when cancelled. */
function editInPlace(el, value, done) {
  const input = document.createElement("input");
  input.className = "inplace-input";
  input.value = value;
  input.spellcheck = false;
  el.replaceWith(input);
  input.focus();
  input.select();
  let over = false;
  const finish = (keep) => {
    if (over) return;
    over = true;
    const text = keep ? input.value.trim() : null;
    input.blur(); // so whatever redraws next isn't held back by a focused field
    done(text);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onclick = input.onpointerdown = input.ondblclick = (e) => e.stopPropagation();
}

/** Name a session in place: in the sidebar's list when it shows, else on its tab. Empty: its usual name. */
function renameSession(S) {
  renderTabs();
  const el = sidebarVisible()
    ? $("sessions-body").querySelector(`.nav-item[data-sid="${S.sid}"] .nav-name`)
    : $("tabs").querySelector(`.tab[data-sid="${S.sid}"] .label`);
  if (!el) return;
  editInPlace(el, tabLabel(S), (name) => {
    if (name != null) {
      delete S.title;
      if (name && name !== tabLabel(S)) S.title = name;
      saveWorkspaceSoon();
    }
    renderTabs();
  });
}

// Sessions: the open tabs, in tab order, under their tab groups.
const STATE_TEXT = { running: tx("Working"), ready: tx("Ready"), idle: tx("Idle"), starting: tx("Starting"), failed: tx("Failed"), stopped: tx("Stopped"), exited: tx("Exited") };
function sessionStatus(S) {
  if (S.factory) return factoryStatus(S.factory.id);
  if (S.task) {
    const n = taskNeedsYou(S);
    return n ? tx(n > 1 ? "{n} steps waiting for you" : "{n} step waiting for you", { n }) : tx("Plan · {state}", { state: S.task.state });
  }
  const st = sessionState(S);
  return `${STATE_TEXT[st] ?? st} · ${tildify(S.cwd)}`;
}
function sessionRow(S) {
  const row = document.createElement("div");
  row.className = "nav-item" + (S.sid === activeId ? " active" : "");
  row.title = `${S.agent.name} — ${tildify(S.cwd)}`;
  row.dataset.sid = S.sid;
  const needs = S.task ? taskNeedsYou(S) : 0;
  row.innerHTML = `<span class="dot ${S.task ? taskDotState(S) : S.factory ? factoryDotState(S) : sessionState(S)}"></span>` +
    `<span class="nav-text"><span class="nav-name">${esc(tabLabel(S))}</span><span class="nav-status">${esc(sessionStatus(S))}</span></span>` +
    (needs ? `<span class="tab-badge">${needs}</span>` : "") + (S.unread ? `<span class="tab-unread"></span>` : "") +
    pinButton("sessions", S.pawId);
  row.onclick = () => select(S.sid);
  row.oncontextmenu = (e) => { e.preventDefault(); tabMenu(S, e.clientX, e.clientY); };
  return row;
}
function renderSessionList() {
  const body = $("sessions-body");
  const open = openTabs.map((sid) => sessions.get(sid)).filter(Boolean);
  $("sessions-count").textContent = open.length || "";
  const q = navFilter("sessions");
  const shown = open.filter((S) => navMatches(q, tabLabel(S), sessionStatus(S), S.cwd));
  body.innerHTML = shown.length ? "" : `<div class="sk-empty">${q ? tx("No sessions match.") : tx("No open sessions.")}</div>`;
  const pinned = shown.filter((S) => isPinned("sessions", S.pawId));
  if (pinned.length) {
    const wrap = document.createElement("div");
    wrap.className = "nav-group nav-pinned";
    wrap.innerHTML = pinnedHead();
    for (const S of pinned) wrap.appendChild(sessionRow(S));
    body.appendChild(wrap);
  }
  const byGroup = new Map(); // tab group id ("" for none) → its tabs, where its first tab is
  for (const S of shown.filter((S) => !pinned.includes(S))) {
    const gid = S.group && groups.has(S.group) ? S.group : "";
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(S);
  }
  for (const [gid, members] of byGroup) {
    const wrap = document.createElement("div");
    wrap.className = "nav-group";
    if (gid) {
      const g = groups.get(gid);
      const head = document.createElement("div");
      head.className = "nav-sub";
      head.innerHTML = `<span class="g-dot" style="background:${GROUP_COLORS[g.color] ?? GROUP_COLORS.grey}"></span><span class="sk-sec-title">${esc(groupName(g))}</span>`;
      head.oncontextmenu = (e) => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); };
      wrap.appendChild(head);
    }
    for (const S of members) wrap.appendChild(sessionRow(S));
    body.appendChild(wrap);
  }
}

// Specs: Markdown files in named groups, linked where they are. Clicking one
// attaches it to the focused session's prompt; drag one onto another group
// (or between specs) to move it.
const specs = { groups: [], dragged: false };
function specsMsg(text, error = false) {
  const m = $("specs-msg");
  m.textContent = text;
  m.classList.toggle("error", error);
  m.classList.toggle("hidden", !text);
}
/** The groups as specs_save takes them. */
const specsData = () => specs.groups.map((g) => ({ name: g.name, specs: g.specs.map((s) => s.path) }));
async function specsCall(cmd, args) {
  const before = JSON.stringify(specs.groups);
  try {
    specs.groups = await invoke(cmd, args);
    specsMsg("");
  } catch (e) { specsMsg(String(e), true); }
  // Unchanged (a refresh on focus, mostly): leave the list, and a rename, as they are.
  if (cmd === "specs_list" && JSON.stringify(specs.groups) === before && $("specs-body").childElementCount) return;
  renderSpecs();
}
const loadSpecs = () => specsCall("specs_list");
const saveSpecs = (groups) => specsCall("specs_save", { groups });

function renderSpecs() {
  $("specs-count").textContent = specs.groups.reduce((n, g) => n + g.specs.length, 0) || "";
  $("specs-groups").innerHTML = specs.groups.map((g) => `<option value="${esc(g.name)}">`).join("");
  const body = $("specs-body");
  if (!specs.groups.length) { body.innerHTML = `<div class="sk-empty">${tx("Import Markdown specs with +.")}</div>`; return; }
  const q = navFilter("specs");
  const item = (s, si) => `<div class="nav-item${s.missing ? " missing" : ""}" data-spec="${si}" title="${esc(tildify(s.path))}${s.missing ? ` — ${tx("not there any more")}` : ` — ${tx("click to attach it to the session")}`}">
      <svg class="nav-ico" viewBox="0 0 12 12"><path d="M3 1.5h4l2.5 2.5v6.5h-6.5z"/><path d="M7 1.5v2.5h2.5"/></svg>
      <span class="nav-text"><span class="nav-name">${esc(s.title)}</span></span>
      ${pinButton("specs", s.path)}
      <button class="sk-x" data-spec-remove title="${tx("Remove from the group (the file stays)")}">×</button></div>`;
  const hit = (g, s) => navMatches(q, s.title, s.path, g.name);
  // Pinned specs: on top, each in a wrapper that still names its group (clicks and drags work as below).
  const pinned = specs.groups.flatMap((g, gi) => g.specs.map((s, si) => ({ g, s, gi, si }))).filter(({ g, s }) => isPinned("specs", s.path) && hit(g, s));
  const top = pinned.length ? `<div class="nav-pinned">${pinnedHead()}${pinned.map(({ s, gi, si }) => `<div class="nav-group" data-group="${gi}">${item(s, si)}</div>`).join("")}</div>` : "";
  const groups = specs.groups.map((g, gi) => {
    const list = g.specs.map((s, si) => [s, si]).filter(([s]) => !isPinned("specs", s.path) && hit(g, s));
    if (q && !list.length) return "";
    return `<div class="nav-group" data-group="${gi}">
      <div class="nav-sub" title="${tx("Double-click to rename")}"><span class="sk-sec-title">${esc(g.name)}</span>
        <button class="sk-sec-add" data-spec-import title="${tx("Import specs into {group}", { group: esc(g.name) })}">+</button>
        <button class="sk-x" data-group-remove title="${tx("Remove the group (the files stay)")}">×</button></div>
      ${list.length ? list.map(([s, si]) => item(s, si)).join("") : g.specs.length ? "" : `<div class="sk-empty">${tx("Drag specs here, or import with +.")}</div>`}
    </div>`;
  }).join("");
  body.innerHTML = top + groups || `<div class="sk-empty">${tx("No specs match.")}</div>`;
}

async function attachSpec(spec) {
  const S = focusedS();
  if (!S) return specsMsg(tx("Open a session to attach a spec to."), true);
  if (spec.missing) return specsMsg(tx("{path} isn't there any more.", { path: tildify(spec.path) }), true);
  try {
    const a = await invoke("describe_attachment", { path: spec.path });
    inPane(S, () => { addAttachments(S, [a]); $("input").focus(); });
    specsMsg("");
  } catch (e) { specsMsg(String(e), true); }
}

function renameSpecGroup(gi) {
  const title = $("specs-body").querySelector(`[data-group="${gi}"] .nav-sub .sk-sec-title`);
  if (!title) return;
  editInPlace(title, specs.groups[gi].name, (name) => {
    if (!name || name === specs.groups[gi].name) return renderSpecs();
    const data = specsData();
    data[gi].name = name;
    saveSpecs(data);
  });
}

/** Drag a spec with the pointer (as tabs drag): onto a group, or before a spec. */
function startSpecDrag(e, el) {
  if (e.button !== 0 || e.target.closest("button")) return;
  const from = { gi: +el.closest(".nav-group").dataset.group, si: +el.dataset.spec };
  const [x0, y0] = [e.clientX, e.clientY];
  let ghost = null, target = null;
  const groupAt = (x, y) => document.elementFromPoint(x, y)?.closest?.("#specs-body .nav-group") ?? null;
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      ghost = el.cloneNode(true);
      ghost.classList.add("nav-ghost");
      ghost.style.width = el.offsetWidth + "px";
      document.querySelector(".sidebar").appendChild(ghost);
      el.classList.add("dragging");
    }
    ghost.style.transform = `translate(${ev.clientX - 14}px, ${ev.clientY - 12}px)`;
    const g = groupAt(ev.clientX, ev.clientY);
    if (g !== target) { target?.classList.remove("drop"); target = g; target?.classList.add("drop"); }
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!ghost) return; // a click
    specs.dragged = true;
    setTimeout(() => (specs.dragged = false));
    ghost.remove();
    el.classList.remove("dragging");
    target?.classList.remove("drop");
    if (!target || ev.type === "pointercancel") return;
    const to = +target.dataset.group;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("#specs-body .nav-item[data-spec]");
    const data = specsData();
    const [path] = data[from.gi].specs.splice(from.si, 1);
    let at = data[to].specs.length;
    if (over && over.closest(".nav-group") === target) {
      at = +over.dataset.spec;
      if (to === from.gi && at > from.si) at--;
    }
    if (to === from.gi && at === from.si) return;
    data[to].specs.splice(at, 0, path);
    saveSpecs(data);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

$("specs-body").addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".nav-item[data-spec]");
  if (el) startSpecDrag(e, el);
});
$("specs-body").addEventListener("click", async (e) => {
  if (specs.dragged) return;
  const group = e.target.closest(".nav-group");
  if (!group) return;
  const gi = +group.dataset.group;
  if (e.target.closest("[data-spec-import]")) return specsCall("specs_import", { group: specs.groups[gi].name });
  if (e.target.closest("[data-group-remove]")) {
    const g = specs.groups[gi];
    if (g.specs.length && !await askSure(tx(g.specs.length > 1 ? "Remove the group “{group}”? Its {n} specs stay on disk." : "Remove the group “{group}”? Its {n} spec stays on disk.", { group: g.name, n: g.specs.length }), { yes: tx("Remove") })) return;
    // The list may have changed while you answered.
    const at = specs.groups.indexOf(g);
    if (at < 0) return;
    return saveSpecs(specsData().filter((_, i) => i !== at));
  }
  const item = e.target.closest(".nav-item[data-spec]");
  if (!item) return;
  const si = +item.dataset.spec;
  if (e.target.closest("[data-spec-remove]")) {
    const data = specsData();
    data[gi].specs.splice(si, 1);
    return saveSpecs(data);
  }
  attachSpec(specs.groups[gi].specs[si]);
});
$("specs-body").addEventListener("dblclick", (e) => {
  const head = e.target.closest(".nav-sub");
  if (head && !e.target.closest("button, input")) renameSpecGroup(+head.closest(".nav-group").dataset.group);
});
$("specs-body").addEventListener("contextmenu", (e) => {
  const head = e.target.closest(".nav-sub");
  if (!head) return;
  e.preventDefault();
  const gi = +head.closest(".nav-group").dataset.group;
  contextMenu(e.clientX, e.clientY, [
    { label: tx("Rename"), run: () => renameSpecGroup(gi) },
    { label: tx("Import Specs…"), run: () => specsCall("specs_import", { group: specs.groups[gi].name }) },
    "-",
    { label: tx("Remove Group"), run: () => saveSpecs(specsData().filter((_, i) => i !== gi)) },
  ]);
});
$("specs-add").onclick = () => {
  const row = $("specs-add-row");
  setNavTab("specs");
  row.classList.toggle("hidden");
  if (!row.classList.contains("hidden")) $("specs-group").focus();
};
$("specs-add-cancel").onclick = () => $("specs-add-row").classList.add("hidden");
$("specs-add-row").addEventListener("submit", async (e) => {
  e.preventDefault();
  const group = $("specs-group").value.trim();
  if (!group) { $("specs-group").focus(); return specsMsg(tx("Name the group the specs go into."), true); }
  await specsCall("specs_import", { group });
  $("specs-group").value = "";
  $("specs-add-row").classList.add("hidden");
});
$("specs-group").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); $("specs-add-row").classList.add("hidden"); }
});
// Linked files change outside Paw: titles and missing ones are read again.
window.addEventListener("focus", loadSpecs);
loadSpecs();
renderSessionList();

function renderHeader() {
  const S = curS();
  if (!S) return;
  $("eof").disabled = !isRunning(S) || S.mode === "oneshot";

  const ph = {
    claude: isRunning(S) ? (S.history.length ? tx("Ask a follow-up…") : tx("Ask {name} anything…", { name: S.agent.name })) : tx("Agent stopped — ⏎ restarts it and sends"),
    stdin: isRunning(S) ? tx("Write to stdin…") : tx("Process ended — ⏎ restarts it and sends"),
    oneshot: isRunning(S) ? tx("Running… (⌘. to stop)") : tx("Prompt for {name}…", { name: S.agent.name }),
  }[S.mode];
  $("input").placeholder = S.shellBusy ? tx("Input for the running command…  (Ctrl-C interrupts)") : S.task ? taskPlaceholder(S) : S.nodeOf ? nodePlaceholder(S)
    : S.terminalOnly ? tx("Type a command… (no agent yet: connect a provider in Settings › Agents)") : ph;
  updateGlyph();
  $("sl-left").textContent = [S.agent.name, S.model || tx("default model")].join("  ·  ") + "  ·";
  $("sl-path-text").textContent = shortPath(S.cwd);
  renderSandboxPill(S);
  $("sl-path").title = tx("{folder} — click to open in Finder", { folder: tildify(S.cwd) });
  renderModePill();
  renderBusy();
}

// ---------- menu bar ----------
// The 🐾 in the menu bar lists the tabs and what they're doing (closing the
// window keeps Paw running there); picking one shows it.
let trayTimer = null;
function trayUpdateSoon() {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => {
    const tabs = openTabs.map((sid) => sessions.get(sid)).filter(Boolean).map((S) => ({
      id: S.pawId,
      label: tabLabel(S),
      state: hasPendingApproval(S) || (S.task && taskNeedsYou(S)) ? "needs"
        : agentBusy(S) || (S.task && taskDotState(S) === "running") ? "working"
        : waitingPrompts.some((w) => w.S === S) ? "waiting" : "idle",
    }));
    invoke("tray_update", { tabs, working: agentsWorking() }).catch(() => {});
  }, 250);
}

function refresh(S) {
  trayUpdateSoon();
  saveWorkspaceSoon();
  renderTabs();
  renderSidebar();
  inPane(S, renderHeader);
}

function select(sid) {
  closeAc();
  // Already visible in another pane: just focus that pane.
  const other = sid != null ? paneOf(sessions.get(sid)) : null;
  if (other && other !== focusedPane) { focusPane(other); return; }
  const prev = curS();
  if (prev) prev.draft = $("input").value;
  activeId = sid;
  focusedPane.sid = sid;
  activePane = focusedPane;
  const S = sid != null ? sessions.get(sid) : null;
  $("welcome").classList.toggle("hidden", !!S || panes.size > 1);
  $("panes").classList.toggle("hidden", !S && panes.size === 1);
  if (S) {
    S.unread = 0;
    renderHeader();
    renderOutput();
    renderTaskView();
    $("input").value = S.draft ?? "";
    renderAttachments();
    autosize();
    $("input").focus();
  } else {
    renderWelcome();
    renderTaskView();
  }
  showTermView();
  renderTabs();
  renderSidebar();
}

// ---------- skills panel ----------
// System, user and project skills are what the agents load from their own
// folders (Paw only lists them). The catalogue holds skills that can be
// added: Claude plugin marketplaces found on this Mac plus folders and Git
// repositories the user adds. Adding copies a skill into the user skill
// folders; removing deletes only copies Paw added.
const skills = {
  report: null,
  cwd: undefined,         // folder of the last scan (undefined: never scanned)
  expanded: new Set(),    // "scope:name" of skills showing their details
  busy: new Set(),        // skills being added/removed
  closed: new Set(JSON.parse(localStorage.getItem("paw.skills.closed") || "[]")),
  seq: 0,
};

// ---------- external skills in sessions ----------
// Folders added under External are used where they are, by every agent:
// natively when the agent can load a skills folder (its skills_template, e.g.
// Claude Code's --plugin-dir — a running agent restarts on the same
// conversation to pick up changes), otherwise Paw tells the agent about them
// in the conversation (skills_delivery: their SKILL.md paths, or their text).
let extPromise = null;
function refreshExternal() {
  extPromise = invoke("skills_external_setup")
    .then((ext) => (skills.ext = ext))
    .catch(() => (skills.ext = { count: 0, signature: "", index: "", inline: "", plugin_dir: null }));
  return extPromise;
}
const externalSetup = () => (skills.ext ? Promise.resolve(skills.ext) : extPromise ?? refreshExternal());
const nativeSkills = (S) => isPaw(S.agent) || (S.agent.skills_template ?? "").includes("{skills}");

// Deprecated: CLI agents (CLI_AGENTS). A CLI's flag that loads the skills folder.
async function skillsArgs(S) {
  if (!nativeSkills(S)) return "";
  const ext = await externalSetup();
  S.skillsSig = ext.signature;
  return ext.plugin_dir ? " " + S.agent.skills_template.replaceAll("{skills}", shq(ext.plugin_dir)) : "";
}

/** A running native agent whose skills changed restarts on the same conversation. */
async function reloadNativeSkills(S) {
  if (!nativeSkills(S) || S.mode === "oneshot" || !isRunning(S) || isBusy(S)) return false;
  const ext = await externalSetup();
  if ((S.skillsSig ?? "") === ext.signature) return false;
  await restart(S, null, { resume: true, quiet: true });
  sys(S, ext.count ? tx("external skills reloaded ({n}) · conversation continues", { n: ext.count }) : tx("external skills removed · conversation continues"));
  return true;
}

/** Before a prompt: the note to put in front of it (agents without native skills). */
async function syncExternalSkills(S) {
  const none = { text: "", count: 0, sent() {} };
  const ext = await externalSetup();
  if (nativeSkills(S)) { await reloadNativeSkills(S); return none; }
  // One-shot agents without sessions of their own see each prompt on its own;
  // otherwise the conversation remembers the note until the skills change.
  const standalone = S.mode === "oneshot" && (S.agent.continuity !== "session" || !S.session);
  const changed = (S.skillsNoteSig ?? null) !== (ext.count ? ext.signature : null);
  if (!ext.count) {
    if (!S.skillsNoteSig || standalone) return none;
    return { text: "<skills>The external skills listed earlier are no longer available.</skills>", count: 0, sent() { S.skillsNoteSig = null; } };
  }
  if (!standalone && !changed) return none;
  const text = S.agent.skills_delivery === "inline" ? ext.inline : ext.index;
  return { text, count: ext.count, sent() { S.skillsNoteSig = ext.signature; } };
}

/** External skills changed: running native agents that are idle reload now. */
async function applyExternalSkills() {
  await refreshExternal();
  for (const S of sessions.values()) await reloadNativeSkills(S);
}

async function scanSkills() {
  const seq = ++skills.seq;
  const cwd = focusedS()?.cwd ?? null;
  skills.cwd = cwd;
  try {
    const [report] = await Promise.all([invoke("skills_scan", { cwd }), refreshExternal()]);
    if (seq !== skills.seq) return; // a newer scan is on its way
    skills.report = report;
    renderSkills();
  } catch (e) {
    skillsMsg(tx("Couldn't read skills: {error}", { error: e }), true);
  }
}

let skillsMsgTimer;
function skillsMsg(text, error = false) {
  const m = $("skills-msg");
  m.textContent = text;
  m.classList.toggle("error", error);
  m.classList.toggle("hidden", !text);
  clearTimeout(skillsMsgTimer);
  if (text && !error) skillsMsgTimer = setTimeout(() => m.classList.add("hidden"), 6000);
}

const AGENT_TAG = { "Claude Code": "Claude", Codex: "Codex", Shared: tx("Shared"), opencode: "opencode" };

function skillItem(s, scope) {
  const key = `${scope}:${s.name}:${s.paths[0]}`;
  const open = skills.expanded.has(key);
  const tags = (s.agents ?? []).map((a) => `<span class="sk-tag" title="${esc(a === "Shared" ? tx("~/.agents/skills — read by several agents") : a)}">${esc(AGENT_TAG[a] ?? a)}</span>`).join("");
  let action = "";
  const busy = skills.busy.has(s.name);
  if (scope === "catalogue") {
    if (busy) action = `<button class="sk-btn" disabled>…</button>`;
    else if (s.blocked) action = `<button class="sk-btn" disabled title="${esc(s.blocked)}">${tx("Plugin")}</button>`;
    else if (s.installed) action = `<button class="sk-btn remove" data-act="remove" title="${tx("Remove it from your skills")}">${tx("Remove")}</button>`;
    else if (s.conflict) action = `<button class="sk-btn" disabled title="${tx("You already have a skill called {name}", { name: esc(s.name) })}">${tx("In use")}</button>`;
    else action = `<button class="sk-btn add" data-act="add" title="${tx("Add it to your skills (~/.claude/skills and ~/.agents/skills)")}">${tx("Add")}</button>`;
  } else if (s.paw) {
    action = busy ? `<button class="sk-btn" disabled>…</button>`
      : `<button class="sk-btn remove" data-act="remove" title="${tx("Added from the catalogue — remove it")}">${tx("Remove")}</button>`;
  }
  const details = open ? `<div class="sk-meta">
      ${s.source ? `<div class="sk-src">${tx("from {name}", { name: esc(s.source) })}</div>` : ""}
      ${s.blocked ? `<div class="sk-note">${esc(s.blocked)}</div>` : ""}
      ${s.paths.map((p) => `<a class="sk-path" data-reveal="${esc(p)}" title="${tx("Show in Finder")}">${esc(tildify(p))}</a>`).join("")}
    </div>` : "";
  return `<div class="sk-item${open ? " open" : ""}" data-key="${esc(key)}" data-scope="${scope}" data-name="${esc(s.name)}" data-path="${esc(s.paths[0] ?? "")}">
      <div class="sk-row"><span class="sk-name">${esc(s.name)}</span>${s.paw && scope !== "catalogue" ? `<span class="sk-tag added">${tx("added")}</span>` : ""}${tags}<span class="sk-grow"></span>${action}</div>
      ${s.description ? `<div class="sk-desc">${esc(s.description)}</div>` : ""}
      ${details}
    </div>`;
}

// Each section is a card: its header (title, count, tools, a disclosure
// chevron) folds the card's body away.
const CARD_CHEVRON = `<svg class="sk-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`;

function skillSection(id, title, list, empty, extra = "", titleTip = "", tools = "") {
  const closed = skills.closed.has(id);
  return `<section class="sk-sec${closed ? " closed" : ""}" data-sec="${id}">
      <div class="sk-sec-head" title="${esc(titleTip)}"><span class="sk-sec-title">${esc(title)}</span><span class="sk-count">${list.length}</span>${tools}${CARD_CHEVRON}</div>
      <div class="sk-sec-body">${extra}${list.length ? list.join("") : `<div class="sk-empty">${esc(empty)}</div>`}</div>
    </section>`;
}

function externalFolders(r) {
  if (!r.external_folders.length) return "";
  return `<div class="sk-sources">${r.external_folders.map((f) => `<div class="sk-source${f.missing ? " missing" : ""}" title="${esc(f.path)}">
      <span class="sk-src-kind">${f.missing ? tx("gone") : f.found}</span>
      <a class="sk-src-name sk-path" data-reveal="${esc(f.path)}">${esc(tildify(f.path))}</a>
      <button class="sk-x" data-ext-remove="${esc(f.path)}" title="${tx("Stop using this folder's skills")}">×</button>
    </div>`).join("")}</div>`;
}

async function addExternalFolder(path) {
  try {
    const n = await invoke("skills_external_add", { path });
    skills.closed.delete("external");
    skillsMsg(tx(n > 1 ? "Added {n} skills from {folder} — every session uses them from the next prompt." : "Added {n} skill from {folder} — every session uses it from the next prompt.", { n, folder: tildify(path) }));
  } catch (e) { skillsMsg(String(e), true); return; }
  await scanSkills();
  await applyExternalSkills();
}

function renderSkills() {
  const r = skills.report;
  const body = $("skills-body");
  if (!r) { body.innerHTML = `<div class="sk-empty">${tx("Looking for skills…")}</div>`; return; }
  const q = $("skills-filter").value.trim().toLowerCase();
  const match = (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || (s.source ?? "").toLowerCase().includes(q);
  const items = (list, scope) => list.filter(match).map((s) => skillItem(s, scope));
  const root = r.project_root;
  const projName = root ? root.split("/").filter(Boolean).pop() : null;
  const sources = r.sources.map((src) => `<div class="sk-source" title="${esc(src.location)}">
      <span class="sk-src-kind">${src.kind === "git" ? "git" : src.kind === "folder" ? tx("folder") : tx("found")}</span>
      <span class="sk-src-name">${esc(src.label)}</span>
      ${src.kind === "detected" ? "" : `<button class="sk-x" data-remove-source="${esc(src.id)}" title="${tx("Remove this catalogue")}">×</button>`}
    </div>`).join("");
  body.innerHTML =
    skillSection("project", projName ? tx("Project · {name}", { name: projName }) : tx("Project"), items(r.project, "project"),
      focusedS() ? tx("No skills in {folder}", { folder: tildify(root ?? focusedS().cwd) }) : tx("Open a session to see its project's skills"), "", root ? tildify(root) : "") +
    skillSection("user", tx("User"), items(r.user, "user"), tx("No user skills")) +
    skillSection("system", tx("System"), items(r.system, "system"), tx("No system skills found")) +
    skillSection("external", tx("External"), items(r.external, "external"),
      r.external_folders.length ? tx("No skills match") : tx("Add a folder with skills — every session uses them where they are"),
      externalFolders(r), "", `<button class="sk-sec-add" data-ext-add title="${tx("Add a folder with skills…")}">+</button>`) +
    skillSection("catalogue", tx("Catalogue"), items(r.catalogue, "catalogue"),
      r.sources.length ? tx("No skills match") : tx("Add a folder or Git repository with +"),
      sources ? `<div class="sk-sources">${sources}</div>` : "");
}

async function skillAction(act, name, path) {
  skills.busy.add(name);
  renderSkills();
  try {
    if (act === "add") {
      const added = await invoke("skills_install", { path });
      skillsMsg(tx("Added “{name}”. New sessions load it.", { name: added }));
    } else {
      await invoke("skills_uninstall", { name });
      skillsMsg(tx("Removed “{name}”.", { name }));
    }
  } catch (e) {
    skillsMsg(String(e), true);
  } finally {
    skills.busy.delete(name);
    await scanSkills();
  }
}

async function addSkillSource(location) {
  if (!location) return;
  const go = $("skills-add-go");
  go.disabled = true;
  skillsMsg(/^(https?:|git@|ssh:)/.test(location) ? tx("Cloning…") : tx("Adding…"));
  try {
    const src = await invoke("skills_add_source", { location });
    $("skills-add-input").value = "";
    $("skills-add-row").classList.add("hidden");
    skills.closed.delete("catalogue");
    skillsMsg(tx("Added catalogue “{name}”.", { name: src.label }));
    await scanSkills();
  } catch (e) {
    skillsMsg(String(e), true);
  } finally {
    go.disabled = false;
  }
}

$("skills-body").addEventListener("click", async (e) => {
  if (e.target.closest("[data-ext-add]")) {
    e.stopPropagation();
    try { const dir = await invoke("skills_pick_folder"); if (dir) addExternalFolder(dir); }
    catch (err) { skillsMsg(String(err), true); }
    return;
  }
  const extRm = e.target.closest("[data-ext-remove]");
  if (extRm) {
    try {
      await invoke("skills_external_remove", { path: extRm.dataset.extRemove });
      skillsMsg(tx("Stopped using {folder}.", { folder: tildify(extRm.dataset.extRemove) }));
      await scanSkills();
      await applyExternalSkills();
    } catch (err) { skillsMsg(String(err), true); }
    return;
  }
  const head = e.target.closest(".sk-sec-head");
  if (head) {
    const id = head.parentElement.dataset.sec;
    skills.closed.has(id) ? skills.closed.delete(id) : skills.closed.add(id);
    try { localStorage.setItem("paw.skills.closed", JSON.stringify([...skills.closed])); } catch {}
    head.parentElement.classList.toggle("closed");
    return;
  }
  const reveal = e.target.closest("[data-reveal]");
  if (reveal) { invoke("reveal_path", { path: reveal.dataset.reveal }).catch((err) => skillsMsg(String(err), true)); return; }
  const rmSrc = e.target.closest("[data-remove-source]");
  if (rmSrc) {
    invoke("skills_remove_source", { id: rmSrc.dataset.removeSource })
      .then(() => { skillsMsg(tx("Catalogue removed.")); return scanSkills(); })
      .catch((err) => skillsMsg(String(err), true));
    return;
  }
  const item = e.target.closest(".sk-item");
  if (!item) return;
  const btn = e.target.closest("[data-act]");
  if (btn) { skillAction(btn.dataset.act, item.dataset.name, item.dataset.path); return; }
  if (String(window.getSelection())) return; // selecting text, not toggling
  // One skill's details at a time: opening another closes the last.
  const key = item.dataset.key;
  const wasOpen = skills.expanded.has(key);
  skills.expanded.clear();
  if (!wasOpen) skills.expanded.add(key);
  renderSkills();
});
$("skills-filter").addEventListener("input", renderSkills);
$("skills-refresh").onclick = () => { skillsMsg(""); scanSkills(); };
$("skills-add").onclick = () => {
  const row = $("skills-add-row");
  row.classList.toggle("hidden");
  if (!row.classList.contains("hidden")) $("skills-add-input").focus();
};
$("skills-add-go").onclick = () => addSkillSource($("skills-add-input").value.trim());
$("skills-add-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addSkillSource(e.target.value.trim()); }
  if (e.key === "Escape") { $("skills-add-row").classList.add("hidden"); $("input").focus(); }
});
$("skills-add-folder").onclick = async () => {
  try {
    const dir = await invoke("skills_pick_folder");
    if (dir) addSkillSource(dir);
  } catch (e) { skillsMsg(String(e), true); }
};
// Skills change outside Paw too (installed by another tool, edited by hand).
let skillsFocusAt = 0;
window.addEventListener("focus", () => {
  if (Date.now() - skillsFocusAt < 3000) return;
  skillsFocusAt = Date.now();
  scanSkills();
});

// ---------- MCP panel ----------
// The right-hand panel lists the MCP servers of the focused tab's agent:
// Paw Agent's own list, or the CLI agent's config files (user / project…).
// Adding, removing or switching a server writes there; running tabs of that
// agent pick it up (an idle one restarts on the same conversation, a busy
// one after its turn; one-shot agents read their config on every prompt).
const mcp = { key: null, report: null, adding: null, busy: false, seq: 0 };
const TRANSPORT_TAG = { stdio: tx("local"), http: "HTTP", sse: "SSE" };

// ---------- right panel ----------
// One panel, two tabs: the focused tab's MCP servers, and skills.
const panel = { open: false, tab: "mcp" };
try {
  panel.open = localStorage.getItem("paw.panel") === "1";
  panel.tab = localStorage.getItem("paw.panelTab") === "skills" ? "skills" : "mcp";
} catch {}
const mcpShown = () => panel.open && panel.tab === "mcp";

/** Show the panel's state; nothing is loaded. */
function applyPanel() {
  $("right-panel").classList.toggle("hidden", !panel.open);
  $("panel-resizer").classList.toggle("hidden", !panel.open);
  $("panel-toggle").classList.toggle("on", panel.open);
  for (const b of $("panel-tabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.tab === panel.tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === panel.tab));
  }
  document.querySelectorAll("#right-panel [data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== panel.tab));
}

function setPanel(open, tab = panel.tab) {
  panel.open = open;
  panel.tab = tab;
  applyPanel();
  try { localStorage.setItem("paw.panel", open ? "1" : "0"); localStorage.setItem("paw.panelTab", tab); } catch {}
  if (mcpShown()) { mcp.key = null; syncMcp(); }
}

/** The focused tab changed (or its folder): show its agent's servers. */
function syncMcp() {
  if (!mcpShown()) return;
  const S = focusedS();
  const key = S ? `${S.agent.id}|${S.cwd}` : "";
  if (key === mcp.key) return;
  mcp.key = key;
  mcp.adding = null;
  loadMcp();
}

async function loadMcp() {
  const S = focusedS();
  const seq = ++mcp.seq;
  if (!S) { mcp.report = null; renderMcp(); return; }
  try {
    const r = await invoke("mcp_list", { agent: S.agent.id, cwd: S.cwd });
    if (seq !== mcp.seq) return;
    mcp.report = r;
  } catch (e) {
    mcp.report = null;
    mcpMsg(tx("Couldn't read the MCP config: {error}", { error: e }), true);
  }
  renderMcp();
}

let mcpMsgTimer;
function mcpMsg(text, error = false) {
  const m = $("mcp-msg");
  m.textContent = text;
  m.classList.toggle("error", error);
  m.classList.toggle("hidden", !text);
  clearTimeout(mcpMsgTimer);
  if (text) mcpMsgTimer = setTimeout(() => m.classList.add("hidden"), error ? 9000 : 4000);
}

const SCOPE_TAG = { user: tx("user"), local: tx("this folder"), project: tx("project") };

function mcpServerHtml(sc, s, showScope) {
  const target = s.transport === "stdio" ? [s.command, ...s.args].map(shq).join(" ") : s.url;
  const keys = [...s.env_keys.map((k) => `<span class="sk-tag" title="${tx("Environment variable (value not shown)")}">${esc(k)}</span>`),
    ...s.header_keys.map((k) => `<span class="sk-tag" title="${tx("Header (value not shown)")}">${esc(k)}:</span>`)].join("");
  return `<div class="mcp-srv${s.enabled ? "" : " off"}" data-scope="${esc(sc.id)}" data-name="${esc(s.name)}" title="${esc(tildify(sc.file))}">
      <div class="mcp-row"><span class="mcp-name">${esc(s.name)}</span><span class="sk-tag">${TRANSPORT_TAG[s.transport] ?? esc(s.transport)}</span>
        ${showScope ? `<span class="mcp-scope">${esc(SCOPE_TAG[sc.id] ?? sc.label)}</span>` : ""}
        ${s.pending ? `<span class="sk-tag pending" title="${tx("A project server nobody has approved yet: Claude Code doesn't start it. Switch it on to approve it for this folder.")}">${tx("needs approval")}</span>` : ""}<span class="mcp-grow"></span>
        ${sc.can_toggle ? `<label class="mcp-toggle" title="${s.pending ? tx("Switch on to approve it for this folder") : s.enabled ? tx("On — click to switch off") : tx("Off — click to switch on")}"><input type="checkbox" data-mcp-toggle ${s.enabled ? "checked" : ""}><span></span></label>` : ""}
        ${sc.writable ? `<button class="sk-x" data-mcp-remove title="${tx("Remove")}">×</button>` : ""}</div>
      <div class="mcp-cmd" title="${esc(target)}">${esc(target)}</div>
      ${keys ? `<div class="mcp-keys">${keys}</div>` : ""}
    </div>`;
}

function mcpFormHtml(writable) {
  const where = writable.length > 1
    ? `<select name="scope">${writable.map((sc) => `<option value="${esc(sc.id)}">${esc(sc.label)}</option>`).join("")}</select>` : "";
  return `<form class="mcp-form" data-scope="${esc(writable[0].id)}" data-t="stdio" autocomplete="off">
      <input name="name" placeholder="${tx("Name, e.g. filesystem")}" spellcheck="false" />
      ${where}
      <select name="transport">
        <option value="stdio">${tx("Local command (stdio)")}</option>
        <option value="http">${tx("Remote — streamable HTTP")}</option>
        <option value="sse">${tx("Remote — SSE")}</option>
      </select>
      <input name="command_line" class="f-stdio" placeholder="npx -y @modelcontextprotocol/server-filesystem ~/code" spellcheck="false" />
      <input name="url" class="f-remote" placeholder="https://example.com/mcp" spellcheck="false" />
      <textarea name="env" class="f-stdio" rows="2" placeholder="${tx("Environment, one per line: API_KEY=…")}" spellcheck="false"></textarea>
      <textarea name="headers" class="f-remote" rows="2" placeholder="${tx("Headers, one per line: Authorization: Bearer …")}" spellcheck="false"></textarea>
      <div class="skills-add-btns"><button type="button" data-mcp-cancel>${tx("Cancel")}</button><button type="submit" class="primary">${tx("Add")}</button></div>
    </form>`;
}

/** One list of every server the agent has, wherever it's configured. */
function renderMcp() {
  const body = $("mcp-body");
  const S = focusedS();
  $("mcp-sub").textContent = S ? `${S.agent.name} · ${tildify(S.cwd)}` : "";
  $("mcp-sub").title = S && isPaw(S.agent)
    ? tx("Paw Agent connects to these when a session starts. Tools a server marks read-only run without asking; the others follow the tab's approval level.") : "";
  const r = S ? mcp.report : null;
  const writable = r?.supported ? r.scopes.filter((sc) => sc.writable) : [];
  $("mcp-add").classList.toggle("hidden", !writable.length);
  if (!S) { body.innerHTML = `<div class="mcp-note">${tx("Open a session to see its agent's MCP servers.")}</div>`; return; }
  if (!r) { body.innerHTML = `<div class="mcp-note">${tx("Reading…")}</div>`; return; }
  if (!r.supported) { body.innerHTML = `<div class="mcp-note">${esc(r.note)}</div>`; return; }
  const several = r.scopes.length > 1;
  const rows = r.scopes.flatMap((sc) => sc.servers.map((s) => mcpServerHtml(sc, s, several))).join("");
  const form = mcp.adding && writable.length ? mcpFormHtml(writable) : "";
  const notes = [...new Set(r.scopes.filter((sc) => sc.note).map((sc) => sc.note))];
  body.innerHTML = (form || rows ? `<div class="mcp-list">${form}${rows}</div>` : `<div class="mcp-note">${writable.length ? tx("No MCP servers yet. + adds one.") : tx("No MCP servers yet.")}</div>`) +
    notes.map((n) => `<div class="mcp-note">${esc(n)}</div>`).join("");
  body.querySelector(".mcp-form [name=name]")?.focus();
}

/** Running tabs of this agent load the change (see the comment above). */
function applyMcp(agentId, cwd, scope) {
  for (const S of sessions.values()) {
    if (S.agent.id !== agentId || S.mode === "oneshot") continue;
    if (!(scope === "user" || scope === "paw" || S.cwd === cwd)) continue; // "folder": this folder's tabs
    S.mcpStale = true;
    reloadForMcp(S);
  }
}
async function reloadForMcp(S) {
  if (!S.mcpStale || !isRunning(S) || isBusy(S)) return;
  S.mcpStale = false;
  await restart(S, null, { resume: true, quiet: true });
  sys(S, tx("MCP servers changed · conversation continues"));
}

async function mcpChange(fn, done) {
  const S = focusedS();
  if (!S || mcp.busy) return;
  mcp.busy = true;
  const [agent, cwd] = [S.agent.id, S.cwd];
  try {
    const scope = await fn({ agent, cwd });
    mcpMsg(done);
    applyMcp(agent, cwd, scope);
  } catch (e) {
    mcpMsg(String(e), true);
  } finally {
    mcp.busy = false;
  }
  await loadMcp();
}

$("mcp-body").addEventListener("click", async (e) => {
  if (e.target.closest("[data-mcp-cancel]")) { mcp.adding = null; renderMcp(); return; }
  const rm = e.target.closest("[data-mcp-remove]");
  if (rm) {
    const row = rm.closest(".mcp-srv");
    const sc = mcp.report?.scopes.find((x) => x.id === row.dataset.scope);
    if (!await askSure(tx("Remove the MCP server “{name}” from {scope}?", { name: row.dataset.name, scope: sc?.label ?? row.dataset.scope }), { yes: tx("Remove"), detail: tildify(sc?.file ?? "") })) return;
    mcpChange(async (c) => { await invoke("mcp_remove", { ...c, scope: row.dataset.scope, name: row.dataset.name }); return row.dataset.scope; },
      tx("Removed {name}", { name: row.dataset.name }));
    return;
  }
  const reveal = e.target.closest("[data-reveal]");
  if (reveal) invoke("reveal_path", { path: reveal.dataset.reveal }).catch((err) => mcpMsg(String(err), true));
});
$("mcp-body").addEventListener("change", (e) => {
  if (e.target.name === "transport") { e.target.closest("form").dataset.t = e.target.value === "stdio" ? "stdio" : "remote"; return; }
  if (e.target.name === "scope") { e.target.closest("form").dataset.scope = e.target.value; return; }
  const t = e.target.closest("[data-mcp-toggle]");
  if (t) {
    const row = t.closest(".mcp-srv");
    // Claude Code keeps its switches per project: only this folder's tabs reload.
    mcpChange(async (c) => {
      await invoke("mcp_set_enabled", { ...c, scope: row.dataset.scope, name: row.dataset.name, enabled: t.checked });
      return c.agent === "claude" ? "folder" : row.dataset.scope;
    }, t.checked ? tx("{name} on", { name: row.dataset.name }) : tx("{name} off", { name: row.dataset.name }));
  }
});
$("mcp-body").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const v = (n) => f.elements[n].value;
  const server = { name: v("name"), transport: v("transport"), command_line: v("command_line"), url: v("url"), env: v("env"), headers: v("headers") };
  if (server.transport !== "stdio") server.env = "";
  else server.headers = "";
  mcpChange(async (c) => { await invoke("mcp_add", { ...c, scope: f.dataset.scope, server }); mcp.adding = null; return f.dataset.scope; },
    tx("Added {name}", { name: server.name.trim() }));
});
$("panel-toggle").onclick = () => setPanel(!panel.open);
$("panel-close").onclick = () => setPanel(false);
$("panel-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (tab) setPanel(true, tab);
});
$("mcp-refresh").onclick = () => loadMcp();
$("mcp-add").onclick = () => { mcp.adding = !mcp.adding; renderMcp(); };
// At load only the visibility: the first renderSidebar() fills it in.
applyPanel();

// ---------- rendering: terminal output ----------
// Bottom-anchored: new lines appear right above the prompt and push older ones up.
function renderOutput() {
  const S = curS();
  const out = $("output");
  out.innerHTML = "";
  if (!S) return;
  for (const l of S.lines) place(hostFor(out, l), renderLine(S, l));
  flushMd();
  out.scrollTop = out.scrollHeight;
}

/** Add many lines at once (shell output arrives in chunks). */
function pushLines(S, lines) {
  S.lines.push(...lines);
  if (S.lines.length > 10000) S.lines.splice(0, S.lines.length - 10000);
  for (const l of lines) trackShellContext(S, l);
  inPane(S, () => appendLines(S, lines));
  saveWorkspaceSoon();
}

const MAX_SCREEN_LINES = 5000; // older lines stay in the tab's history, not on screen
// ---------- grouped work steps ----------
// Consecutive tool calls / results / thinking collapse into one line:
// "⏺ 6 actions · Bash ×5 · Edit · 2 failed". Anything else closes the group.
const isStep = (el) => el.nodeType === 1 && (el.classList.contains("t-tool") || el.classList.contains("t-result") || el.classList.contains("t-think"));

function openGroup(out) {
  const last = out.lastElementChild;
  if (last?.classList.contains("tool-group") && !last.classList.contains("closed")) return last;
  const g = document.createElement("details");
  g.className = "tl tool-group";
  g.innerHTML = `<summary><span class="b ok">⏺</span> <span class="tg-count"></span><span class="tg-kinds dim"></span>` +
    `<span class="tg-failed"></span><span class="tg-last"></span></summary><div class="tg-body"></div>`;
  out.appendChild(g);
  return g;
}

function summarizeGroup(g) {
  const steps = [...g.querySelectorAll(":scope > .tg-body > .t-tool")];
  const failed = g.querySelectorAll(":scope > .tg-body > .bad").length;
  const counts = new Map();
  for (const st of steps) counts.set(st.dataset.tool, (counts.get(st.dataset.tool) ?? 0) + 1);
  const kinds = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" · ");
  const n = steps.length;
  const last = steps.at(-1)?.dataset.arg ?? "";
  const sum = g.querySelector(":scope > summary");
  const set = (sel, text) => { const el = sum.querySelector(sel); if (el.textContent !== text) el.textContent = text; };
  set(".tg-count", n ? tx(n === 1 ? "{n} action" : "{n} actions", { n }) : tx("Thinking"));
  set(".tg-kinds", kinds ? ` · ${kinds}` : "");
  set(".tg-failed", failed ? ` · ${tx("{n} failed", { n: failed })}` : "");
  set(".tg-last", last && !g.classList.contains("closed") ? ` — ${last.slice(0, 80)}` : "");
}

// Pressing a fold header toggles it. It doesn't start a text selection (so
// WebKit doesn't search the transcript for a caret position) and the prompt
// keeps the keyboard focus.
document.addEventListener("mousedown", (e) => {
  if (e.button === 0 && e.target.closest?.(".output summary")) e.preventDefault();
}, true);

// ---------- one-shot replies ----------
// Text agents (Copilot, Codex, Gemini…) print their markdown a line at a
// time; consecutive stdout lines share one block, rendered as a whole.
const mdDirty = new Set();
function mdRun(text) {
  const d = div("tl say md-msg md-run");
  d.mdSrc = [PawThemes.stripAnsi(text)];
  return d;
}
/** Render the blocks that got lines since the last flush. */
function flushMd() {
  for (const d of mdDirty) {
    const md = d.mdSrc.join("\n");
    d.innerHTML = md.trim() ? `<span class="b">⏺</span><div class="md">${renderMarkdown(md, true)}</div>` : "";
  }
  mdDirty.clear();
}

/** Append rendered line(s), folding work steps into the open group. */
// ---------- turns ----------
// A prompt and the agent's answer stay together: the answer (and approval
// cards) is drawn inside the prompt's block, even when you ran shell
// commands while the agent worked; those go after the block, each with its
// own output. Lines are kept in the order they came; only drawing groups them.

function newTurn(S) {
  S.turnSeq = Math.max(S.turnSeq ?? 0, ...S.lines.map((l) => l.turn ?? 0)) + 1;
  S.turnId = S.turnSeq;
  return S.turnId;
}

/** Where a line goes: its turn's block (made by the prompt), else the end. */
function hostFor(out, l) {
  if (l?.turn == null) return out;
  if (l.stream === "stdin") {
    const block = div("turn-block");
    block.dataset.turn = l.turn;
    out.appendChild(block);
    return block;
  }
  return turnBlock(out, l.turn) ?? out;
}
const turnBlock = (out, turn) => out.querySelector(`:scope > .turn-block[data-turn="${turn}"]`);

function place(out, el) {
  if (!el) return;
  const nodes = el.nodeType === 11 ? [...el.childNodes] : [el];
  for (let node of nodes) {
    if (node.cli) node = cliStep(out, node);
    if (!node) continue;
    if (isStep(node)) {
      const g = openGroup(out);
      g.querySelector(":scope > .tg-body").appendChild(node);
      summarizeGroup(g);
    } else {
      const last = out.lastElementChild;
      if (node.mdSrc && last?.mdSrc) {
        last.mdSrc.push(...node.mdSrc);
        mdDirty.add(last);
        continue;
      }
      if (last?.classList.contains("tool-group") && !last.classList.contains("closed")) {
        last.classList.add("closed");
        summarizeGroup(last);
      }
      if (node.mdSrc) mdDirty.add(node);
      out.appendChild(node);
    }
  }
}

function appendLines(S, lines) {
  const out = $("output");
  const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 120;
  out.querySelector(".partial-line")?.remove();
  for (const l of lines) place(hostFor(out, l), renderLine(S, l));
  flushMd();
  const extra = out.childElementCount - MAX_SCREEN_LINES;
  for (let i = 0; i < extra; i++) out.firstElementChild?.remove();
  if (S.partial) renderPartial(S);
  if (stick) out.scrollTop = out.scrollHeight;
}

function appendLine(S, line) {
  const out = $("output");
  const stick = line.stream === "stdin" || out.scrollHeight - out.scrollTop - out.clientHeight < 120;
  out.querySelector(".partial-line")?.remove();
  place(hostFor(out, line), renderLine(S, line));
  flushMd();
  if (S.partial) renderPartial(S);
  if (stick) out.scrollTop = out.scrollHeight;
}

function div(cls, html) {
  const d = document.createElement("div");
  d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}

// A step's full text (tool input, command output…) is put on screen only while
// the step is open. WebKit keeps the text of closed <details> in the layout
// tree, and every mouse press walks back through it character by character
// looking for a caret position: with megabytes of tool output that made each
// click on the transcript take a second or more.
function fold(cls, summaryHtml, body) {
  const d = document.createElement("details");
  d.className = "tl fold " + cls;
  d.innerHTML = `<summary>${summaryHtml}</summary><pre></pre>`;
  d.body = body || "";
  d.addEventListener("toggle", () => { d.lastElementChild.textContent = d.open ? redactSecrets(d.body) : ""; });
  return d;
}

// ---------- secrets on screen ----------
// Credentials that steps print (a config file the agent read, a header in a
// script it wrote) are masked wherever the transcript shows step text.
// Copilot wraps long lines, so a token may run on over the next lines: a
// whole line of token characters, or a last piece that ends at a quote.
const MASK = "••••••";
const TOK = "[A-Za-z0-9+/=._~-]";
const SECRETS = [
  [new RegExp(`(\\b(?:Bearer|Basic)\\s+)${TOK}{16,}(?:\\n[ \\t]*(?:${TOK}{16,}(?=\\n|$)|${TOK}+(?=['"\\],}])))*`, "g"), `$1${MASK}`],
  [/\b(?:sk-(?:ant-|proj-)?[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, MASK],
  [new RegExp(`((?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\\w-]*["']?\\s*[:=]\\s*["']?)(?![/~.])${TOK}{12,}`, "gi"), `$1${MASK}`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`],
];
function redactSecrets(text) {
  for (const [re, to] of SECRETS) text = text.replace(re, to);
  return text;
}

// ---------- Copilot CLI steps ----------
// Copilot prints each tool call as a block after a blank line: a header
// (" $ Shell List the tools 40 lines…", " ✗ Shell … Failed", " MD Read …")
// then the command, script or output indented three spaces. Each block
// becomes a step like a Claude Code tool call: grouped, its body shown on
// click. Anything else stays markdown.
const CLI_STEP = /^ (?![-*+>#|\d])(\S{1,3}) +(\S+)(?: +(.*?))?\s*$/;

/** The node to place for Copilot stdout line `node` (null: it went into the open step).
 *  Deprecated: CLI agents (CLI_AGENTS). */
function cliStep(out, node) {
  const text = node.mdSrc[0];
  const last = out.lastElementChild;
  const open = last?.classList.contains("tool-group") && !last.classList.contains("closed")
    ? last.querySelector(":scope > .tg-body > .t-tool:last-child") : null;
  if (open?.cliGap != null) {
    if (!text.trim()) { open.cliGap++; return null; }
    if (text.startsWith("   ")) {
      open.body += (open.body ? "\n".repeat(open.cliGap + 1) : "") + text.slice(3);
      open.cliGap = 0;
      if (open.open) open.lastElementChild.textContent = redactSecrets(open.body);
      return null;
    }
  }
  const afterBlank = open ? open.cliGap > 0 : !last?.mdSrc || !last.mdSrc.at(-1).trim();
  const m = afterBlank && text.match(CLI_STEP);
  if (!m) return node;
  const [, icon, word, rest = ""] = m;
  const plain = icon === "●"; // a tool shown by what it does, not its name
  const arg = redactSecrets((plain ? `${word} ${rest}` : rest).trim().replace(/\s{2,}/g, " · "));
  const failed = icon === "✗";
  const step = fold("t-tool" + (failed ? " bad" : ""), `<span class="b${failed ? "" : " ok"}">⏺</span> ` +
    (plain ? `<b>${esc(arg)}</b>` : `<b>${esc(word)}</b> <span class="arg">${esc(arg)}</span>`), "");
  step.dataset.tool = plain ? "Tool" : word;
  step.dataset.arg = arg;
  step.cliGap = 0;
  return step;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.url ||
    input.description || input.prompt || JSON.stringify(input);
  return redactSecrets(String(v).split("\n")[0].slice(0, 120));
}

function renderLine(S, l) {
  if (l.stream === "info") return div(l.cls ? `tl info ${l.cls}` : "tl info", l.html);
  if (l.stream === "approval") return renderApprovalCard(S, l);
  if (l.stream === "system") return div("tl sys", esc(l.text));
  if (l.stream === "cmd") return div("tl input shcmd", `<span class="sh">$</span> ${esc(l.text)}`);
  if (l.stream === "shell") return div("tl out", ansi(l.text) || "&nbsp;");
  if (l.stream === "shellexit") return div("tl shexit", l.code === 130 ? "^C" : `exit ${l.code}`);
  if (l.stream === "shared") return div("tl sys shared-note", l.next ? tx("↳ output goes to {name} with your next message", { name: esc(S.agent.name) }) : tx("↳ output shared with {name}", { name: esc(S.agent.name) }));
  if (l.stream === "shareoffer") {
    const el = div("tl sys shared-note share-offer");
    el.innerHTML = `${tx("↳ large output ({size})", { size: esc(l.text) })} <button class="follow-up" title="${tx("Send this output to {name} with your next message", { name: esc(S.agent.name) })}">${tx("↪ Follow up")}</button>`;
    const b = el.querySelector(".follow-up");
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!shareOffer(S, l)) { b.textContent = tx("Output no longer available"); b.disabled = true; return; }
      b.textContent = tx("✓ Added to your next message");
      b.classList.add("done");
      clearTimeout(b.resetTimer);
      b.resetTimer = setTimeout(() => { b.textContent = tx("↪ Follow up"); b.classList.remove("done"); }, 1800);
      $("input").focus();
    };
    return el;
  }
  if (l.stream === "stdin") {
    let text = l.text;
    if (text.startsWith("{")) {
      try {
        const content = JSON.parse(text).message.content;
        text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const n = content.filter((c) => c.type === "image").length;
        if (n) text += `  [${tx(n > 1 ? "{n} images" : "{n} image", { n })}]`;
      } catch {}
    }
    const el = div("tl input", `<span class="g">❯</span> ${esc(text)}`);
    if (l.attachments?.length || l.shared || l.skills) {
      const row = div("att-row");
      if (l.skills) row.appendChild(div("att-chip echo ctx-chip", `<span class="att-icon">✦</span><span class="att-name">${tx(l.skills > 1 ? "shared {n} external skills" : "shared {n} external skill", { n: l.skills })}</span>`));
      if (l.shared) row.appendChild(div("att-chip echo ctx-chip", `<span class="att-icon">$</span><span class="att-name">${tx(l.shared > 1 ? "shared {n} shell outputs" : "shared {n} shell output", { n: l.shared })}</span>`));
      for (const a of l.attachments ?? []) {
        const chip = div("att-chip echo", chipHtml(a, false));
        const img = chip.querySelector(".att-thumb");
        if (img) a.echoEl = img;
        row.appendChild(chip);
      }
      el.appendChild(row);
    }
    return el;
  }
  if (l.stream === "stdout" && S.mode === "oneshot") {
    const d = mdRun(l.text);
    d.cli = CLI_AGENTS && S.agent.id === "copilot"; // Deprecated: CLI agents (CLI_AGENTS).
    return d;
  }
  if (l.stream === "stdout" && l.text.startsWith("{")) {
    let ev;
    try { ev = JSON.parse(l.text); } catch { ev = null; }
    if (ev && typeof ev.type === "string") {
      const r = renderClaudeEvent(ev);
      if (r !== undefined) return r;
    }
    // An event cut short by an older save: a collapsed step, not a wall of JSON.
    if (!ev && /^\{"type":"(user|assistant)"/.test(l.text)) {
      return fold("t-result", `<span class="elbow">⎿</span> <span class="dim">${tx("(long output — trimmed when it was saved)")}</span>`, l.text);
    }
  }
  return div("tl " + (l.stream === "stderr" ? "err" : "out"), ansi(l.text) || "&nbsp;");
}

/** Render Claude Code `stream-json` events. Return undefined to fall back to raw. */
function renderClaudeEvent(ev) {
  if (ev.type === "system") {
    if (ev.subtype === "init") return div("tl sys", esc(tx("session {id} · {model}", { id: ev.session_id?.slice(0, 8) ?? "", model: ev.model ?? "" })));
    return null;
  }
  if (ev.type === "assistant" && ev.message?.content) {
    const frag = document.createDocumentFragment();
    for (const c of ev.message.content) {
      if (c.type === "text" && c.text?.trim()) {
        frag.appendChild(div("tl say md-msg", `<span class="b">⏺</span><div class="md">${renderMarkdown(c.text.trim())}</div>`));
      } else if (c.type === "thinking" && c.thinking?.trim()) {
        frag.appendChild(fold("t-think", `<span class="b">✻</span> ${tx("Thinking…")}`, c.thinking));
      } else if (c.type === "tool_use") {
        const step = fold("t-tool",
          `<span class="b ok">⏺</span> <b>${esc(c.name)}</b>(<span class="arg">${esc(summarizeToolInput(c.input))}</span>)`,
          JSON.stringify(c.input, null, 2));
        step.dataset.tool = c.name;
        step.dataset.arg = summarizeToolInput(c.input);
        frag.appendChild(step);
      }
    }
    return frag.childNodes.length ? frag : null;
  }
  if (ev.type === "user" && Array.isArray(ev.message?.content)) {
    const frag = document.createDocumentFragment();
    for (const c of ev.message.content) {
      if (c.type !== "tool_result") continue;
      const body = typeof c.content === "string" ? c.content
        : Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("\n") : JSON.stringify(c.content);
      const lines = body.split("\n").filter((s) => s.trim());
      const more = lines.length > 1 ? ` <span class="dim">${tx("(+{n} lines)", { n: lines.length - 1 })}</span>` : "";
      frag.appendChild(fold("t-result" + (c.is_error ? " bad" : ""),
        `<span class="elbow">⎿</span> ${esc(redactSecrets((lines[0] ?? tx("(no output)")).slice(0, 160)))}${more}`, body));
    }
    return frag.childNodes.length ? frag : null;
  }
  if (ev.type === "result") {
    const u = usageOf(ev.usage);
    const bits = [
      ev.num_turns != null ? tx(ev.num_turns === 1 ? "{n} turn" : "{n} turns", { n: ev.num_turns }) : "",
      ev.duration_ms != null ? `${(ev.duration_ms / 1000).toFixed(1)}s` : "",
      u && (u.input || u.output) ? `↑ ${fmtTokens(u.input)} ↓ ${fmtTokens(u.output)}` : "",
      ev.total_cost_usd != null ? `$${ev.total_cost_usd.toFixed(4)}` : "",
    ].filter(Boolean).join(" · ");
    const head = ev.stopped ? tx("■ Stopped") : ev.is_error ? tx("✗ Failed") : tx("✓ Done");
    return div("tl done" + (ev.is_error ? " bad" : ""), `${head}${bits ? " · " + bits : ""}`);
  }
  if (ev.type === "stream_event" || ev.type === "rate_limit_event") return null;
  // Other bookkeeping events (tool_progress, keep-alives…) from the same stream.
  if (/^(tool_progress|keep_alive|status|progress)$/.test(ev.type) || (ev.session_id && ev.uuid && !ev.message)) return null;
  return undefined;
}

// ---------- busy indicator ----------
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let spinFrame = 0;
// ---------- tokens and usage stats ----------
// Live tokens come from Claude Code (each reply's usage) and Paw Agent (a
// running total after each model call); other agents only have the time.
// Every finished prompt and task goes into ~/.paw/stats.jsonl (/stats).

/** Input (with cached input) and output tokens from a usage object. */
function usageOf(u) {
  if (!u) return null;
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { input, output: u.output_tokens ?? 0 };
}
const fmtTokens = (n) => (n < 1000 ? String(n) : n < 999_500 ? `${(n / 1000).toFixed(n < 9_950 ? 1 : 0)}k` : `${(n / 1e6).toFixed(n < 9_950_000 ? 1 : 0)}M`);

/** Follow a turn's tokens as its events arrive. */
function trackUsage(S, text) {
  if (!S.turnStarted) return;
  if (text.startsWith('{"type":"progress"') && text.includes('"usage"')) {
    try { S.turnUsage = usageOf(JSON.parse(text).usage); } catch {}
    return;
  }
  if (text.startsWith('{"type":"assistant"') && text.includes('"usage"')) {
    try {
      const m = JSON.parse(text).message;
      const u = usageOf(m?.usage);
      if (!u) return;
      // One reply comes as several events with the same id and usage: count it once.
      (S.msgUsage ??= new Map()).set(m.id ?? S.msgUsage.size, u);
      let input = 0, output = 0;
      for (const v of S.msgUsage.values()) { input += v.input; output += v.output; }
      S.turnUsage = { input, output };
    } catch {}
  }
}

/** The model a tab runs, as its agent reported it (init), else as set. */
const modelOf = (S) => String(S.actualModel || S.model || "default").replace(/ · (Ollama|Anthropic|GitHub Copilot)$/, "");

function recordQuery(S, ended, ev = null) {
  if (!S.turnStarted) return;
  const u = usageOf(ev?.usage) ?? S.turnUsage ?? { input: 0, output: 0 };
  invoke("stats_record", { entry: {
    ts: Date.now(), kind: "query", agent: S.agent.name, model: modelOf(S), ok: !!ended.ok,
    ms: ev?.duration_ms ?? Date.now() - S.turnStarted, input: u.input, output: u.output, cost: ev?.total_cost_usd ?? 0,
  } }).catch(() => {});
  pluginEvent("turn", { tab: pluginTab(S), ok: !!ended.ok, ms: ev?.duration_ms ?? Date.now() - S.turnStarted, input: u.input, output: u.output, model: modelOf(S), agent: S.agent.name });
  taskUsage(S, u);
  S.turnStarted = null;
}

function recordTask(T) {
  invoke("stats_record", { entry: {
    ts: Date.now(), kind: "task", agent: T.agent.name, model: modelOf(T), ok: true,
    ms: (T.task.endedAt ?? Date.now()) - (T.task.startedAt ?? Date.now()), input: 0, output: 0, cost: 0,
  } }).catch(() => {});
}

/** /stats [day|week|month]: today, this week, this month; per model for one of them. */
async function statsHtml(arg) {
  const d = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const week = day - ((d.getDay() + 6) % 7) * 86_400_000; // Monday
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const period = ["day", "today", "week", "month"].includes(arg) ? (arg === "today" ? "day" : arg) : "month";
  const since = { day, week, month }[period];
  const s = await invoke("stats_summary", { day, week, month, modelsSince: since });
  const cols = [s.day, s.week, s.month];
  if (!s.month.queries && !s.month.tasks && !s.week.queries) {
    return `<span class="dim">${tx("No usage recorded yet. Every prompt and plan that finishes from now on is counted.")}</span>`;
  }
  const row = (label, f, cls = "") => `${esc(label.padEnd(18))}${cols.map((c) => `<span class="${cls}">${esc(String(f(c)).padStart(11))}</span>`).join("")}`;
  const anyCost = cols.some((c) => c.cost > 0);
  const lines = [
    `<span class="help-h">${tx("Usage")}</span>${" ".repeat(Math.max(1, 18 - tx("Usage").length))}${[tx("Today"), tx("This week"), tx("This month")].map((h) => `<span class="dim">${esc(h.padStart(11))}</span>`).join("")}`,
    row(tx("Queries"), (c) => c.queries),
    row("  " + tx("failed"), (c) => c.failed || "–", "dim"),
    row(tx("Plans completed"), (c) => c.tasks),
    row(tx("Tokens ↑ in"), (c) => (c.input ? fmtTokens(c.input) : "–")),
    row(tx("Tokens ↓ out"), (c) => (c.output ? fmtTokens(c.output) : "–")),
    row(tx("Avg. query time"), (c) => (c.queries ? fmtElapsed(c.ms / c.queries) : "–")),
  ];
  if (anyCost) lines.push(row(tx("Cost"), (c) => (c.cost ? `$${c.cost.toFixed(2)}` : "–")));
  const name = { day: tx("today"), week: tx("this week"), month: tx("this month") }[period];
  lines.push("", `<span class="help-h">${tx("By model")}</span> <span class="dim">· ${tx("{period} (/stats day · week · month)", { period: name })}</span>`);
  if (!s.models.length) lines.push(`<span class="dim">${period === "day" ? tx("No queries today.") : period === "week" ? tx("No queries this week.") : tx("No queries this month.")}</span>`);
  else {
    lines.push(`<span class="dim">${esc(tx("Model").padEnd(36))}${esc(tx("Queries").padStart(8))}${esc(tx("Avg. time").padStart(11))}${esc(tx("↑ in").padStart(9))}${esc(tx("↓ out").padStart(9))}${anyCost ? esc(tx("Cost").padStart(9)) : ""}</span>`);
    for (const m of s.models) {
      const label = `${m.model} · ${m.agent}`;
      lines.push(`${esc((label.length > 35 ? label.slice(0, 34) + "…" : label).padEnd(36))}${String(m.queries).padStart(8)}${fmtElapsed(m.avg_ms).padStart(11)}` +
        `${(m.input ? fmtTokens(m.input) : "–").padStart(9)}${(m.output ? fmtTokens(m.output) : "–").padStart(9)}${anyCost ? (m.cost ? `$${m.cost.toFixed(2)}` : "–").padStart(9) : ""}`);
    }
  }
  lines.push(`<span class="dim">${tx("Tokens are counted for Claude Code and Paw Agent; other agents report time only.")}</span>`);
  return lines.join("\n");
}

function renderBusy() {
  const S = curS();
  const waiting = !!S && !isBusy(S) && waitingPrompts.find((w) => w.S === S);
  const busy = !!S && (isBusy(S) || !!waiting) && !S.raw;
  $("busy").classList.toggle("hidden", !busy);
  if (!busy) return;
  if (waiting) {
    $("busy-spin").textContent = "⏳";
    $("busy-text").textContent = tx("Waiting for a free agent ({n} of {max} working)…", { n: agentsWorking(), max: maxAgents() });
    $("busy-time").textContent = fmtElapsed(Date.now() - waiting.since);
    return;
  }
  $("busy-spin").textContent = SPIN[spinFrame % SPIN.length];
  $("busy-text").textContent = S.shellBusy ? tx("Running {command}…", { command: S.shellCmd }) : S.waitingApproval ? tx("Waiting for your approval…")
    : S.mode === "claude" ? tx("Working…") : tx("Running…");
  const u = !S.shellBusy && S.turnUsage;
  $("busy-time").textContent = fmtElapsed(Date.now() - ((S.shellBusy ? S.shellSince : S.busySince) ?? Date.now())) +
    (u && (u.input || u.output) ? ` · ↑ ${fmtTokens(u.input)} ↓ ${fmtTokens(u.output)}` : "");
}
setInterval(() => { spinFrame++; for (const P of panes.values()) withPane(P, renderBusy); }, 90);

// ---------- sessions: same rules for every agent ----------
// A new tab has no session (brand-new conversation). Follow-up prompts and
// restarts continue it: through the agent's own sessions ("session"), or by
// Paw sending the earlier turns along ("replay").
function captureSession(S, l) {
  if (l.stream !== "stdout" && l.stream !== "stderr") return;
  // Deprecated: CLI agents (CLI_AGENTS). A one-shot run's output, for its turn's answer and errors.
  if (CLI_AGENTS) {
    S.runLines?.push(l.text);
    if (l.stream === "stdout" && S.mode === "oneshot") S.runOut?.push(PawThemes.stripAnsi(l.text));
  }
  // Paw Agent's init line carries its conversation id too.
  const pat = S.agent.continuity === "session" && S.agent.session_pattern;
  if (pat) {
    try {
      const m = PawThemes.stripAnsi(l.text).match(new RegExp(pat));
      if (m?.[1] && m[1] !== S.session) { S.session = m[1]; saveWorkspaceSoon(); }
      if (m?.[1]) S.resuming = false;
    } catch { /* bad pattern in settings */ }
  }
  // Deprecated: CLI agents (CLI_AGENTS). Paw keeps the conversation of agents without sessions.
  const turn = S.turns?.at(-1);
  if (CLI_AGENTS && S.agent.continuity === "replay" && turn?.open && l.stream === "stdout") {
    turn.assistant += PawThemes.stripAnsi(l.text) + "\n";
  }
}

// Copilot CLI ends every `-p` run with a stats block on stderr (Changes,
// AI Credits, Tokens, Resume — Resume last). Shown as one dim line instead
// of four error lines; captureSession has already taken the session id.
// Deprecated: CLI agents (CLI_AGENTS).
const COPILOT_STAT = /^(Changes|AI Credits|Tokens|Resume)\s+(.*)$/;
/** Whether stderr line `l` is part of Copilot's closing stats (handled here). */
function foldCopilotStats(S, l) {
  const text = PawThemes.stripAnsi(l.text).trim();
  if (!text) return true; // the blank lines before the block
  const m = text.match(COPILOT_STAT);
  if (!m) return false;
  const st = (S.copilotStats ??= {});
  st[m[1]] = m[2];
  if (m[1] !== "Resume") return true;
  S.copilotStats = null;
  const credits = st["AI Credits"]?.match(/^(\S+)\s*(?:\((.+)\))?/);
  const tokens = st.Tokens?.match(/↑\s*(\S+).*↓\s*(\S+)/);
  const bits = [
    credits?.[2],
    credits && tx("{n} AI credits", { n: credits[1] }),
    st.Changes && !/^\+0 -0$/.test(st.Changes) ? st.Changes : "",
    tokens && tx("↑{in} ↓{out} tokens", { in: tokens[1], out: tokens[2] }),
  ].filter(Boolean);
  if (bits.length) sys(S, bits.join(" · "));
  return true;
}

const REPLAY_BUDGET = 16000;
/** Earlier turns of this tab, for agents without sessions of their own. */
function withReplay(S, text) {
  const turns = (S.turns ?? []).filter((t) => !t.open && (t.user || t.assistant));
  if (!turns.length) return text;
  let budget = REPLAY_BUDGET;
  const parts = [];
  for (let i = turns.length - 1; i >= 0 && budget > 200; i--) {
    let block = `User: ${turns[i].user}\n\nAssistant: ${turns[i].assistant.trim()}`;
    if (block.length > budget) block = "…" + block.slice(-budget);
    budget -= block.length;
    parts.unshift(block);
  }
  return `This continues our conversation. The earlier turns, oldest first:\n<conversation>\n${parts.join("\n\n---\n\n")}\n</conversation>\n\n${text}`;
}

/** A resume that the agent rejects right away: say so and carry on fresh. */
function resumeRejected(S, pinfo) {
  if (!S.runWithSession || pinfo.status !== "failed" || Date.now() - (S.runStarted ?? 0) > 20000) return false;
  if (S.mode !== "oneshot") return !!S.resuming; // died before ever reporting its session
  const out = (S.runLines ?? []).join("\n");
  return /session|conversation|thread|chat/i.test(out) && /not found|no such|unknown|invalid|does not exist|couldn'?t find/i.test(out);
}

/** The text of the turn's latest assistant message (a task step's answer). */
function noteAnswer(S, line) {
  try {
    const parts = JSON.parse(line).message?.content ?? [];
    const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (text) S.lastAnswer = text;
  } catch {}
}

// ---------- backend events ----------
listen("agent:output", ({ payload: l }) => onAgentOutput(l));

function onAgentOutput(l) {
  const S = sessions.get(procToSid.get(l.id));
  if (!S) return;
  // Paw Agent started a factory run (run_factory): a link to it.
  if (l.stream === "stdout" && l.text.startsWith('{"type":"paw","subtype":"factory_run"')) {
    try { factoryRunNote(S, JSON.parse(l.text)); } catch {}
    return;
  }
  if (l.stream === "stdin") return; // echoed locally by sendToAgent
  if (l.stream === "system" && S.quietProcs?.has(l.id)) return; // approval restarts are silent
  // One-shot runs end every prompt; a clean exit is not news.
  if (S.mode === "oneshot" && l.stream === "system" && l.text === "Process exited with code 0") return;
  captureSession(S, l);
  // Deprecated: CLI agents (CLI_AGENTS).
  if (CLI_AGENTS && S.agent.id === "copilot" && S.mode === "oneshot" && l.stream === "stderr" && foldCopilotStats(S, l)) return;
  if (S.mode === "claude" && l.stream === "stdout") {
    logAgentCommands(S, l.text);
    trackUsage(S, l.text);
    if (l.text.startsWith('{"type":"system"') && l.text.includes('"init"')) {
      try { const ev = JSON.parse(l.text); if (ev.subtype === "init" && ev.model) S.actualModel = ev.model; } catch {}
    }
  }
  if (S.mode === "claude" && l.stream === "stdout" && l.text.startsWith('{"type":"assistant"')) noteAnswer(S, l.text);
  let ended = null; // a finished turn, for tasks
  if (S.mode === "claude" && l.stream === "stdout" && l.text.includes('"type":"result"')) {
    try {
      const ev = JSON.parse(l.text);
      if (ev.type === "result") {
        const text = typeof ev.result === "string" && ev.result ? ev.result : S.lastAnswer ?? "";
        ended = { ok: !ev.is_error, stopped: !!ev.stopped, text,
          error: ev.is_error ? text || tx("{name} reported an error ({kind}). Its tab has the details.", { name: S.agent.name, kind: ev.subtype ?? "unknown" }) : null };
        recordQuery(S, ended, ev);
        turnFinished(S);
        S.busy = false;
        if (isPaw(S.agent)) { expirePawCards(S); S.partial = null; inPane(S, () => renderPartial(S)); }
        refresh(S);
        setTimeout(() => { reloadNativeSkills(S); reloadForMcp(S); }, 0);
      }
    } catch {}
  }
  // A task tab shows the plan as a graph: the planner's JSON would only repeat it.
  if (S.task && S.mode === "claude" && l.stream === "stdout" && l.text.startsWith('{"type":"assistant"') && l.text.includes("```")) l = { ...l, text: foldPlanJson(l.text) };
  if (S.turnId != null) l = { ...l, turn: S.turnId };
  pushLine(S, l);
  checkDenials(S, l);
  if (ended) taskTurnEnded(S, ended);
  if (S.mode !== "oneshot" && S.onceTurn && l.stream === "stdout" && l.text.includes('"type":"result"') && !l.text.includes('"permission_denials":[{')) {
    endOnceAllowance(S);
  }
  if (!paneOf(S) && l.stream !== "stdin") {
    S.unread++;
    renderTabs();
    renderSidebar();
  }
}

listen("agent:status", ({ payload: pinfo }) => {
  const S = sessions.get(procToSid.get(pinfo.id));
  if (!S || S.proc !== pinfo.id) return; // ignore processes this tab has moved on from
  S.info = pinfo;
  if (S.nodeOf && pinfo.status !== "running") sys(S, tx("— the node's session ended; this tab is read only now —"));
  let ended = null; // a turn that ended with the process, for tasks
  if (pinfo.status !== "running") {
    const wasBusy = S.busy;
    S.busy = false;
    const turn = S.turns?.at(-1);
    if (turn?.open) { turn.open = false; saveWorkspaceSoon(); }
    if (S.mode === "oneshot" && pinfo.status !== "stopped") {
      checkApprovalText(S);
      if (S.onceTurn) endOnceAllowance(S);
    }
    const ok = pinfo.status !== "failed" && pinfo.status !== "stopped" && (pinfo.exit_code ?? 0) === 0;
    if (S.mode === "oneshot") {
      ended = { ok, stopped: pinfo.status === "stopped", text: (S.runOut ?? []).join("\n"),
        error: ok ? null : PawThemes.stripAnsi((S.runLines ?? []).slice(-20).join("\n")) || tx("exited with code {code}", { code: pinfo.exit_code }) };
    } else if (wasBusy) {
      ended = { ok: false, stopped: pinfo.status === "stopped", text: S.lastAnswer ?? "", error: tx("{name} stopped before it finished.", { name: S.agent.name }) };
    }
  }
  if (pinfo.status !== "running" && resumeRejected(S, pinfo)) {
    S.resuming = false;
    S.session = null;
    S.runWithSession = false;
    sys(S, tx("couldn't continue the previous {name} session — starting a new one", { name: S.agent.name }));
    if (S.mode === "oneshot") startProc(S, S.lastPrompt);
    else startProc(S);
    return;
  }
  refresh(S);
  if (ended) recordQuery(S, ended);
  if (pinfo.status !== "running") turnFinished(S);
  if (ended) taskTurnEnded(S, ended);
});

listen("settings:changed", ({ payload }) => {
  const limit = settings?.general?.max_sessions;
  settings = payload;
  // Another language: the window loads again in it (tabs come back as after a restart).
  if (I18N.pick(payload.general?.language) !== I18N.lang) {
    I18N.remember(payload.general?.language);
    const reload = () => location.reload();
    if (wsReady) invoke("save_workspace", { workspace: workspaceSnapshot() }).finally(reload);
    else reload();
    return;
  }
  applyCurrentTheme();
  applyFonts();
  if (payload.general?.max_sessions !== limit) refreshArchive();
  setTimeout(pumpAgents, 0);
  if (activeId == null) renderWelcome();
  // The status bar again (a factory node's tab shows its factory's sandbox,
  // which can come from Settings). Open tabs keep the sandbox they started
  // with: Settings › Sandbox is for new tabs and runs.
  for (const P of panes.values()) if (P.sid != null) withPane(P, renderHeader);
});
listen("agents:detected", ({ payload }) => {
  detections = payload;
  detectionsReady = true;
  if (activeId == null) renderWelcome();
  agentsAvailable();
});

/** A provider got connected: tabs that were terminals for lack of one get
 *  Paw Agent (and the input mode they had), and an empty window a tab. */
function agentsAvailable() {
  const model = defaultPawModel();
  if (!model) return;
  for (const S of sessions.values()) {
    if (!S.terminalOnly) continue;
    S.terminalOnly = false;
    S.model = model;
    S.inputMode = S.modeBefore && S.modeBefore !== "shell" ? S.modeBefore : settings.general.input_mode || "auto";
    delete S.modeBefore;
    sys(S, tx("Paw Agent is here now, with {model}: lines that aren't commands go to it ({mode} mode).", { model: modelShort(model), mode: MODE_LABEL[S.inputMode] }));
    startProc(S).then(() => inPane(S, () => { renderModePill(); updateGlyph(); renderHeader(); }));
  }
}

// ---------- prompt line ----------
function autosize() {
  const ta = $("input");
  if (!ta) return;
  renderBackdrop();
  // Empty: natural one-line height (measuring before layout made it 3 lines tall).
  if (!ta.value || !ta.clientWidth) { ta.style.height = ""; return; }
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  const b = $("input-backdrop");
  if (b) b.scrollTop = ta.scrollTop;
}
function updateGlyph() {
  const S = curS();
  const g = $("prompt-glyph");
  const shell = S?.shellBusy || routeFor(S, $("input").value).shell;
  g.textContent = S?.shellBusy ? "›" : shell ? "$" : "❯";
  g.classList.toggle("sh", !!shell);
  g.title = S?.shellBusy ? tx("Input goes to the running command") : shell ? tx("Runs in the shell") : tx("Goes to the agent");
}

// ---------- panes & splits ----------
// The main area is a tree of panes. Each pane is a copy of the session view
// (output, prompt, autocomplete, embedded terminal…) showing one session.
// `$()` resolves the session-view element ids inside `activePane`; code that
// renders into a pane other than the focused one wraps itself in withPane().
const panes = new Map();   // pane id → { id, root, sid }
let focusedPane = null;    // the pane with keyboard focus (its sid is activeId)
let layout = null;         // { type: "pane", pane } | { type: "split", dir: "row"|"column", children, sizes }
let nextPaneId = 1;

function withPane(P, fn) {
  const prev = activePane;
  activePane = P;
  try { return fn(); } finally { activePane = prev; }
}
const paneOf = (S) => (S ? [...panes.values()].find((p) => p.sid === S.sid) ?? null : null);
const inPane = (S, fn) => { const P = paneOf(S); if (P) withPane(P, fn); };

function createPane() {
  const root = $("pane-template").content.firstElementChild.cloneNode(true);
  I18N.translateDom(root); // a template's content isn't in the page when it loads
  const P = { id: nextPaneId++, root, sid: null };
  panes.set(P.id, P);
  root.dataset.pane = P.id;
  // Clicking or tabbing into a pane focuses it.
  root.addEventListener("mousedown", () => { if (focusedPane !== P) focusPane(P, false); }, true);
  root.addEventListener("focusin", () => { if (focusedPane !== P) focusPane(P, false); });
  bindPane(P);
  const { theme, extended } = PawThemes.activeTheme(settings);
  PawThemes.applyTheme(root, theme, extended, settings.appearance?.opacity ?? 0.94);
  return P;
}

function focusPane(P, focusInput = true) {
  if (!P) return;
  const prev = curS();
  if (prev && focusedPane && focusedPane !== P) prev.draft = $("input").value;
  focusedPane = activePane = P;
  activeId = P.sid;
  for (const p of panes.values()) p.root.classList.toggle("focused", p === P);
  const S = curS();
  if (S) S.unread = 0;
  if (focusInput) {
    if (S?.raw && S.term) S.term.term.focus();
    else $("input").focus();
  }
  renderTabs();
  renderSidebar();
}

function renderLayout() {
  const host = $("panes");
  host.innerHTML = "";
  host.classList.toggle("multi", panes.size > 1);
  host.appendChild(buildNode(layout));
  for (const P of panes.values()) {
    withPane(P, () => { const out = $("output"); out.scrollTop = out.scrollHeight; });
    const S = sessions.get(P.sid);
    if (S?.term) requestAnimationFrame(() => fitTerm(S));
  }
}

function buildNode(node) {
  if (node.type === "pane") return node.pane.root;
  const el = document.createElement("div");
  el.className = `split split-${node.dir}`;
  node.children.forEach((child, i) => {
    if (i) el.appendChild(makeDivider(node, i, el));
    const c = buildNode(child);
    c.style.flex = `${node.sizes[i]} 1 0`;
    el.appendChild(c);
  });
  return el;
}

/** Drag a divider to move the boundary between two neighbours. */
function makeDivider(node, i, container) {
  const d = document.createElement("div");
  d.className = `divider divider-${node.dir}`;
  d.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const horizontal = node.dir === "row";
    const rect = container.getBoundingClientRect();
    const total = node.sizes.reduce((a, b) => a + b, 0);
    const px = (horizontal ? rect.width : rect.height) / total;
    const start = horizontal ? e.clientX : e.clientY;
    const [a0, b0] = [node.sizes[i - 1], node.sizes[i]];
    const kids = [...container.children].filter((k) => !k.classList.contains("divider"));
    const move = (ev) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / px;
      const min = 0.15 * (a0 + b0);
      const a = Math.max(min, Math.min(a0 + b0 - min, a0 + delta));
      node.sizes[i - 1] = a;
      node.sizes[i] = a0 + b0 - a;
      kids[i - 1].style.flex = `${node.sizes[i - 1]} 1 0`;
      kids[i].style.flex = `${node.sizes[i]} 1 0`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      for (const P of panes.values()) { const S = sessions.get(P.sid); if (S?.term) fitTerm(S); }
    };
    document.body.classList.add("resizing", horizontal ? "resizing-col" : "resizing-row");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  return d;
}

/** Find a pane's leaf and its parent split in the layout tree. */
function findLeaf(P, node = layout, parent = null) {
  if (node.type === "pane") return node.pane === P ? { node, parent } : null;
  for (const c of node.children) {
    const r = findLeaf(P, c, node);
    if (r) return r;
  }
  return null;
}

/** Split the focused pane: "row" = side by side, "column" = stacked. */
async function splitPane(dir) {
  const P = focusedPane;
  const S = curS();
  const { node, parent } = findLeaf(P);
  const NP = createPane();
  const leaf = { type: "pane", pane: NP };
  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(node);
    const half = parent.sizes[i] / 2;
    parent.sizes[i] = half;
    parent.children.splice(i + 1, 0, leaf);
    parent.sizes.splice(i + 1, 0, half);
  } else {
    const split = { type: "split", dir, children: [{ type: "pane", pane: P }, leaf], sizes: [1, 1] };
    if (!parent) layout = split;
    else parent.children[parent.children.indexOf(node)] = split;
  }
  renderLayout();
  focusPane(NP);
  await newSession(S?.agent.id, { cwd: S?.cwd, model: CLI_AGENTS ? undefined : S?.model || undefined });
}

/** Remove a pane from the layout (its session is already gone or elsewhere). */
function removePane(P) {
  if (panes.size <= 1) return;
  const { node, parent } = findLeaf(P);
  const i = parent.children.indexOf(node);
  // The neighbour that takes over the space gets focus.
  const neighbour = firstPaneIn(parent.children[i > 0 ? i - 1 : 1]);
  parent.children.splice(i, 1);
  parent.sizes.splice(i, 1);
  if (parent.children.length === 1) {
    // Collapse a split with a single child into that child.
    const only = parent.children[0];
    const gp = findParentOf(parent);
    if (!gp) layout = only;
    else gp.children[gp.children.indexOf(parent)] = only;
  }
  panes.delete(P.id);
  P.root.remove();
  renderLayout();
  const next = neighbour ?? [...panes.values()][0];
  focusPane(next);
  withPane(next, () => { renderHeader(); showTermView(); });
}

const firstPaneIn = (node) => (!node ? null : node.type === "pane" ? node.pane : firstPaneIn(node.children[0]));

function findParentOf(target, node = layout) {
  if (node.type !== "split") return null;
  if (node.children.includes(target)) return node;
  for (const c of node.children) {
    const r = findParentOf(target, c);
    if (r) return r;
  }
  return null;
}

/** ⌘⌥ + arrow: move focus to the nearest pane in that direction. */
function focusNeighbour(key) {
  const here = focusedPane.root.getBoundingClientRect();
  const cx = here.left + here.width / 2, cy = here.top + here.height / 2;
  let best = null, bestD = Infinity;
  for (const P of panes.values()) {
    if (P === focusedPane) continue;
    const r = P.root.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ok = { ArrowLeft: x < cx - 1, ArrowRight: x > cx + 1, ArrowUp: y < cy - 1, ArrowDown: y > cy + 1 }[key];
    if (!ok) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD) { bestD = d; best = P; }
  }
  if (best) focusPane(best);
}

$("split-v").onclick = () => splitPane("row");
$("split-h").onclick = () => splitPane("column");

// ---------- per-pane event wiring ----------
// Runs once per pane with that pane active, so $() finds its elements. The
// handlers run later with the focused pane active (focusin/mousedown above).
function bindPane(P) {
  bindTaskView(P);
  renderArchive(P.root);
  setTimeout(renderPluginStatus, 0);
  withPane(P, () => {
    $("sl-path").onclick = () => {
      const S = sessions.get(P.sid);
      if (S) invoke("open_folder", { path: S.cwd }).catch((e) => sys(S, `✗ ${e}`));
    };
    $("sl-sessions").onclick = async () => {
      const S = sessions.get(P.sid);
      if (!S) return;
      pushLine(S, { stream: "stdin", text: "/sessions", ts: Date.now(), local: true });
      info(S, await sessionsListHtml().catch((e) => `<span class="err">✗ ${esc(e)}</span>`));
    };
    $("xterm-back").onclick = () => {
      const S = curS();
      if (!S) return;
      invoke("shell_raw_exit", { id: S.shell }).catch(() => {});
      leaveTermView(S);
    };
    $("xterm-int").onclick = () => {
      const S = curS();
      if (S?.raw) invoke("shell_write_raw", { id: S.shell, data: "\x03" }).catch(() => {});
      S?.term?.term.focus();
    };
    new ResizeObserver(() => fitTerm(sessions.get(P.sid))).observe($("xterm-hosts"));
    // Pane width changes (splits, sidebar, window) change how the prompt wraps.
    new ResizeObserver(() => withPane(P, autosize)).observe($("prompt-line"));
    $("attach-btn").onclick = async () => {
      const S = curS();
      if (!S) return;
      try {
        addAttachments(S, await invoke("pick_attachments", { session: S.pawId }));
      } catch (e) {
        sys(S, `✗ ${e}`);
      }
      $("input").focus();
    };
    // ⌘V with an image on the clipboard (e.g. a screenshot) attaches it.
    $("input").addEventListener("paste", (e) => {
      const S = curS();
      const items = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!S) return;
      if (!items.length) {
        const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
        if (!S.shellBusy && !S.raw && text.trim() && shouldBadge(text)) {
          e.preventDefault();
          const a = pastedAttachment(text.replace(/^\n+|\s+$/g, ""));
          addAttachments(S, [a]);
          // A copy in the session's files/ too.
          invoke("save_pasted_text", { text: a.text, session: S.pawId }).then((f) => { a.file = f.path; }).catch(() => {});
        }
        return;
      }
      e.preventDefault();
      for (const it of items) {
        const file = it.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = async () => {
          const data = String(reader.result).split(",")[1] ?? "";
          try {
            addAttachments(S, [await invoke("save_pasted_image", { data, mime: file.type === "image/jpg" ? "image/jpeg" : file.type, session: S.pawId })]);
          } catch (err) {
            sys(S, tx("✗ couldn't attach the pasted image: {error}", { error: err }));
          }
        };
        reader.readAsDataURL(file);
      }
    });
    $("input").addEventListener("input", () => { syncTokens(curS()); autosize(); updateGlyph(); scheduleAutocomplete(); scheduleLookup(); });
    $("input").addEventListener("scroll", () => { const b = $("input-backdrop"); if (b) b.scrollTop = $("input").scrollTop; });
    // A badge's ×: remove it; a double-click on pasted text: back to text.
    $("input").addEventListener("mousedown", (e) => {
      const S = curS();
      const hit = S && tokenUnder(S, e.clientX, e.clientY);
      if (hit?.onX) { e.preventDefault(); removeToken(S, hit.a); $("input").focus(); }
    });
    // The cursor moved by a key may land after the keydown's check: check
    // again when the key comes up.
    $("input").addEventListener("keyup", (e) => {
      const S = curS();
      if (!S?.attachments?.some((a) => a.token) || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      snapCaret(S, $("input"), e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
    });
    // A click inside a badge puts the cursor at its nearer edge.
    $("input").addEventListener("mouseup", () => { const S = curS(); if (S?.attachments?.length) setTimeout(() => snapCaret(S, $("input"), 0), 0); });
    $("input").addEventListener("dblclick", (e) => {
      const S = curS();
      const hit = S && tokenUnder(S, e.clientX, e.clientY);
      if (hit && isPasted(hit.a)) { e.preventDefault(); expandToken(S, hit.a); }
    });
    $("input").addEventListener("mousemove", (e) => {
      const S = curS();
      const ta = $("input");
      const hit = S && tokenUnder(S, e.clientX, e.clientY);
      for (const x of $("input-backdrop")?.querySelectorAll(".tok-x.hot") ?? []) x.classList.remove("hot");
      if (hit?.onX) hit.el.querySelector(".tok-x")?.classList.add("hot");
      ta.style.cursor = hit?.onX ? "default" : "";
      const tip = !hit ? "" : hit.onX ? tx("Remove") : isPasted(hit.a)
        ? (hit.a.text.length > 600 ? hit.a.text.slice(0, 600) + "…" : hit.a.text) + "\n\n" + tx("Double-click to edit it in the prompt.")
        : `${tildify(hit.a.path)} · ${fmtSize(hit.a.size)}`;
      if (ta.title !== tip) ta.title = tip;
    });
    $("input").addEventListener("blur", () => setTimeout(closeAc, 120));
    $("input").addEventListener("keydown", (e) => {
      const ta = e.target;
      const S = curS();
      // Badges in the text: Backspace right after one (or inside it), Delete
      // right before one, take the whole badge; typing inside one goes after it.
      if (S && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && ta.selectionStart === ta.selectionEnd && S.attachments?.length) {
        const i = ta.selectionStart, v = ta.value;
        if (e.key === "Backspace" || e.key === "Delete") {
          const t = tokenAt(S, v, i) ?? (S.attachments.map((a) => a.token && (e.key === "Backspace" ? v.slice(i - a.token.length, i) === a.token : v.slice(i, i + a.token.length) === a.token) && { a }).find(Boolean));
          if (t) { e.preventDefault(); removeToken(S, t.a); return; }
        } else if (e.key.length === 1) {
          const t = tokenAt(S, v, i);
          if (t) ta.setSelectionRange(t.end, t.end);
        }
      }
      // Moving the cursor (arrows, ⌥ by word, up/down): it never stops inside
      // a badge, it steps over it in the way it was going.
      if (S && !e.isComposing && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && S.attachments?.some((a) => a.token)) {
        const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        arrowMove = { S, ta, dir, at: Date.now() };
        setTimeout(() => snapCaret(S, ta, dir), 0);
      }
      // A question waiting in this tab: y / n + Enter, or Esc, answer it.
      const sure = S && !e.isComposing && sureIn(S);
      if (sure && e.key === "Escape") { e.preventDefault(); answerSure(sure, false); return; }
      if (sure && e.key === "Enter" && !e.shiftKey) {
        const w = ta.value.trim().toLowerCase();
        const yes = ["y", "yes", "j", "ja", "e", "evet"].includes(w), no = ["n", "no", "nein", "h", "hayır", "hayir"].includes(w);
        if (yes || no) { e.preventDefault(); ta.value = ""; autosize(); answerSure(sure, yes); return; }
      }
      if (!e.isComposing && autocompleteKey(e)) return;
      // Backspace with the caret at the very start: remove the last badge.
      if (e.key === "Backspace" && !e.isComposing && ta.selectionStart === 0 && ta.selectionEnd === 0 && S && removeLastBadge(S)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = ta.value;
        ta.value = "";
        autosize();
        closeAc();
        submit(text);
        return;
      }
      // Shell-style history: up/down when the caret is on the first/last line.
      if (S?.history.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const before = ta.value.slice(0, ta.selectionStart);
        const after = ta.value.slice(ta.selectionEnd);
        if (e.key === "ArrowUp" && before.includes("\n")) return;
        if (e.key === "ArrowDown" && after.includes("\n")) return;
        e.preventDefault();
        if (S.histIdx === S.history.length) S.draft = ta.value;
        S.histIdx = Math.max(0, Math.min(S.history.length, S.histIdx + (e.key === "ArrowUp" ? -1 : 1)));
        ta.value = S.histIdx === S.history.length ? S.draft : S.history[S.histIdx];
        ta.setSelectionRange(ta.value.length, ta.value.length);
        autosize();
      }
      // ⌃U and ⌃W, like a shell's line editing: delete from the start of the
      // line, or the word, before the cursor (⌃A, ⌃E and ⌃K come with macOS).
      const del = keyIs(settings, e, "delete-line") ? "line" : keyIs(settings, e, "delete-word") ? "word" : null;
      if (del) {
        e.preventDefault();
        const end = ta.selectionStart;
        const before = ta.value.slice(0, end);
        const start = del === "line" ? before.lastIndexOf("\n") + 1 : before.replace(/\S+\s*$/, "").length;
        if (start < end || ta.selectionEnd > end) {
          ta.setSelectionRange(start, Math.max(end, ta.selectionEnd));
          // As an edit (⌘Z undoes it), and the prompt reacts as to typing.
          if (!document.execCommand("delete")) ta.setRangeText("", start, Math.max(end, ta.selectionEnd), "end");
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      // Ctrl-C with nothing selected interrupts, like a terminal.
      if (keyIs(settings, e, "prompt-interrupt") && S && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        interrupt(S);
      }
    });
    $("terminal").addEventListener("mouseup", (e) => {
      if (e.button !== 0 || e.ctrlKey) return; // a right-click keeps the selection and focus
      if (e.target.closest("summary, button, a, textarea")) return;
      if (!String(window.getSelection())) $("input").focus();
    });

    $("mode-pill").onclick = () => { const S = curS(); if (S) { cycleInputMode(S); $("input").focus(); } };
    $("sl-sandbox").onclick = sandboxMenu;
    $("prompt-glyph").onclick = () => $("mode-pill").click();
    $("eof").onclick = () => { const S = curS(); if (S && isRunning(S)) invoke("close_input", { id: S.proc }); };
  });
}

// ---------- new-session menu & welcome ----------
function agentAvatar(a) {
  const ini = (a.name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<span class="mini-avatar">${esc(ini || "?")}</span>`;
}

/** Menu rows for every visible model, under its provider's name; ⌘T marks the default. */
function modelMenuItems(menu) {
  const groups = modelsByProvider();
  if (!groups.length) {
    if (!detectionsReady) { menu.appendChild(div("menu-empty", tx("Looking for models…"))); return; }
    const b = document.createElement("button");
    b.className = "menu-item";
    b.innerHTML = `<span class="mini-avatar ghost">⚙</span><span class="mi-name">${tx("Connect a provider in Settings…")}</span>`;
    b.onclick = () => { closeMenu(); invoke("open_preferences", { tab: "agents" }); };
    menu.appendChild(b);
    return;
  }
  const def = defaultPawModel();
  const box = div("menu-models");
  for (const [p, list] of groups) {
    box.appendChild(div("menu-head", esc(providerName(p))));
    for (const m of list) {
      const b = document.createElement("button");
      b.className = "menu-item";
      b.title = m;
      b.innerHTML = `${agentAvatar({ name: providerName(p) })}<span class="mi-name">${esc(modelShort(m))}</span>` +
        `<span class="mi-sub">${m === def ? "⌘T" : ""}</span>`;
      b.onclick = () => newSession("paw", { model: m });
      box.appendChild(b);
    }
  }
  menu.appendChild(box);
}

function openMenu() {
  const menu = $("menu");
  const list = availableAgents();
  const def = defaultAgent();
  menu.innerHTML = "";
  if (!CLI_AGENTS) modelMenuItems(menu);
  // Deprecated: CLI agents (CLI_AGENTS).
  else if (!list.length) menu.appendChild(div("menu-empty", detectionsReady ? tx("No agents available") : tx("Detecting agents…")));
  for (const [i, a] of (CLI_AGENTS ? list : []).entries()) {
    if (i > 0 && isPaw(list[i - 1]) && !isPaw(a)) menu.appendChild(div("menu-sep")); // Paw Agent, then the CLI agents
    const b = document.createElement("button");
    b.className = "menu-item";
    const d = detections[a.id];
    b.innerHTML = `${agentAvatar(a)}<span class="mi-name">${esc(a.name)}</span>` +
      `<span class="mi-sub">${a.id === def?.id ? "⌘T" : esc(d?.version?.match(/\d+(\.\d+)+/)?.[0] ?? "")}</span>`;
    b.onclick = () => newSession(a.id);
    menu.appendChild(b);
  }
  menu.appendChild(div("menu-sep"));
  if (CLI_AGENTS ? list.some((a) => sessionMode(a) !== "stdin") : visibleModels().length) {
    const tk = document.createElement("button");
    tk.className = "menu-item";
    tk.innerHTML = `<span class="mini-avatar ghost">◇</span><span class="mi-name">${tx("New plan…")}</span><span class="mi-sub">${tx("plan, then run")}</span>`;
    tk.onclick = () => { closeMenu(); const S = focusedS(); newTask({ cwd: S?.cwd }); };
    menu.appendChild(tk);
  }
  const s = document.createElement("button");
  s.className = "menu-item";
  s.innerHTML = `<span class="mini-avatar ghost">⚙</span><span class="mi-name">${tx("Manage Agents…")}</span>`;
  s.onclick = () => { closeMenu(); invoke("open_preferences", { tab: "agents" }); };
  menu.appendChild(s);

  const r = $("tab-menu").getBoundingClientRect();
  menu.classList.remove("hidden");
  const w = menu.offsetWidth;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
}
function closeMenu() { $("menu").classList.add("hidden"); }
$("tab-menu").onclick = (e) => { e.stopPropagation(); $("menu").classList.contains("hidden") ? openMenu() : closeMenu(); };
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#menu, #tab-menu")) closeMenu(); });
// Clicking a menu item doesn't take the selection away (Copy, Create a task).
$("menu").addEventListener("mousedown", (e) => e.preventDefault());

function renderWelcome() {
  const box = $("welcome-agents");
  box.innerHTML = "";
  if (!CLI_AGENTS) {
    const groups = modelsByProvider();
    if (!groups.length) {
      box.appendChild(div("welcome-empty", detectionsReady
        ? `${tx("No models yet.")} <a id="w-settings">${tx("Connect a provider in Settings…")}</a>`
        : tx("Looking for models…")));
      const l = document.getElementById("w-settings");
      if (l) l.onclick = () => invoke("open_preferences", { tab: "agents" });
      return;
    }
    for (const [p, list] of groups) {
      box.appendChild(div("welcome-head", esc(providerName(p))));
      for (const m of list) {
        const b = document.createElement("button");
        b.className = "welcome-agent";
        b.title = m;
        b.innerHTML = `${agentAvatar({ name: providerName(p) })}<span>${esc(modelShort(m))}</span>`;
        b.onclick = () => newSession("paw", { model: m });
        box.appendChild(b);
      }
    }
    return;
  }
  // Deprecated: CLI agents (CLI_AGENTS).
  const list = availableAgents();
  if (!list.length) {
    box.appendChild(div("welcome-empty", detectionsReady
      ? tx("No agents found. {link} to add one.", { link: `<a id="w-settings">${tx("Open Settings")}</a>` })
      : tx("Detecting installed agents…")));
    const l = document.getElementById("w-settings");
    if (l) l.onclick = () => invoke("open_preferences", { tab: "agents" });
    return;
  }
  for (const a of list) {
    const b = document.createElement("button");
    b.className = "welcome-agent";
    b.innerHTML = `${agentAvatar(a)}<span>${esc(a.name)}</span>`;
    b.onclick = () => newSession(a.id);
    box.appendChild(b);
  }
}

// ---------- sidebar show/hide ----------
function setSidebar(visible, animate = true) {
  const app = document.querySelector(".app");
  app.classList.toggle("no-anim", !animate);
  app.classList.toggle("sidebar-hidden", !visible);
  $("sidebar-toggle").title = visible ? tx("Hide sidebar (⌃⌘S)") : tx("Show sidebar (⌃⌘S)");
  $("sidebar-toggle").classList.toggle("on", visible);
  try { localStorage.setItem("paw.sidebar", visible ? "1" : "0"); } catch {}
}
const sidebarVisible = () => !document.querySelector(".app").classList.contains("sidebar-hidden");
const toggleSidebar = () => setSidebar(!sidebarVisible());
$("sidebar-toggle").onclick = toggleSidebar;
// ⌃⌘S is a menu accelerator (View › Toggle Sidebar); the menu forwards it here.
listen("ui:toggle-sidebar", toggleSidebar);
// The View menu's splits and right panel (their keys are the menu's, so they work wherever the focus is).
// The native menu's items (and their shortcuts).
listen("ui:menu", ({ payload: id }) => runAction(id));
try { setSidebar(localStorage.getItem("paw.sidebar") !== "0", false); } catch { setSidebar(true, false); }

// ---------- side panels give way to the prompt ----------
// Clicking into the prompt box, or typing in it, closes the sidebar and the
// right panel. Only the user's own click or keystroke counts: Paw moves focus to
// the prompt by itself all the time, and that must not close anything.
function closeSidePanels() {
  if (sidebarVisible()) setSidebar(false);
  if (panel.open) setPanel(false);
}
document.addEventListener("pointerdown", (e) => { if (e.target.closest?.(".prompt-line")) closeSidePanels(); }, true);
document.addEventListener("input", (e) => { if (e.isTrusted && e.target.matches?.('textarea[data-id="input"]')) closeSidePanels(); }, true);

// ---------- sidebar width ----------
// Drag the sidebar's edge to resize it (remembered); double-click resets it.
const SIDEBAR_W = { min: 200, max: 480, normal: 272 };
function setSidebarWidth(w, save = true) {
  const px = Math.round(Math.min(SIDEBAR_W.max, Math.max(SIDEBAR_W.min, w)));
  document.querySelector(".app").style.setProperty("--sidebar-w", px + "px");
  if (save) try { localStorage.setItem("paw.sidebarWidth", String(px)); } catch {}
  return px;
}
try { const w = Number(localStorage.getItem("paw.sidebarWidth")); if (w) setSidebarWidth(w, false); } catch {}
// Drag `handle` to resize: `widthAt(x)` turns the pointer's x into a width,
// `set(w, save)` applies it (saved when the drag ends); double-click resets.
function makeResizer(handle, widthAt, set, reset) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = document.querySelector(".app");
    handle.setPointerCapture(e.pointerId);
    app.classList.add("resizing");
    handle.classList.add("dragging");
    const move = (ev) => set(widthAt(ev.clientX), false);
    const up = (ev) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      app.classList.remove("resizing");
      handle.classList.remove("dragging");
      set(widthAt(ev.clientX), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", reset);
}
makeResizer(
  $("sidebar-resizer"),
  (x) => x - document.querySelector(".sidebar").getBoundingClientRect().left,
  setSidebarWidth,
  () => setSidebarWidth(SIDEBAR_W.normal),
);

// ---------- right panel width ----------
// Its left edge drags like the sidebar's; never wider than half the window.
const PANEL_W = { min: 240, max: 640, normal: 300 };
function setPanelWidth(w, save = true) {
  const max = Math.min(PANEL_W.max, Math.floor(window.innerWidth / 2));
  const px = Math.round(Math.min(max, Math.max(PANEL_W.min, w)));
  document.querySelector(".app").style.setProperty("--panel-w", px + "px");
  if (save) try { localStorage.setItem("paw.panelWidth", String(px)); } catch {}
  return px;
}
try { const w = Number(localStorage.getItem("paw.panelWidth")); if (w) setPanelWidth(w, false); } catch {}
makeResizer(
  $("panel-resizer"),
  (x) => $("right-panel").getBoundingClientRect().right - x,
  setPanelWidth,
  () => setPanelWidth(PANEL_W.normal),
);

$("tab-add").onclick = () => newSession();
$("settings-btn").onclick = () => invoke("open_preferences", {});

// ---------- keyboard ----------
// The shortcuts are in keys.js; Settings › Keys changes them (settings.keys).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
  const S = curS();
  // Fixed: ⌘1–⌘9 go to a tab, ⌥⌘ arrows to the pane beside.
  if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const sid = openTabs[Number(e.code.slice(5)) - 1];
    if (sid != null) { e.preventDefault(); select(sid); }
    return;
  }
  if (e.metaKey && e.altKey && e.key.startsWith("Arrow")) { e.preventDefault(); focusNeighbour(e.key); return; }
  // The menu's shortcuts come from the native menu (ui:menu): handling the
  // key a menu item shows here too would act twice. Its other keys (⌘N for a
  // new tab…) and everything without a native menu (a browser) are handled here.
  const id = keyActionFor(settings, e, ["window", "menu"]);
  if (!id) return;
  if (window.__TAURI_INTERNALS__ && KEY_ACTIONS.find((a) => a.id === id)?.where === "menu" && keysOf(settings, id)[0] === keyCombo(e)) return;
  if (runAction(id)) e.preventDefault();
});

/** Do what a shortcut or a menu item stands for; false if there was nothing to do. */
function runAction(id) {
  const S = curS();
  switch (id) {
    case "new-tab": newSession(); return true;
    case "new-tab-with": openMenu(); return true;
    case "fork-tab": if (!canFork(S)) return false; forkTab(S); return true;
    case "close-tab": if (!S) return false; closeSession(S.sid); return true;
    case "clear": if (!S) return false; S.lines = []; renderOutput(); return true;
    case "interrupt": if (!S) return false; interrupt(S); return true;
    case "next-tab": case "prev-tab": {
      if (!openTabs.length) return false;
      const i = openTabs.indexOf(activeId);
      const d = id === "next-tab" ? 1 : -1;
      select(openTabs[(i + d + openTabs.length) % openTabs.length]);
      return true;
    }
    // The transcript's font size, or a factory diagram's zoom while the pointer is over it.
    case "font-bigger": case "font-smaller": case "font-reset": {
      const k = id === "font-reset" ? "0" : id === "font-smaller" ? "-" : "+";
      if (!factoryZoomKey(k)) stepFontSize(k === "0" ? 0 : k === "-" ? -1 : 1);
      return true;
    }
    case "settings": invoke("open_preferences", {}); return true;
    case "split-row": splitPane("row"); return true;
    case "split-column": splitPane("column"); return true;
    case "toggle-sidebar": toggleSidebar(); return true;
    case "toggle-panel": setPanel(!panel.open); return true;
    // The menu's own (File, View, Factory, Help).
    case "new-plan": newTask({ model: S?.model, cwd: S?.cwd, goal: "" }); return true;
    case "new-factory": setSidebar(true); setNavTab("factories"); askFactoryName(); return true;
    case "attach-files": if (!S) return false; $("attach-btn")?.click(); return true;
    case "session-folder": if (!S) return false; slashCommand(S, "/session"); return true;
    case "sandbox-toggle": if (!S || S.nodeOf) return false; toggleTabSandbox(S); return true;
    case "factory-run": case "factory-stop": case "factory-lock": case "factory-reset-layout": case "factory-edit": case "factory-delete":
      return factoryMenu(S, id);
    case "check-updates": checkForUpdates({ manual: true }); return true;
    case "help-readme": invoke("open_url", { url: "https://github.com/reevik/Paw#readme" }).catch(() => {}); return true;
    case "help-factories": invoke("open_url", { url: "https://github.com/reevik/Paw/blob/main/docs/factories.md" }).catch(() => {}); return true;
    case "help-sandbox": invoke("open_url", { url: "https://github.com/reevik/Paw/blob/main/docs/sandbox.md" }).catch(() => {}); return true;
    case "help-issue": invoke("open_url", { url: "https://github.com/reevik/Paw/issues/new" }).catch(() => {}); return true;
  }
  return false;
}

// ---------- updates ----------
// Paw looks at its latest release on GitHub when it starts and every few
// hours, and says when there's a newer one: Download (the DMG), Skip This
// Version (Settings remembers it), or Remind Me Later (a day later).
// Paw › Check for Updates… looks now and says so either way.
const UPDATE_REPO = "reevik/Paw";
const UPDATE_EVERY = 6 * 3600e3, UPDATE_LATER = 24 * 3600e3;
let updateShown = false;

/** Is version a newer than b? ("0.12.0" > "0.11.1"; pre-releases aren't offered.) */
function newerVersion(a, b) {
  const p = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const laterOf = () => { try { return JSON.parse(localStorage.getItem("paw.update.later") || "null"); } catch { return null; } };

async function checkForUpdates({ manual = false } = {}) {
  if (!manual && settings.general?.check_updates === false) return;
  if (updateShown) return;
  try { localStorage.setItem("paw.update.checked", String(Date.now())); } catch {}
  const mine = (await invoke("about_info").catch(() => null))?.version;
  let rel;
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? tx("GitHub asks to wait a little (too many checks)") : `HTTP ${r.status}`);
    rel = await r.json();
  } catch (e) {
    if (manual) showUpdate({ error: e.message ?? String(e) });
    return;
  }
  const latest = String(rel.tag_name ?? "").replace(/^v/, "");
  if (!mine || !latest || !newerVersion(latest, mine)) {
    if (manual) showUpdate({ upToDate: mine });
    return;
  }
  if (!manual) {
    if (settings.general?.skip_version === latest) return;
    const later = laterOf();
    if (later?.version === latest && Date.now() < later.until) return;
  }
  showUpdate({ rel, latest, mine });
}

/** The update window: a newer release (with Download, Skip, Later), or a manual check's answer. */
function showUpdate({ rel, latest, mine, upToDate, error }) {
  document.querySelector(".upd-overlay")?.remove();
  const box = document.createElement("div");
  box.className = "upd-overlay";
  let body, buttons;
  if (rel) {
    const notes = String(rel.body ?? "").trim();
    body = `<div class="upd-title">${tx("Paw {version} is available", { version: esc(latest) })}</div>
      <div class="upd-sub">${tx("You have {version}. Download it, open the DMG and drag Paw to Applications; your tabs and settings stay.", { version: esc(mine) })}</div>
      ${notes ? `<div class="upd-notes tk-md">${renderMarkdown(notes.length > 4000 ? notes.slice(0, 4000) + "…" : notes)}</div>` : ""}
      <a class="upd-link" data-upd="notes" href="#">${tx("The release on GitHub")}</a>`;
    buttons = `<button class="tk-btn" data-upd="skip">${tx("Skip This Version")}</button><span class="grow"></span>
      <button class="tk-btn" data-upd="later">${tx("Remind Me Later")}</button><button class="tk-btn primary" data-upd="download">${tx("Download")}</button>`;
  } else {
    body = error
      ? `<div class="upd-title">${tx("Paw couldn't check for updates")}</div><div class="upd-sub">${esc(error)}</div>`
      : `<div class="upd-title">${tx("You're up to date")}</div><div class="upd-sub">${tx("Paw {version} is the newest version.", { version: esc(upToDate ?? "") })}</div>`;
    buttons = `<span class="grow"></span><button class="tk-btn primary" data-upd="ok">${tx("OK")}</button>`;
  }
  box.innerHTML = `<div class="upd-card" role="dialog" aria-modal="true"><img class="upd-icon" src="icon.png" alt="">
    <div class="upd-main">${body}<div class="upd-row">${buttons}</div></div></div>`;
  const close = () => { box.remove(); updateShown = false; document.removeEventListener("keydown", onKey, true); $("input")?.focus(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (rel) remindLater(); close(); }
  };
  const remindLater = () => { try { localStorage.setItem("paw.update.later", JSON.stringify({ version: latest, until: Date.now() + UPDATE_LATER })); } catch {} };
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-upd]");
    if (!b) return;
    e.preventDefault();
    switch (b.dataset.upd) {
      case "download": {
        const dmg = (rel.assets ?? []).find((a) => /\.dmg$/i.test(a.name));
        invoke("open_url", { url: dmg?.browser_download_url ?? rel.html_url }).catch(() => {});
        remindLater();
        break;
      }
      case "notes": invoke("open_url", { url: rel.html_url }).catch(() => {}); return;
      case "skip":
        settings.general.skip_version = latest;
        await invoke("save_settings", { settings }).catch(() => {});
        break;
      case "later": remindLater(); break;
    }
    close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(box);
  updateShown = true;
  box.querySelector(".upd-row .primary")?.focus();
}

/** When it starts (a little later, not in its way) and every few hours after. */
function scheduleUpdateChecks() {
  let last = 0;
  try { last = Number(localStorage.getItem("paw.update.checked")) || 0; } catch {}
  const first = Math.max(15e3, last + UPDATE_EVERY - Date.now());
  setTimeout(() => { checkForUpdates(); setInterval(() => checkForUpdates(), UPDATE_EVERY); }, Math.min(first, UPDATE_EVERY));
}

// ---------- which menu items apply ----------
// The native menu greys out what makes no sense in the tab you're in: the
// Factory menu outside a factory, Stop with nothing running, Stop Task with
// no task going… The window works it out and tells the app when it changes.
let menuSent = "", menuTimer = 0;
function menuState() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    const S = curS();
    const host = $("task-view");
    const has = (fact) => !!(S?.factory && host?.querySelector(`[data-fact="${fact}"]`));
    const f = S?.factory ? factoryById(S.factory.id) : null;
    const on = {
      "close-tab": !!S,
      "fork-tab": canFork(S),
      "clear": !!S,
      "interrupt": !!S && (isBusy(S) || !!S.shellBusy),
      "attach-files": !!S && !S.shellBusy,
      "session-folder": !!S,
      "sandbox-toggle": !!S && !S.nodeOf && isPaw(S.agent),
      "next-tab": openTabs.length > 1,
      "prev-tab": openTabs.length > 1,
      "factory-run": has("run"),
      "factory-stop": has("stop"),
      "factory-lock": has("lock"),
      "factory-reset-layout": has("layout-reset"),
      "factory-edit": has("edit"),
      "factory-delete": !!f,
    };
    const key = JSON.stringify(on);
    if (key === menuSent || !window.__TAURI_INTERNALS__) return;
    menuSent = key;
    invoke("menu_state", { enabled: on }).catch(() => {});
  }, 60);
}

/** Factory menu: what the factory tab you're in does (the same as its buttons). */
function factoryMenu(S, id) {
  if (!S?.factory) {
    if (S) sys(S, tx("The Factory menu acts on a factory's tab: open one first (the sidebar's Factories)."));
    return false;
  }
  if (id === "factory-delete") { deleteFactory(S.factory.id); return true; }
  const fact = { "factory-run": "run", "factory-stop": "stop", "factory-lock": "lock", "factory-reset-layout": "layout-reset", "factory-edit": "edit" }[id];
  const b = $("task-view")?.querySelector(`[data-fact="${fact}"]`);
  if (b) { b.click(); return true; }
  sys(S, {
    stop: tx("No task of this factory is running in the run shown."),
    "layout-reset": tx("Nothing to reset: unlock the diagram first, after moving its boxes."),
  }[fact] ?? tx("The factory can't do that now."));
  return false;
}

// Tick the sidebar/tabs while something is running (elapsed timers, dots).
setInterval(() => {
  if ([...sessions.values()].some(isBusy)) renderSidebar();
}, 1000);

// ---------- boot ----------
/** One wait for the first scan, shared by everyone asking (restored tabs, boot). */
let detectionsWait = null;
function waitForDetections(timeoutMs) {
  if (detectionsReady) return Promise.resolve();
  return (detectionsWait ??= new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    listen("agents:detected", () => { clearTimeout(t); resolve(); });
  }));
}

(async () => {
  homeDir = await invoke("home_dir");
  settings = await invoke("get_settings");
  // The language Settings has (the page loaded with the one remembered): if
  // they differ, load again in the right one before anything is shown.
  if (I18N.pick(settings.general?.language) !== I18N.lang) { I18N.remember(settings.general?.language); location.reload(); return; }
  const first = createPane();
  layout = { type: "pane", pane: first };
  focusedPane = activePane = first;
  first.root.classList.add("focused");
  renderLayout();
  applyCurrentTheme();
  applyFonts();
  detections = await invoke("get_detections", { rescan: false });
  detectionsReady = Object.keys(detections).length > 0;
  invoke("history_list").then((list) => { shellHistory = list; });
  invoke("shell_commands").then((list) => { shellCommands = new Set(list); for (const P of panes.values()) withPane(P, updateGlyph); });
  // A newer Paw on GitHub? (Settings › General › Updates can turn this off.)
  if (window.__TAURI_INTERNALS__) scheduleUpdateChecks();

  // Which daemon runs the agents (started now if it wasn't running).
  try {
    const h = await tauriInvoke("daemon_hello");
    daemon.instance = h?.instance ?? null;
    daemon.last = h?.last ?? 0;
  } catch (e) {
    console.error("daemon:", e);
  }
  if (openTabs.length) { wsReady = true; select(openTabs[0]); return; }

  // Bring back last run's tabs (Claude conversations resume).
  const restored = await restoreWorkspace();
  wsReady = true;
  refreshArchive();
  loadPlugins();
  listen("plugins:changed", () => loadPlugins());
  trayUpdateSoon();
  // The daemon stopped (Quit Paw in the menu bar quits this window too, so
  // this is a crash): its agents and shells are gone; a new one starts.
  listen("daemon:lost", () => {
    daemon.instance = null;
    for (const S of sessions.values()) {
      if (S.proc != null) { procToSid.delete(S.proc); S.proc = null; if (S.info) S.info = { ...S.info, status: "stopped" }; }
      if (S.shell != null) { shellToSid.delete(S.shell); S.shell = null; }
      S.shellBusy = false;
      S.raw = false;
      if (isPaw(S.agent)) expirePawCards(S);
      if (S.working || S.busy) {
        S.busy = false;
        taskTurnEnded(S, { ok: false, stopped: true, text: "", error: tx("Paw's background process stopped.") });
        turnFinished(S);
      }
      sys(S, tx("Paw's background process stopped, and its agents with it. It's starting again; your next prompt continues the conversation."));
      refresh(S);
    }
  });
  listen("daemon:up", ({ payload: h }) => {
    daemon.instance = h?.instance ?? null;
    daemon.last = h?.last ?? 0;
    for (const S of sessions.values()) {
      if (S.shell == null) openShell(S);
      if (S.mode !== "oneshot" && S.proc == null) startProc(S, undefined, { resume: !!(S.agent.continuity === "session" && S.session) });
    }
    saveWorkspaceSoon();
  });
  // A tab picked in the menu bar.
  initFactories();
  listen("tray:open", ({ payload: id }) => {
    const S = [...sessions.values()].find((x) => x.pawId === id);
    if (!S) return;
    const g = S.group ? groups.get(S.group) : null;
    if (g?.collapsed) g.collapsed = false;
    select(S.sid);
  });
  if (restored) { saveWorkspaceSoon(); return; }

  // Like a terminal: open a tab on launch, with the default model (or, with
  // none yet, as a terminal: see pawStart).
  select(null);
  await waitForDetections(15000);
  // No model yet still opens one: it's a terminal until a provider is connected.
  if (!sessions.size && defaultAgent()) newSession();
  else renderWelcome();
})();

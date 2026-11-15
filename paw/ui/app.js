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
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
// Ids inside the session view exist once per pane; they resolve inside the
// pane being rendered (activePane). Everything else is a normal page id.
const PANE_IDS = new Set(["session", "terminal", "output", "xterm-wrap", "xterm-title", "xterm-int", "xterm-back",
  "xterm-hosts", "busy", "busy-spin", "busy-text", "busy-time", "ac", "prompt-line", "att-tray", "input",
  "attach-btn", "mode-pill", "sl-left", "eof", "prompt-glyph", "task-view"]);
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
let settings = { general: { default_cwd: "~", only_installed: true, default_agent: "claude" }, agents: [] };
let detections = {};
let detectionsReady = false;

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tildify = (p) => (p && homeDir && p.startsWith(homeDir) ? "~" + p.slice(homeDir.length) : p);
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
  const list = [...(detections[a.id]?.models ?? [])];
  for (const m of a.custom_models) if (!list.includes(m)) list.push(m);
  if (a.default_model && !list.includes(a.default_model)) list.push(a.default_model);
  return list;
}
function defaultModel(a) {
  return a.default_model ?? (needsModel(a) ? modelsFor(a)[0] ?? "" : "");
}

// ---------- sessions ----------
const isRunning = (S) => S.info?.status === "running";
const agentBusy = (S) => isRunning(S) && (S.mode === "claude" ? S.busy : S.mode === "oneshot");
const isBusy = (S) => agentBusy(S) || !!S.shellBusy;

function sessionState(S) {
  if (isBusy(S)) return "running";
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

const newPawId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-tab`);
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
/** Claude Code: the scripts folder is one it may write to, and it's told what it's for. */
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
  const agent = agentId ? settings.agents.find((a) => a.id === agentId) : defaultAgent();
  if (!agent) {
    invoke("open_preferences", { tab: "agents" });
    return null;
  }
  let cwd = opts.cwd ?? settings.general.default_cwd ?? "~";
  try { cwd = await invoke("resolve_dir", { path: cwd, base: homeDir }); } catch { cwd = homeDir; }

  const S = {
    sid: nextSid++,
    pawId: newPawId(),
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
  if (opts.stepOf) S.stepOf = opts.stepOf;
  sessions.set(S.sid, S);
  openTabs.splice(opts.after ? tabInsertIndex(opts.after) : openTabs.length, 0, S.sid);
  // A task and its steps are a group; a step joins its task's.
  if (opts.task) ensureTaskGroup(S);
  if (opts.stepOf && opts.after) addToGroup(S, ensureTaskGroup(opts.after), false);
  banner(S);
  if (opts.background) { renderTabs(); saveWorkspaceSoon(); } else select(S.sid);
  openShell(S);
  if (S.mode !== "oneshot") await startProc(S);
  return S;
}

function banner(S) {
  if (S.task) return taskBanner(S);
  const d = detections[S.agent.id];
  const ver = isPaw(S.agent) ? ` <span class="dim">built-in · ${esc(S.agent.provider === "anthropic" ? "Anthropic" : "Ollama")}</span>`
    : d?.version ? ` <span class="dim">${esc(d.version)}</span>` : "";
  info(S,
    `<b>${esc(S.agent.name)}</b>${ver}\n` +
    `<span class="dim">model</span> ${esc(S.model || "default")}  <span class="dim">cwd</span> ${esc(tildify(S.cwd))}\n` +
    `<span class="dim">${S.mode === "oneshot" ? "Each prompt runs the agent once in this folder." : "Type a prompt to start."} ` +
    `Shell commands (<span class="sh">$</span> ls, git status…) run in your shell. /help for more.</span>`);
}

const shq = (s) => (/^[\w\-./:=@+,]+$/.test(s) ? s : "'" + s.replace(/'/g, `'\\''`) + "'");

async function startProc(S, prompt, { resume = false } = {}) {
  if (isPaw(S.agent)) return pawStart(S, { resume });
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
  else await invoke("stop_agent", { id: S.proc, force });
}

// ---------- Paw Agent ----------
// A session lives in the Paw process. Its conversation is saved there after
// every prompt (by S.session), so restarts and a new Paw continue it.
async function pawStart(S, { resume = false } = {}) {
  try {
    const ext = await externalSetup();
    S.skillsSig = ext.signature; // its system prompt lists the skills
    const saved = (settings.allow_rules ?? []).filter((r) => r.agent === S.agent.id && r.folder === S.cwd).map((r) => r.rule);
    const reply = await invoke("paw_agent_start", { opts: {
      name: `${S.agent.name} — ${basename(S.cwd)}`,
      provider: S.agent.provider || "ollama",
      model: S.model || "",
      base_url: S.agent.base_url || "",
      cwd: S.cwd,
      approval: S.approval,
      allow_rules: saved,
      session: resume && S.session ? S.session : null,
      key_source: S.agent.key_source || "",
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

async function closeSession(sid) {
  const S = sessions.get(sid);
  if (!S) return;
  if (isBusy(S) && !confirm(`${S.agent.name} is still working. Close the tab and stop it?`)) return;
  if (S.task?.state === "running" && !confirm("This task is running. Close it and stop its steps? Their tabs stay open.")) return;
  taskTabClosing(S);
  if (S.proc != null) invoke(isPaw(S.agent) ? "paw_agent_close" : "remove_agent", { id: S.proc }).catch(() => {});
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
  if (text.trim() && S.history[S.history.length - 1] !== text) S.history.push(text);
  S.histIdx = S.history.length;
  S.draft = "";

  if (text.startsWith("/") && (await slashCommand(S, text.trim()))) return;

  // A shell command is still running: the line is input for it (y/N, passwords…).
  if (S.shellBusy) {
    await invoke("shell_write", { id: S.shell, text }).catch((e) => sys(S, `✗ ${e}`));
    return;
  }
  let route = routeFor(S, text);
  if (!route.shell && S.inputMode === "auto" && (await lookupFirstWord(S, text))) route = routeFor(S, text);
  // Attachments only, no text, or pasted text: that's for the agent.
  if (!text.trim() || S.attachments?.some(isPasted)) route = { shell: false };
  const atts = takeAttachments(S);
  if (route.shell) {
    // Like dropping files into a terminal: quoted paths become arguments.
    await runShell(S, [route.command, ...atts.map((a) => shq(a.path))].join(" "));
    return;
  }
  if (S.task) return taskSubmit(S, text, atts);
  await sendToAgent(S, text, atts);
}

/** opts.wrap(text): what the agent gets around the text you see (tasks add their context). */
async function sendToAgent(S, text, atts = [], opts = {}) {
  // Pasted text badges go along as text after what was typed; files as files.
  const pasted = atts.filter(isPasted);
  atts = atts.filter((a) => !isPasted(a));
  const body = withPasted(text, pasted);
  const echoed = [...atts, ...pasted];
  const skillNote = await syncExternalSkills(S);
  const ctx = takeShellContext(S);
  const full = [skillNote.text, ctx.text, opts.wrap ? opts.wrap(body) : body].filter(Boolean).join("\n\n");
  S.lastAnswer = "";
  renderAttachments();
  if (S.mode === "oneshot") {
    if (isRunning(S)) {
      sys(S, "still running — wait for it to finish, or ⌘. to stop");
      return;
    }
    // Changed folder: like Claude, every agent starts a new conversation there.
    if (S.agentCwd && S.agentCwd !== S.cwd && (S.session || S.turns?.length)) {
      S.session = null;
      S.turns = [];
      sys(S, `folder changed to ${tildify(S.cwd)} · new conversation`);
    }
    pushLine(S, { stream: "stdin", text, attachments: echoed, shared: ctx.count, skills: skillNote.count, ts: Date.now() });
    const prompt = S.agent.continuity === "replay" ? withReplay(S, full) : full;
    if (S.agent.continuity === "replay") (S.turns ??= []).push({ user: body, assistant: "", open: true });
    S.lastPrompt = withPaths(full, atts);
    await startProc(S, withPaths(prompt, atts));
    skillNote.sent();
    return;
  }

  // The shell moved (cd) since the agent started: follow it. Claude keeps
  // conversations per folder, so this starts a fresh one.
  if (isRunning(S) && S.agentCwd && S.agentCwd !== S.cwd) {
    await restart(S, `agent moved to ${tildify(S.cwd)} (new conversation)`, { resume: false });
  }
  if (!isRunning(S)) {
    sys(S, "agent was not running — starting it");
    await startProc(S);
    if (!isRunning(S)) return;
  }
  // Echo the prompt (with its attachments) ourselves; the backend's copy of
  // the stdin line would carry the raw JSON / image data.
  pushLine(S, { stream: "stdin", text, attachments: echoed, shared: ctx.count, skills: skillNote.count, ts: Date.now() });
  if (isPaw(S.agent)) {
    S.busy = true;
    S.busySince = Date.now();
    refresh(S);
    try {
      // Attached files go as paths; the agent reads them (images too).
      await invoke("paw_agent_send", { id: S.proc, text: withPaths(full, atts) });
    } catch (e) {
      S.busy = false;
      sys(S, `✗ ${e}`);
    }
    refresh(S);
    return;
  }
  const payload = S.mode === "claude"
    ? JSON.stringify({ type: "user", message: { role: "user", content: claudeContent(full, atts) } })
    : withPaths(full, atts);
  if (S.mode === "claude") { S.busy = true; S.busySince = Date.now(); }
  try {
    await invoke("send_input", { id: S.proc, text: payload });
    skillNote.sent();
  } catch (e) {
    S.busy = false;
    sys(S, `✗ ${e}`);
  }
  refresh(S);
}

/** /help: grouped, and specific to this tab's agent and conversation. */
function helpHtml(S) {
  const row = (k, d) => `<span class="cmd">${esc(k.padEnd(17))}</span><span class="dim">${esc(d)}</span>`;
  const head = (t) => `<span class="help-h">${esc(t)}</span>`;
  const name = S.agent.name;
  const turns = (S.turns ?? []).filter((t) => !t.open).length;
  const convo = {
    session: S.session
      ? `continues in ${name} session ${String(S.session).slice(0, 8)}, also after a restart`
      : `a ${name} session starts with your first prompt and continues after a restart`,
    replay: `Paw keeps it${turns ? ` (${turns} turn${turns === 1 ? "" : "s"} so far)` : ""} and sends it with each prompt; it continues after a restart`,
    none: "every prompt stands alone",
  }[S.agent.continuity || "replay"];
  const modeName = { auto: "Auto", shell: "Shell", agent: "Agent" }[S.inputMode] ?? "Auto";
  const out = [
    head("This tab"),
    `<span class="dim">${esc(name)} · ${esc(S.model || "default model")} · ${esc(tildify(S.cwd))} · input mode ${modeName}` +
      (approvalValue(S) ? ` · approval ${esc(S.approval)}` : "") + "</span>",
    `<span class="dim">Conversation: ${esc(convo)}. A new tab always starts a new one.</span>`,
    "",
    head("Typing"),
    row("<text>", S.inputMode === "shell" ? "runs in this tab's shell (Shell mode)" :
      S.inputMode === "agent" ? `goes to ${name} (Agent mode)` : `goes to ${name}; lines that look like commands run in the shell`),
    row("!<command>", "always run in the shell"),
    row("/ask <text>", `always send to ${name}`),
    row("⇧Tab", "switch input mode: Auto → Shell → Agent"),
    row("⌃R", "search earlier prompts and commands"),
    row("Tab · ↑↓", "complete commands and paths · previous prompts"),
    row("+ · ⌘V", "attach files · paste an image · long pasted text becomes a badge (click it to edit)"),
  ];
  if (settings.general.share_shell !== false) {
    if (isPaw(S.agent)) out.push(row("$ badge", `long shell output that goes along with your next message (× leaves it out); short output goes to ${name} right away`));
    else out.push(row("$ badge", `shell output that goes along with your next message (× leaves it out)`));
  }
  out.push("", head("Agent"),
    row("/model [name]", "show or switch the model (conversation continues)"),
    row("/agent [id]", "switch the agent in this tab (new conversation)"));
  const levels = approvalLevels(S.agent);
  if (levels.length && hasLevels(S.agent)) {
    out.push(row("/approval [level]", `how much ${name} may do on its own: ${levels.join(" · ")}`));
  }
  out.push(
    row("/restart", "restart the agent (conversation continues)"),
    row("/stop", "stop the agent or running command (⌘. · Ctrl-C)"),
    row("/new [agent]", "open a new tab with a new conversation"),
    row("/task [what]", `plan a task with ${name} and run its steps on several agents (pasted text counts too)`),
    row("/clear", "clear the screen (⌘K)"),
    row("/session", "open this tab's folder: its conversation, files, scripts and command log"),
    "", head("Shell"),
    row("/cd <dir>", "change folder; the agent follows with a new conversation"),
    row("history [n | -c]", "show the last n shell commands, or clear the history"),
    row("vim, top, ssh…", "full-screen and interactive programs open in a terminal view"),
    "", head("Window"),
    row("⌘T · ⌘⇧T · ⌘W", "new tab · new tab with another agent · close tab"),
    row("⌘1–9 · ⌘⇧[ ]", "go to tab · previous / next tab"),
    row("⌘D · ⌘⇧D", "split side by side · split stacked"),
    row("⌘⌥ arrows", "move between panes"),
    row("⌃⌘S · ⌘,", "show / hide the sidebar · settings"),
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
      if (!arg) {
        const list = needsModel(S.agent) ? modelsFor(S.agent) : ["default", ...modelsFor(S.agent)];
        const cur = S.model || "default";
        info(S, list.length
          ? list.map((m) => (m === cur ? `<span class="ok">● ${esc(m)}</span>` : `<span class="dim">○</span> ${esc(m)}`)).join("\n")
          : `<span class="dim">No known models. Use /model &lt;name&gt; or add some in Settings.</span>`);
        return true;
      }
      S.model = arg === "default" ? "" : arg;
      if (S.mode === "oneshot") sys(S, `model → ${S.model || "default"}`);
      else await restart(S, `model → ${S.model || "default"} (conversation kept)`);
      refresh(S);
      return true;
    }
    case "/agent": {
      echo();
      const list = availableAgents();
      if (!arg) {
        info(S, list.map((a) => (a.id === S.agent.id ? `<span class="ok">● ${esc(a.id)}</span>` : `<span class="dim">○</span> ${esc(a.id)}`) + `  <span class="dim">${esc(a.name)}</span>`).join("\n"));
        return true;
      }
      const a = list.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
      if (!a) { sys(S, `✗ unknown agent: ${arg}`); return true; }
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
        info(S, `<span class="dim">${esc(S.agent.name)} has no approval levels set up. Add them in Settings › Agents › ${esc(S.agent.name)} › Approval levels.</span>`);
        return true;
      }
      if (!arg || !levels.includes(arg)) {
        if (arg) sys(S, `✗ ${S.agent.name} doesn't support "${arg}"`);
        info(S, levels.map((l) => (l === S.approval ? `<span class="ok">● ${l.padEnd(6)}</span>` : `<span class="dim">○</span> ${l.padEnd(6)}`) +
          ` <span class="dim">${esc(approvalText(S.agent, l))}</span>`).join("\n"));
        return true;
      }
      S.approval = arg;
      if (S.mode === "oneshot") sys(S, `approval → ${arg}`);
      else await restart(S, `approval → ${arg} (conversation continues)`);
      refresh(S);
      return true;
    }
    case "/restart":
      echo();
      await restart(S, "restarting agent");
      return true;
    case "/stop":
      echo();
      await interrupt(S);
      return true;
    case "/new":
      await newSession(arg || undefined);
      return true;
    case "/session": {
      echo();
      const dir = await sessionDir(S);
      if (!dir) { sys(S, "✗ couldn't make this tab's session folder"); return true; }
      info(S, `<span class="dim">This tab's folder</span> ${esc(tildify(dir))}\n` +
        `<span class="dim">session.json · conversations/ · files/ (attached and pasted) · scripts/ · commands.log · launch.sh</span>`);
      if (arg !== "path") invoke("session_dir", { id: S.pawId, reveal: true }).catch(() => {});
      return true;
    }
    case "/task": {
      // Plan it with this tab's agent, in this tab's folder. Pasted text
      // badges are part of the goal ("/task" alone: the pasted text is it).
      const pasted = (S.attachments ?? []).filter(isPasted);
      if (pasted.length) { S.attachments = S.attachments.filter((a) => !isPasted(a)); renderAttachments(); }
      await newTask({ agentId: S.agent.id, cwd: S.cwd, goal: arg, atts: pasted });
      return true;
    }
    default:
      return false; // not ours — send it to the agent unchanged
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
    sys(S, `✗ could not start a shell: ${e}`);
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
  ask: "ask before acting (actions that need approval are declined)",
  edits: "may edit files without asking",
  auto: "decides routine actions itself; asks before risky ones",
  plan: "read-only: plan, don't change anything",
  full: "no confirmations at all — use with care",
};
/** Paw Agent asks instead of declining. */
const PAW_APPROVAL_TEXT = {
  ...APPROVAL_TEXT,
  ask: "asks before every file change and command",
  edits: "edits files on its own; asks before commands",
  auto: "edits files in this folder and runs routine commands on its own; asks before risky ones",
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
const MODE_LABEL = { auto: "Auto", shell: "Shell", agent: "Agent" };

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
    auto: "Auto: commands go to the shell, everything else to the agent. ⇧Tab to switch.",
    shell: "Shell: every line runs in the shell. ⇧Tab to switch.",
    agent: "Agent: every line goes to the agent (!cmd still runs in the shell). ⇧Tab to switch.",
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
    out.appendChild(el);
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
  sys(S, "shell exited — the next command starts a new one");
  refresh(S);
});

// ---------- shell history & autocomplete ----------
// History is shared by all tabs and stored by the backend (size: Settings ›
// General). The popup suggests, in order: history lines, command names (first
// word) and file/folder paths (later words, relative to the tab's folder).
let shellHistory = [];
const ac = { items: [], sel: -1, open: false, seq: 0, full: false, search: false };

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
    sys(S, "history cleared");
    return true;
  }
  const n = m[1] ? Number(m[1]) : 25;
  const start = Math.max(0, shellHistory.length - n);
  const width = String(shellHistory.length).length;
  shellHistory.slice(start).forEach((c, i) =>
    pushLine(S, { stream: "shell", text: `${String(start + i + 1).padStart(width)}  ${c}`, ts: Date.now() }));
  if (!shellHistory.length) sys(S, "history is empty");
  return true;
}

let acTimer = null;
function scheduleAutocomplete() {
  clearTimeout(acTimer);
  // While ⌃R search is open, typing refines the search instead.
  acTimer = setTimeout(() => (ac.search ? historySearch() : updateAutocomplete()), 40);
}

/**
 * Refresh the popup.
 *  - While typing (`full` = false): only Paw's own history.
 *  - On Tab (`full` = true): history plus command names (first word) or
 *    file/folder paths (later words), like a shell's completion.
 */
async function updateAutocomplete(full = false) {
  const S = curS();
  const ta = $("input");
  const value = ta.value;
  if (!S || S.shellBusy || !value.trim() || value.includes("\n") || ta.selectionStart !== value.length) return closeAc();
  const forced = value.startsWith("!");
  if (S.inputMode === "agent" && !forced) return closeAc();
  const looksShell = forced || S.inputMode === "shell" || classify(value, S).shell;

  const seq = ++ac.seq;
  const bang = forced ? "!" : "";
  const line = forced ? value.slice(1) : value;
  const items = [];
  const seen = new Set();
  const add = (it) => {
    if (it.value === value || seen.has(it.value)) return;
    seen.add(it.value);
    items.push(it);
  };

  // History: lines that start with the input (newest first), then — only for
  // input that already looks like a command — lines that contain it.
  const newestFirst = [...shellHistory].reverse();
  for (const h of newestFirst) {
    if (h.startsWith(line)) add({ kind: "history", value: bang + h, label: h, match: [0, line.length] });
  }
  if (looksShell && line.trim().length >= 2) {
    for (const h of newestFirst) {
      const i = h.indexOf(line.trim());
      if (i > 0) add({ kind: "history", value: bang + h, label: h, match: [i, i + line.trim().length] });
    }
  }
  items.splice(full ? 6 : 12);

  if (full) {
    const word = value.match(/(\S*)$/)[1];
    const start = value.length - word.length;
    const head = value.slice(0, start);
    if (!head.replace(/^!/, "").trim()) {
      const w = word.replace(/^!/, "");
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
      const paths = await invoke("complete_path", { cwd: S.cwd, word });
      if (seq !== ac.seq) return;
      for (const p of paths) {
        if (dirsOnly && !p.is_dir) continue;
        add({ kind: p.is_dir ? "dir" : "file", value: head + p.value, label: p.value, match: [0, word.length] });
      }
    }
  }
  if (seq !== ac.seq) return;
  ac.full = full;
  ac.items = items.slice(0, 50);
  ac.sel = -1;
  ac.items.length ? renderAc() : closeAc();
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
  const needle = q.trim().toLowerCase();
  const items = [];
  const seen = new Set();
  const inShell = new Set(shellHistory);
  const add = (line, kind) => {
    if (!line.trim() || seen.has(line)) return;
    const i = needle ? line.toLowerCase().indexOf(needle) : 0;
    if (i < 0) return;
    seen.add(line);
    items.push({ kind, value: line, label: line.replace(/\n/g, " ⏎ "), match: needle ? [i, i + needle.length] : [0, 0] });
  };
  for (const h of [...S.history].reverse()) add(h, inShell.has(h) ? "history" : "prompt");
  for (const h of [...shellHistory].reverse()) add(h, "history");
  ac.seq++;
  ac.search = true;
  ac.full = false;
  ac.items = items.slice(0, 100);
  ac.sel = ac.items.length ? 0 : -1;
  renderAc();
}

const AC_ICON = { history: "↺", command: "›_", dir: "▸", file: "·", prompt: "❯" };
function renderAc() {
  const el = $("ac");
  el.innerHTML = "";
  if (ac.search && !ac.items.length) {
    el.insertAdjacentHTML("beforeend", `<div class="ac-empty">No earlier line contains “${esc($("input").value.trim())}”</div>`);
  }
  ac.items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "ac-item" + (i === ac.sel ? " sel" : "");
    const [a, b] = it.match ?? [0, 0];
    const label = `${esc(it.label.slice(0, a))}<b>${esc(it.label.slice(a, b))}</b>${esc(it.label.slice(b))}`;
    row.innerHTML = `<span class="ac-icon ${it.kind}">${AC_ICON[it.kind]}</span><span class="ac-label">${label}</span><span class="ac-kind">${it.kind}</span>`;
    row.onmousedown = (e) => { e.preventDefault(); acceptAc(i); };
    row.onmousemove = () => { if (ac.sel !== i) { ac.sel = i; renderAc(); } };
    el.appendChild(row);
  });
  const hint = document.createElement("div");
  hint.className = "ac-hint";
  hint.textContent = ac.search ? "History search · type to filter · ⌃R / ↑↓ older · ⏎ / Tab use · Esc close"
    : ac.full ? "↑↓ select · Tab / ⏎ accept · Esc close"
    : "History · ↑↓ select · ⏎ accept · Tab for commands & files · Esc close";
  el.appendChild(hint);
  el.classList.remove("hidden");
  ac.open = true;
  el.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function closeAc() {
  ac.open = false;
  ac.search = false;
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
  // Keep completing into folders and after a command name.
  if (it.kind === "dir" || it.kind === "command") updateAutocomplete(true);
  else closeAc();
}

/** Handles popup keys; returns true when the key was consumed. */
function autocompleteKey(e) {
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "r") {
    e.preventDefault();
    historySearch(true);
    return true;
  }
  if (ac.search && e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    if (ac.sel >= 0) acceptAc(ac.sel);
    return true;
  }
  if (e.key === "Tab" && e.shiftKey) {
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
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12.5,
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
    $("xterm-title").textContent = S.rawCmd ? `Terminal · ${S.rawCmd}` : "Terminal";
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
    S.rawCmd = S.shellBusy ? S.shellCmd : "";
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

function addAttachments(S, list) {
  S.attachments ??= [];
  for (const a of list) {
    if (S.attachments.some((x) => x.path === a.path)) continue;
    S.attachments.push(a);
    makeThumb(a);
  }
  renderAttachments();
  updateGlyph();
}

// Long pasted text becomes a badge ("Pasted text · 12 lines") so the prompt
// stays readable; the text goes along with the message, after what you type.
// Clicking the badge puts the text back into the prompt.
const PASTE_BADGE_LINES = 4;
const PASTE_BADGE_CHARS = 600;
const isPasted = (a) => a?.kind === "text";
let nextPaste = 1;
function pastedAttachment(text) {
  const n = nextPaste++;
  return { kind: "text", text, name: `Pasted text #${n}`, path: `pasted:${Date.now()}:${n}`, size: new Blob([text]).size, lines: text.split("\n").length };
}
const shouldBadge = (text) => text.split("\n").length >= PASTE_BADGE_LINES || text.length > PASTE_BADGE_CHARS;
/** The message: what was typed, then each pasted text. */
const withPasted = (text, atts = []) => [text, ...atts.filter(isPasted).map((a) => a.text)].filter((t) => t?.trim()).join("\n\n");
const pastedLabel = (a) => `Pasted text · ${a.lines} line${a.lines === 1 ? "" : "s"}`;

/** Hand over the tab's attachments to whatever is sending them. */
function takeAttachments(S) {
  const list = S.attachments ?? [];
  S.attachments = [];
  renderAttachments();
  return list;
}

function chipHtml(a, removable) {
  if (isPasted(a)) {
    return `<span class="att-icon">TXT</span><span class="att-name" title="${esc(String(a.text ?? "").slice(0, 600))}">${esc(pastedLabel(a))}</span>` +
      (removable ? `<button class="att-x" title="Remove">×</button>` : "");
  }
  const ext = (a.name.split(".").pop() || "file").slice(0, 4).toUpperCase();
  const icon = a.thumb ? `<img class="att-thumb" src="${a.thumb}" alt="">`
    : `<span class="att-icon">${isInlineImage(a) ? "IMG" : esc(ext)}</span>`;
  return `${icon}<span class="att-name" title="${esc(a.path)}">${esc(a.name)}</span>` +
    `<span class="att-size">${fmtSize(a.size)}</span>` + (removable ? `<button class="att-x" title="Remove">×</button>` : "");
}

function renderAttachments() {
  const S = curS();
  const tray = $("att-tray");
  const list = S?.attachments ?? [];
  const ctx = shareShell() ? S?.shellContext ?? [] : [];
  tray.classList.toggle("hidden", !list.length && !ctx.length);
  tray.innerHTML = "";
  if (ctx.length) {
    const el = div("att-badge ctx-badge",
      `<span class="att-badge-icon">$</span><span class="att-badge-name">${ctx.length} shell output${ctx.length > 1 ? "s" : ""}</span><button class="att-x" title="Don't share with the agent">×</button>`);
    el.title = "Sent to the agent with your next message:\n" + ctx.map((e) => `$ ${e.cmd}${e.code ? `  (exit ${e.code})` : ""}`).join("\n");
    el.querySelector(".att-x").onclick = (e) => { e.stopPropagation(); S.shellContext = []; renderAttachments(); $("input").focus(); };
    tray.appendChild(el);
  }
  list.forEach((a, i) => {
    if (isPasted(a)) {
      const el = div("att-badge paste-badge", `<span class="att-badge-icon">TXT</span><span class="att-badge-name">${esc(pastedLabel(a))}</span><button class="att-x" title="Remove">×</button>`);
      el.title = a.text.length > 600 ? a.text.slice(0, 600) + "…" : a.text;
      el.title += "\n\nClick to edit it in the prompt.";
      el.querySelector(".att-x").onclick = (e) => { e.stopPropagation(); S.attachments.splice(i, 1); renderAttachments(); $("input").focus(); };
      // Back into the prompt, at the cursor.
      el.onclick = () => {
        const ta = $("input");
        S.attachments.splice(i, 1);
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
    const el = div("att-badge", `${icon}<span class="att-badge-name">${esc(a.name)}</span><button class="att-x" title="Remove">×</button>`);
    el.title = `${a.path} · ${fmtSize(a.size)}`;
    el.querySelector(".att-x").onclick = (e) => { e.stopPropagation(); S.attachments.splice(i, 1); renderAttachments(); $("input").focus(); };
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
// Claude's replies are markdown. marked turns them into HTML and DOMPurify
// strips anything active (scripts, handlers, forms, frames, remote images).
marked.setOptions({ gfm: true, breaks: false });
function renderMarkdown(md) {
  try {
    const html = marked.parse(md, { async: false });
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "img", "video", "audio"],
      FORBID_ATTR: ["style"],
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
// Commands run in a tab (and their output) are collected until the next
// message to the agent, then sent ahead of it — so "why did that fail?" works.
// A badge in the prompt shows what will be shared; × leaves it out.
const SHELL_CTX_LINES = 150;     // per command, newest lines kept
const SHELL_CTX_BUDGET = 12000;  // characters for the whole block

const shareShell = () => settings.general.share_shell !== false;

function trackShellContext(S, line) {
  if (line.stream === "cmd") {
    S.shellContext ??= [];
    S.shellContext.push({ cmd: line.text, cwd: S.cwd, out: [], code: 0 });
    if (S.sid === activeId) renderAttachments();
  } else if (line.stream === "shell") {
    const e = S.shellContext?.at(-1);
    if (e) { e.out.push(PawThemes.stripAnsi(line.text)); if (e.out.length > 400) e.out.splice(0, e.out.length - 300); }
  } else if (line.stream === "shellexit") {
    const e = S.shellContext?.at(-1);
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

// Short output goes straight into a Paw Agent session when the command
// ends: the agent has it with its next turn, and it stays in the
// conversation. Longer output waits in the $ badge, where it can be left out.
const SHELL_DIRECT_CHARS = 4000;
const SHELL_DIRECT_LINES = 80;

async function shareShortOutput(S) {
  if (!isPaw(S.agent) || !shareShell() || !isRunning(S) || S.proc == null) return;
  // A new folder means a new conversation with the next prompt: the badge carries it there.
  if (S.agentCwd && S.agentCwd !== S.cwd) return;
  const e = S.shellContext?.at(-1);
  if (!e || needsTty(e.cmd) || e.out.length > SHELL_DIRECT_LINES) return;
  const block = shellBlock(e, true, Infinity);
  if (block.length > SHELL_DIRECT_CHARS) return;
  S.shellContext.pop();
  inPane(S, renderAttachments);
  try {
    await invoke("paw_agent_note", { id: S.proc, text: `I ran this in my terminal:\n<terminal>\n${block}\n</terminal>` });
    pushLine(S, { stream: "shared", ts: Date.now() });
  } catch {
    (S.shellContext ??= []).push(e); // the session ended: back to the badge
    inPane(S, renderAttachments);
  }
}

/** The shell context block for the next message (and forget it). */
function takeShellContext(S) {
  const entries = S.shellContext ?? [];
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
    tabs: openTabs.map((sid) => sessions.get(sid)).filter(Boolean).map((S) => ({
      id: S.pawId,
      group: S.group ?? undefined,
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
      stepOf: S.stepOf ?? undefined,
    })),
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

/** Recreate the tabs from the last run. Returns true if anything was restored. */
async function restoreWorkspace() {
  const ws = await invoke("load_workspace").catch(() => null);
  const tabs = ws?.tabs ?? [];
  let restored = 0;
  for (const t of tabs) {
    // The Ollama agent is gone; Paw Agent runs Ollama models now.
    const agentId = t.agent === "ollama" ? settings.agents.find(isPaw)?.id : t.agent;
    const agent = settings.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    let cwd = t.cwd;
    try { cwd = await invoke("resolve_dir", { path: cwd, base: homeDir }); } catch { cwd = homeDir; }
    // Tabs from before session folders take their conversation's id (Paw
    // Agent's conversation moved into session/<that id>), or a new one.
    const pawId = t.id ?? (isPaw(agent) && /^[0-9a-f-]{8,64}$/i.test(t.session ?? "") ? t.session : newPawId());
    const S = {
      sid: nextSid++, pawId, agent: structuredClone(agent), mode: sessionMode(agent), cwd,
      model: t.model ?? defaultModel(agent), approval: t.approval ?? approvalFromLegacy(t.perm) ?? defaultApproval(agent),
      proc: null, info: null, lines: (t.lines ?? []).slice(-WS_LINES), busy: false,
      history: t.history ?? [], histIdx: (t.history ?? []).length, draft: "", unread: 0,
      shell: null, shellBusy: false, inputMode: t.inputMode || settings.general.input_mode || "auto",
      session: t.session ?? t.claudeSession ?? null,
      turns: t.turns ?? [],
    };
    if (t.task) S.task = restoreTask(t.task);
    if (t.stepOf) S.stepOf = t.stepOf;
    if (t.group) S.group = t.group;
    sessions.set(S.sid, S);
    openTabs.push(S.sid);
    restored++;
    const resumable = S.agent.continuity === "session" && S.session;
    const replay = S.agent.continuity === "replay" && S.turns.length;
    S.lines.push({ stream: "system", ts: Date.now(),
      text: resumable ? `— restored after restart · attached to ${S.agent.name} session ${String(S.session).slice(0, 8)} (conversation continues) —`
        : replay ? `— restored after restart · ${S.agent.name} gets the ${S.turns.length} earlier turn${S.turns.length > 1 ? "s" : ""} with your next prompt (conversation continues) —`
        : `— restored after restart · no earlier conversation to continue —` });
    reloadThumbs(S);
    openShell(S);
    if (S.mode !== "oneshot") {
      startProc(S, undefined, { resume: !!resumable });
    }
  }
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
function allowArgs(S) {
  const t = S.agent.allow_template;
  if (!t || !t.includes("{rule}")) return "";
  return allowRulesFor(S).map((r) => " " + t.replaceAll("{rule}", shq(r))).join("");
}

function addApprovalCard(S, card) {
  pushLine(S, { stream: "approval", id: nextCardId++, state: "pending", agentName: S.agent.name, ts: Date.now(), ...card });
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
  addApprovalCard(S, { kind: "level", target: target ?? null, items: [{ label: `${S.agent.name} said an action needs approval` }] });
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
    settings.allow_rules ??= [];
    if (!settings.allow_rules.some((r) => r.agent === S.agent.id && r.folder === S.cwd && r.rule === it.rule)) {
      settings.allow_rules.push({ agent: S.agent.id, folder: S.cwd, rule: it.rule, label: it.broad ? "every file change" : it.label });
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
    ? (l.kind === "rules" || l.kind === "paw" ? `${esc(l.agentName)} needs your approval for:` : `${esc(l.agentName)} couldn't do something that needs approval.`)
    : { once: "✓ Allowed once", always: "✓ Always allowed in this folder", denied: "✗ Denied",
        expired: "— No longer waiting (the turn ended)" }[l.state] ?? "";
  const paw = l.kind === "paw";
  const broadText = (i) => (paw ? "allows every file change in this folder" : `allows every ${esc(i.rule)} action`);
  const list = (l.items ?? []).filter(() => l.kind === "rules" || paw)
    .map((i) => `<div class="ap-item"><code>${esc(i.label)}</code>${i.broad && l.state === "pending" ? ` <span class="dim">(“Always” ${broadText(i)})</span>` : ""}</div>`).join("");
  // Auto mode stopped to ask: say why.
  const why = paw && l.items?.[0]?.why ? `<div class="ap-why">Auto mode asks because ${esc(l.items[0].why)}.</div>` : "";
  el.innerHTML = `<div class="ap-title"><span class="ap-icon">${l.state === "pending" ? "⚠" : ""}</span>${title}</div>${list}${why}`;
  // The change or command in full, folded.
  const detail = paw && l.items?.[0]?.detail;
  if (detail && detail !== l.items[0].label.replace(/^\$ /, "")) {
    el.appendChild(fold("ap-detail", `<span class="dim">Show ${l.tool === "shell" ? "command" : "change"}</span>`, detail));
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
    btn("Allow once", "once", "primary");
    btn("Always in this folder", "always");
  } else if (l.kind === "level" && l.target) {
    btn(`Run again with “${l.target}” once`, "once", "primary");
    btn(`Use “${l.target}” for this tab`, "always");
  } else {
    row.appendChild(div("dim", l.kind === "rules"
      ? `${esc(l.agentName)} has no way to allow a single action yet — set its allow template in Settings › Agents.`
      : `Set up approval levels for ${esc(l.agentName)} in Settings › Agents to allow more.`));
  }
  btn(l.kind === "level" ? "Dismiss" : "Deny", "denied", "ghost");
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
  document.documentElement.style.setProperty("--win-opacity", String(opacity));
  for (const s of sessions.values()) if (s.term) s.term.term.options.theme = xtermTheme();
  if (extended !== ansiColors) {
    ansiColors = extended;
    for (const P of panes.values()) withPane(P, renderOutput);
  }
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyCurrentTheme);

// ---------- rendering: tabs, sidebar, header ----------
function tabLabel(S) {
  if (S.task) return taskTabLabel(S);
  const step = stepOfTab(S)?.st;
  if (step) return step.title;
  return `${S.agent.name} · ${basename(S.cwd)}`;
}

function renderTabs() {
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
    t.title = S.task ? `Task: ${S.task.goal || "new"} — planned by ${S.agent.name}` : step ? `Step of ${step.T.task.title}: ${S.agent.name} — ${tildify(S.cwd)}` : `${S.agent.name} — ${tildify(S.cwd)}`;
    const needs = S.task ? taskNeedsYou(S) : 0;
    t.innerHTML = (S.task ? `<span class="task-ico" aria-hidden="true"></span>` : "") +
      `<span class="dot ${S.task ? taskDotState(S) : sessionState(S)}"></span><span class="label">${esc(tabLabel(S))}</span>` +
      (needs ? `<span class="tab-badge" title="${needs} step${needs > 1 ? "s" : ""} waiting for your approval">${needs}</span>` : "") +
      `${S.unread ? `<span class="tab-unread"></span>` : ""}<button class="close" title="Close tab (⌘W)">×</button>`;
    t.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); closeSession(sid); } };
    t.onclick = () => select(sid);
    t.oncontextmenu = (e) => { e.preventDefault(); tabMenu(S, e.clientX, e.clientY); };
    t.querySelector(".close").onclick = (e) => { e.stopPropagation(); closeSession(sid); };
    tabs.appendChild(t);
  }
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
let groupSeq = 1;
const groupMembers = (gid) => openTabs.map((sid) => sessions.get(sid)).filter((S) => S?.group === gid);
function groupName(g) {
  if (g.name) return g.name;
  if (g.task) return [...sessions.values()].find((S) => S.task?.id === g.task)?.task.title || "Task";
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
  const busy = members.some((S) => (S.task ? taskDotState(S) : sessionState(S)) === "running");
  const needs = members.reduce((n, S) => n + (S.task ? taskNeedsYou(S) : 0), 0);
  const el = document.createElement("div");
  el.className = "tab-group" + (g.collapsed ? " collapsed" : "") + (name ? "" : " unnamed");
  el.style.setProperty("--g", color);
  el.title = `${name || "Group"} · ${members.length} tab${members.length === 1 ? "" : "s"} — click to ${g.collapsed ? "show" : "fold"}, right-click for more`;
  el.innerHTML = (g.task ? `<span class="tg-ico" aria-hidden="true"></span>` : "") +
    `<span class="tg-name">${esc(name)}</span>` +
    (g.collapsed ? `<span class="tg-count">${members.length}</span>` : "") +
    (busy ? `<span class="tg-busy" title="Working"></span>` : "") +
    (needs ? `<span class="tab-badge" title="${needs} waiting for your approval">${needs}</span>` : "");
  el.onclick = () => toggleGroup(g);
  el.ondblclick = (e) => { e.preventDefault(); renameGroup(g); };
  el.oncontextmenu = (e) => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); };
  el.dataset.group = g.id;
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
  input.placeholder = "Name this group";
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
        b.title = c;
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

function tabMenu(S, x, y) {
  const items = [{ label: "Add to new group", run: () => { const g = createGroup([S]); renameGroup(g); } }];
  for (const g of groups.values()) {
    if (g.id === S.group) continue;
    items.push({ label: `Add to “${groupName(g) || "unnamed group"}”`, dot: GROUP_COLORS[g.color], run: () => addToGroup(S, g.id) });
  }
  if (S.group) items.push({ label: "Remove from group", run: () => removeFromGroup(S) });
  items.push("-", { label: "Close tab", sub: "⌘W", run: () => closeSession(S.sid) });
  contextMenu(x, y, items);
}

function groupMenu(g, x, y) {
  const members = groupMembers(g.id);
  contextMenu(x, y, [
    { label: g.collapsed ? "Show tabs" : "Fold tabs", run: () => toggleGroup(g) },
    { label: "Rename…", run: () => renameGroup(g) },
    { swatches: true, current: g.color, pick: (c) => { g.color = c; renderTabs(); saveWorkspaceSoon(); } },
    "-",
    { label: "Ungroup", run: () => { for (const S of members) delete S.group; groups.delete(g.id); renderTabs(); saveWorkspaceSoon(); } },
    { label: `Close ${members.length} tab${members.length === 1 ? "" : "s"}`, run: async () => { for (const S of members) await closeSession(S.sid); } },
  ]);
}

// The sidebar shows skills; project skills depend on the active session's folder.
const focusedS = () => sessions.get(focusedPane?.sid);
function renderSidebar() {
  const cwd = focusedS()?.cwd ?? null;
  if (cwd !== skills.cwd) scanSkills();
  syncMcp();
}

function renderHeader() {
  const S = curS();
  if (!S) return;
  $("eof").disabled = !isRunning(S) || S.mode === "oneshot";

  const ph = {
    claude: isRunning(S) ? (S.history.length ? "Ask a follow-up…" : `Ask ${S.agent.name} anything…`) : "Agent stopped — ⏎ restarts it and sends",
    stdin: isRunning(S) ? "Write to stdin…" : "Process ended — ⏎ restarts it and sends",
    oneshot: isRunning(S) ? "Running… (⌘. to stop)" : `Prompt for ${S.agent.name}…`,
  }[S.mode];
  $("input").placeholder = S.shellBusy ? "Input for the running command…  (Ctrl-C interrupts)" : S.task ? taskPlaceholder(S) : ph;
  updateGlyph();
  $("sl-left").textContent = [S.agent.name, S.model || "default model", tildify(S.cwd)].join("  ·  ");
  renderModePill();
  renderBusy();
}

function refresh(S) {
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
  sys(S, ext.count ? `external skills reloaded (${ext.count}) · conversation continues` : "external skills removed · conversation continues");
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
    skillsMsg(`Couldn't read skills: ${e}`, true);
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

const AGENT_TAG = { "Claude Code": "Claude", Codex: "Codex", Shared: "Shared", opencode: "opencode" };

function skillItem(s, scope) {
  const key = `${scope}:${s.name}:${s.paths[0]}`;
  const open = skills.expanded.has(key);
  const tags = (s.agents ?? []).map((a) => `<span class="sk-tag" title="${esc(a === "Shared" ? "~/.agents/skills — read by several agents" : a)}">${esc(AGENT_TAG[a] ?? a)}</span>`).join("");
  let action = "";
  const busy = skills.busy.has(s.name);
  if (scope === "catalogue") {
    if (busy) action = `<button class="sk-btn" disabled>…</button>`;
    else if (s.blocked) action = `<button class="sk-btn" disabled title="${esc(s.blocked)}">Plugin</button>`;
    else if (s.installed) action = `<button class="sk-btn remove" data-act="remove" title="Remove it from your skills">Remove</button>`;
    else if (s.conflict) action = `<button class="sk-btn" disabled title="You already have a skill called ${esc(s.name)}">In use</button>`;
    else action = `<button class="sk-btn add" data-act="add" title="Add it to your skills (~/.claude/skills and ~/.agents/skills)">Add</button>`;
  } else if (s.paw) {
    action = busy ? `<button class="sk-btn" disabled>…</button>`
      : `<button class="sk-btn remove" data-act="remove" title="Added from the catalogue — remove it">Remove</button>`;
  }
  const details = open ? `<div class="sk-meta">
      ${s.source ? `<div class="sk-src">from ${esc(s.source)}</div>` : ""}
      ${s.blocked ? `<div class="sk-note">${esc(s.blocked)}</div>` : ""}
      ${s.paths.map((p) => `<a class="sk-path" data-reveal="${esc(p)}" title="Show in Finder">${esc(tildify(p))}</a>`).join("")}
    </div>` : "";
  return `<div class="sk-item${open ? " open" : ""}" data-key="${esc(key)}" data-scope="${scope}" data-name="${esc(s.name)}" data-path="${esc(s.paths[0] ?? "")}">
      <div class="sk-row"><span class="sk-name">${esc(s.name)}</span>${s.paw && scope !== "catalogue" ? `<span class="sk-tag added">added</span>` : ""}${tags}<span class="sk-grow"></span>${action}</div>
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
      <span class="sk-src-kind">${f.missing ? "gone" : f.found}</span>
      <a class="sk-src-name sk-path" data-reveal="${esc(f.path)}">${esc(tildify(f.path))}</a>
      <button class="sk-x" data-ext-remove="${esc(f.path)}" title="Stop using this folder's skills">×</button>
    </div>`).join("")}</div>`;
}

async function addExternalFolder(path) {
  try {
    const n = await invoke("skills_external_add", { path });
    skills.closed.delete("external");
    skillsMsg(`Added ${n} skill${n > 1 ? "s" : ""} from ${tildify(path)} — every session uses ${n > 1 ? "them" : "it"} from the next prompt.`);
  } catch (e) { skillsMsg(String(e), true); return; }
  await scanSkills();
  await applyExternalSkills();
}

function renderSkills() {
  const r = skills.report;
  const body = $("skills-body");
  if (!r) { body.innerHTML = `<div class="sk-empty">Looking for skills…</div>`; return; }
  const q = $("skills-filter").value.trim().toLowerCase();
  const match = (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || (s.source ?? "").toLowerCase().includes(q);
  const items = (list, scope) => list.filter(match).map((s) => skillItem(s, scope));
  const root = r.project_root;
  const projName = root ? root.split("/").filter(Boolean).pop() : null;
  const sources = r.sources.map((src) => `<div class="sk-source" title="${esc(src.location)}">
      <span class="sk-src-kind">${src.kind === "git" ? "git" : src.kind === "folder" ? "folder" : "found"}</span>
      <span class="sk-src-name">${esc(src.label)}</span>
      ${src.kind === "detected" ? "" : `<button class="sk-x" data-remove-source="${esc(src.id)}" title="Remove this catalogue">×</button>`}
    </div>`).join("");
  body.innerHTML =
    skillSection("project", projName ? `Project · ${projName}` : "Project", items(r.project, "project"),
      focusedS() ? `No skills in ${tildify(root ?? focusedS().cwd)}` : "Open a session to see its project's skills", "", root ? tildify(root) : "") +
    skillSection("user", "User", items(r.user, "user"), "No user skills") +
    skillSection("system", "System", items(r.system, "system"), "No system skills found") +
    skillSection("external", "External", items(r.external, "external"),
      r.external_folders.length ? "No skills match" : "Add a folder with skills — every session uses them where they are",
      externalFolders(r), "", `<button class="sk-sec-add" data-ext-add title="Add a folder with skills…">+</button>`) +
    skillSection("catalogue", "Catalogue", items(r.catalogue, "catalogue"),
      r.sources.length ? "No skills match" : "Add a folder or Git repository with +",
      sources ? `<div class="sk-sources">${sources}</div>` : "");
}

async function skillAction(act, name, path) {
  skills.busy.add(name);
  renderSkills();
  try {
    if (act === "add") {
      const added = await invoke("skills_install", { path });
      skillsMsg(`Added “${added}”. New sessions load it.`);
    } else {
      await invoke("skills_uninstall", { name });
      skillsMsg(`Removed “${name}”.`);
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
  skillsMsg(/^(https?:|git@|ssh:)/.test(location) ? "Cloning…" : "Adding…");
  try {
    const src = await invoke("skills_add_source", { location });
    $("skills-add-input").value = "";
    $("skills-add-row").classList.add("hidden");
    skills.closed.delete("catalogue");
    skillsMsg(`Added catalogue “${src.label}”.`);
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
      skillsMsg(`Stopped using ${tildify(extRm.dataset.extRemove)}.`);
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
      .then(() => { skillsMsg("Catalogue removed."); return scanSkills(); })
      .catch((err) => skillsMsg(String(err), true));
    return;
  }
  const item = e.target.closest(".sk-item");
  if (!item) return;
  const btn = e.target.closest("[data-act]");
  if (btn) { skillAction(btn.dataset.act, item.dataset.name, item.dataset.path); return; }
  if (String(window.getSelection())) return; // selecting text, not toggling
  const key = item.dataset.key;
  skills.expanded.has(key) ? skills.expanded.delete(key) : skills.expanded.add(key);
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
const mcp = { open: false, key: null, report: null, adding: null, busy: false, seq: 0 };
try { mcp.open = localStorage.getItem("paw.mcp") === "1"; } catch {}
const TRANSPORT_TAG = { stdio: "local", http: "HTTP", sse: "SSE" };

function setMcpOpen(open) {
  mcp.open = open;
  $("mcp-panel").classList.toggle("hidden", !open);
  $("mcp-resizer").classList.toggle("hidden", !open);
  $("mcp-toggle").classList.toggle("on", open);
  try { localStorage.setItem("paw.mcp", open ? "1" : "0"); } catch {}
  if (open) { mcp.key = null; syncMcp(); }
}

/** The focused tab changed (or its folder): show its agent's servers. */
function syncMcp() {
  if (!mcp.open) return;
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
    mcpMsg(`Couldn't read the MCP config: ${e}`, true);
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

const SCOPE_TAG = { user: "user", local: "this folder", project: "project" };

function mcpServerHtml(sc, s, showScope) {
  const target = s.transport === "stdio" ? [s.command, ...s.args].map(shq).join(" ") : s.url;
  const keys = [...s.env_keys.map((k) => `<span class="sk-tag" title="Environment variable (value not shown)">${esc(k)}</span>`),
    ...s.header_keys.map((k) => `<span class="sk-tag" title="Header (value not shown)">${esc(k)}:</span>`)].join("");
  return `<div class="mcp-srv${s.enabled ? "" : " off"}" data-scope="${esc(sc.id)}" data-name="${esc(s.name)}" title="${esc(tildify(sc.file))}">
      <div class="mcp-row"><span class="mcp-name">${esc(s.name)}</span><span class="sk-tag">${TRANSPORT_TAG[s.transport] ?? esc(s.transport)}</span>
        ${showScope ? `<span class="mcp-scope">${esc(SCOPE_TAG[sc.id] ?? sc.label)}</span>` : ""}
        ${s.pending ? `<span class="sk-tag pending" title="A project server nobody has approved yet: Claude Code doesn't start it. Switch it on to approve it for this folder.">needs approval</span>` : ""}<span class="mcp-grow"></span>
        ${sc.can_toggle ? `<label class="mcp-toggle" title="${s.pending ? "Switch on to approve it for this folder" : s.enabled ? "On — click to switch off" : "Off — click to switch on"}"><input type="checkbox" data-mcp-toggle ${s.enabled ? "checked" : ""}><span></span></label>` : ""}
        ${sc.writable ? `<button class="sk-x" data-mcp-remove title="Remove">×</button>` : ""}</div>
      <div class="mcp-cmd" title="${esc(target)}">${esc(target)}</div>
      ${keys ? `<div class="mcp-keys">${keys}</div>` : ""}
    </div>`;
}

function mcpFormHtml(writable) {
  const where = writable.length > 1
    ? `<select name="scope">${writable.map((sc) => `<option value="${esc(sc.id)}">${esc(sc.label)}</option>`).join("")}</select>` : "";
  return `<form class="mcp-form" data-scope="${esc(writable[0].id)}" data-t="stdio" autocomplete="off">
      <input name="name" placeholder="Name, e.g. filesystem" spellcheck="false" />
      ${where}
      <select name="transport">
        <option value="stdio">Local command (stdio)</option>
        <option value="http">Remote — streamable HTTP</option>
        <option value="sse">Remote — SSE</option>
      </select>
      <input name="command_line" class="f-stdio" placeholder="npx -y @modelcontextprotocol/server-filesystem ~/code" spellcheck="false" />
      <input name="url" class="f-remote" placeholder="https://example.com/mcp" spellcheck="false" />
      <textarea name="env" class="f-stdio" rows="2" placeholder="Environment, one per line: API_KEY=…" spellcheck="false"></textarea>
      <textarea name="headers" class="f-remote" rows="2" placeholder="Headers, one per line: Authorization: Bearer …" spellcheck="false"></textarea>
      <div class="skills-add-btns"><button type="button" data-mcp-cancel>Cancel</button><button type="submit" class="primary">Add</button></div>
    </form>`;
}

/** One list of every server the agent has, wherever it's configured. */
function renderMcp() {
  const body = $("mcp-body");
  const S = focusedS();
  $("mcp-sub").textContent = S ? `${S.agent.name} · ${tildify(S.cwd)}` : "";
  $("mcp-sub").title = S && isPaw(S.agent)
    ? "Paw Agent connects to these when a session starts. Tools a server marks read-only run without asking; the others follow the tab's approval level." : "";
  const r = S ? mcp.report : null;
  const writable = r?.supported ? r.scopes.filter((sc) => sc.writable) : [];
  $("mcp-add").classList.toggle("hidden", !writable.length);
  if (!S) { body.innerHTML = `<div class="mcp-note">Open a session to see its agent's MCP servers.</div>`; return; }
  if (!r) { body.innerHTML = `<div class="mcp-note">Reading…</div>`; return; }
  if (!r.supported) { body.innerHTML = `<div class="mcp-note">${esc(r.note)}</div>`; return; }
  const several = r.scopes.length > 1;
  const rows = r.scopes.flatMap((sc) => sc.servers.map((s) => mcpServerHtml(sc, s, several))).join("");
  const form = mcp.adding && writable.length ? mcpFormHtml(writable) : "";
  const notes = [...new Set(r.scopes.filter((sc) => sc.note).map((sc) => sc.note))];
  body.innerHTML = (form || rows ? `<div class="mcp-list">${form}${rows}</div>` : `<div class="mcp-note">No MCP servers yet.${writable.length ? " + adds one." : ""}</div>`) +
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
  sys(S, "MCP servers changed · conversation continues");
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

$("mcp-body").addEventListener("click", (e) => {
  if (e.target.closest("[data-mcp-cancel]")) { mcp.adding = null; renderMcp(); return; }
  const rm = e.target.closest("[data-mcp-remove]");
  if (rm) {
    const row = rm.closest(".mcp-srv");
    const sc = mcp.report?.scopes.find((x) => x.id === row.dataset.scope);
    if (!confirm(`Remove the MCP server “${row.dataset.name}” from ${sc?.label ?? row.dataset.scope}?\n${tildify(sc?.file ?? "")}`)) return;
    mcpChange(async (c) => { await invoke("mcp_remove", { ...c, scope: row.dataset.scope, name: row.dataset.name }); return row.dataset.scope; },
      `Removed ${row.dataset.name}`);
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
    }, `${row.dataset.name} ${t.checked ? "on" : "off"}`);
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
    `Added ${server.name.trim()}`);
});
$("mcp-toggle").onclick = () => setMcpOpen(!mcp.open);
$("mcp-close").onclick = () => setMcpOpen(false);
$("mcp-refresh").onclick = () => loadMcp();
$("mcp-add").onclick = () => { mcp.adding = !mcp.adding; renderMcp(); };
// At load only the visibility: the first renderSidebar() fills it in.
$("mcp-panel").classList.toggle("hidden", !mcp.open);
$("mcp-resizer").classList.toggle("hidden", !mcp.open);
$("mcp-toggle").classList.toggle("on", mcp.open);

// ---------- rendering: terminal output ----------
// Bottom-anchored: new lines appear right above the prompt and push older ones up.
function renderOutput() {
  const S = curS();
  const out = $("output");
  out.innerHTML = "";
  if (!S) return;
  for (const l of S.lines) place(out, renderLine(S, l));
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
  const failed = g.querySelectorAll(":scope > .tg-body > .t-result.bad").length;
  const counts = new Map();
  for (const st of steps) counts.set(st.dataset.tool, (counts.get(st.dataset.tool) ?? 0) + 1);
  const kinds = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" · ");
  const n = steps.length;
  const last = steps.at(-1)?.dataset.arg ?? "";
  const sum = g.querySelector(":scope > summary");
  const set = (sel, text) => { const el = sum.querySelector(sel); if (el.textContent !== text) el.textContent = text; };
  set(".tg-count", n ? `${n} action${n === 1 ? "" : "s"}` : "Thinking");
  set(".tg-kinds", kinds ? ` · ${kinds}` : "");
  set(".tg-failed", failed ? ` · ${failed} failed` : "");
  set(".tg-last", last && !g.classList.contains("closed") ? ` — ${last.slice(0, 80)}` : "");
}

// Pressing a fold header toggles it. It doesn't start a text selection (so
// WebKit doesn't search the transcript for a caret position) and the prompt
// keeps the keyboard focus.
document.addEventListener("mousedown", (e) => {
  if (e.button === 0 && e.target.closest?.(".output summary")) e.preventDefault();
}, true);

/** Append rendered line(s), folding work steps into the open group. */
function place(out, el) {
  if (!el) return;
  const nodes = el.nodeType === 11 ? [...el.childNodes] : [el];
  for (const node of nodes) {
    if (isStep(node)) {
      const g = openGroup(out);
      g.querySelector(":scope > .tg-body").appendChild(node);
      summarizeGroup(g);
    } else {
      const last = out.lastElementChild;
      if (last?.classList.contains("tool-group") && !last.classList.contains("closed")) {
        last.classList.add("closed");
        summarizeGroup(last);
      }
      out.appendChild(node);
    }
  }
}

function appendLines(S, lines) {
  const out = $("output");
  const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 120;
  out.querySelector(".partial-line")?.remove();
  for (const l of lines) place(out, renderLine(S, l));
  const extra = out.childElementCount - MAX_SCREEN_LINES;
  for (let i = 0; i < extra; i++) out.firstElementChild?.remove();
  if (S.partial) renderPartial(S);
  if (stick) out.scrollTop = out.scrollHeight;
}

function appendLine(S, line) {
  const out = $("output");
  const stick = line.stream === "stdin" || out.scrollHeight - out.scrollTop - out.clientHeight < 120;
  out.querySelector(".partial-line")?.remove();
  place(out, renderLine(S, line));
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
  const text = body || "";
  d.addEventListener("toggle", () => { d.lastElementChild.textContent = d.open ? text : ""; });
  return d;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.url ||
    input.description || input.prompt || JSON.stringify(input);
  return String(v).split("\n")[0].slice(0, 120);
}

function renderLine(S, l) {
  if (l.stream === "info") return div("tl info", l.html);
  if (l.stream === "approval") return renderApprovalCard(S, l);
  if (l.stream === "system") return div("tl sys", esc(l.text));
  if (l.stream === "cmd") return div("tl input shcmd", `<span class="sh">$</span> ${esc(l.text)}`);
  if (l.stream === "shell") return div("tl out", ansi(l.text) || "&nbsp;");
  if (l.stream === "shellexit") return div("tl shexit", l.code === 130 ? "^C" : `exit ${l.code}`);
  if (l.stream === "shared") return div("tl sys shared-note", `↳ output shared with ${esc(S.agent.name)}`);
  if (l.stream === "stdin") {
    let text = l.text;
    if (text.startsWith("{")) {
      try {
        const content = JSON.parse(text).message.content;
        text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const n = content.filter((c) => c.type === "image").length;
        if (n) text += `  [${n} image${n > 1 ? "s" : ""}]`;
      } catch {}
    }
    const el = div("tl input", `<span class="g">❯</span> ${esc(text)}`);
    if (l.attachments?.length || l.shared || l.skills) {
      const row = div("att-row");
      if (l.skills) row.appendChild(div("att-chip echo ctx-chip", `<span class="att-icon">✦</span><span class="att-name">shared ${l.skills} external skill${l.skills > 1 ? "s" : ""}</span>`));
      if (l.shared) row.appendChild(div("att-chip echo ctx-chip", `<span class="att-icon">$</span><span class="att-name">shared ${l.shared} shell output${l.shared > 1 ? "s" : ""}</span>`));
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
  if (l.stream === "stdout" && l.text.startsWith("{")) {
    let ev;
    try { ev = JSON.parse(l.text); } catch { ev = null; }
    if (ev && typeof ev.type === "string") {
      const r = renderClaudeEvent(ev);
      if (r !== undefined) return r;
    }
    // An event cut short by an older save: a collapsed step, not a wall of JSON.
    if (!ev && /^\{"type":"(user|assistant)"/.test(l.text)) {
      return fold("t-result", `<span class="elbow">⎿</span> <span class="dim">(long output — trimmed when it was saved)</span>`, l.text);
    }
  }
  return div("tl " + (l.stream === "stderr" ? "err" : "out"), ansi(l.text) || "&nbsp;");
}

/** Render Claude Code `stream-json` events. Return undefined to fall back to raw. */
function renderClaudeEvent(ev) {
  if (ev.type === "system") {
    if (ev.subtype === "init") return div("tl sys", esc(`session ${ev.session_id?.slice(0, 8) ?? ""} · ${ev.model ?? ""}`));
    return null;
  }
  if (ev.type === "assistant" && ev.message?.content) {
    const frag = document.createDocumentFragment();
    for (const c of ev.message.content) {
      if (c.type === "text" && c.text?.trim()) {
        frag.appendChild(div("tl say md-msg", `<span class="b">⏺</span><div class="md">${renderMarkdown(c.text.trim())}</div>`));
      } else if (c.type === "thinking" && c.thinking?.trim()) {
        frag.appendChild(fold("t-think", `<span class="b">✻</span> Thinking…`, c.thinking));
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
      const more = lines.length > 1 ? ` <span class="dim">(+${lines.length - 1} lines)</span>` : "";
      frag.appendChild(fold("t-result" + (c.is_error ? " bad" : ""),
        `<span class="elbow">⎿</span> ${esc((lines[0] ?? "(no output)").slice(0, 160))}${more}`, body));
    }
    return frag.childNodes.length ? frag : null;
  }
  if (ev.type === "result") {
    const bits = [
      ev.num_turns != null ? `${ev.num_turns} turn${ev.num_turns === 1 ? "" : "s"}` : "",
      ev.duration_ms != null ? `${(ev.duration_ms / 1000).toFixed(1)}s` : "",
      ev.total_cost_usd != null ? `$${ev.total_cost_usd.toFixed(4)}` : "",
    ].filter(Boolean).join(" · ");
    const head = ev.stopped ? "■ Stopped" : ev.is_error ? "✗ Failed" : "✓ Done";
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
function renderBusy() {
  const S = curS();
  const busy = !!S && isBusy(S) && !S.raw;
  $("busy").classList.toggle("hidden", !busy);
  if (!busy) return;
  $("busy-spin").textContent = SPIN[spinFrame % SPIN.length];
  $("busy-text").textContent = S.shellBusy ? `Running ${S.shellCmd}…` : S.waitingApproval ? "Waiting for your approval…"
    : S.mode === "claude" ? "Working…" : "Running…";
  $("busy-time").textContent = fmtElapsed(Date.now() - ((S.shellBusy ? S.shellSince : S.busySince) ?? Date.now()));
}
setInterval(() => { spinFrame++; for (const P of panes.values()) withPane(P, renderBusy); }, 90);

// ---------- sessions: same rules for every agent ----------
// A new tab has no session (brand-new conversation). Follow-up prompts and
// restarts continue it: through the agent's own sessions ("session"), or by
// Paw sending the earlier turns along ("replay").
function captureSession(S, l) {
  if (l.stream !== "stdout" && l.stream !== "stderr") return;
  S.runLines?.push(l.text);
  if (l.stream === "stdout" && S.mode === "oneshot") S.runOut?.push(PawThemes.stripAnsi(l.text));
  const pat = S.agent.continuity === "session" && S.agent.session_pattern;
  if (pat) {
    try {
      const m = PawThemes.stripAnsi(l.text).match(new RegExp(pat));
      if (m?.[1] && m[1] !== S.session) { S.session = m[1]; saveWorkspaceSoon(); }
      if (m?.[1]) S.resuming = false;
    } catch { /* bad pattern in settings */ }
  }
  const turn = S.turns?.at(-1);
  if (S.agent.continuity === "replay" && turn?.open && l.stream === "stdout") {
    turn.assistant += PawThemes.stripAnsi(l.text) + "\n";
  }
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
  if (l.stream === "stdin") return; // echoed locally by sendToAgent
  if (l.stream === "system" && S.quietProcs?.has(l.id)) return; // approval restarts are silent
  // One-shot runs end every prompt; a clean exit is not news.
  if (S.mode === "oneshot" && l.stream === "system" && l.text === "Process exited with code 0") return;
  captureSession(S, l);
  if (S.mode === "claude" && l.stream === "stdout") logAgentCommands(S, l.text);
  if (S.mode === "claude" && l.stream === "stdout" && l.text.startsWith('{"type":"assistant"')) noteAnswer(S, l.text);
  let ended = null; // a finished turn, for tasks
  if (S.mode === "claude" && l.stream === "stdout" && l.text.includes('"type":"result"')) {
    try {
      const ev = JSON.parse(l.text);
      if (ev.type === "result") {
        const text = typeof ev.result === "string" && ev.result ? ev.result : S.lastAnswer ?? "";
        ended = { ok: !ev.is_error, stopped: !!ev.stopped, text,
          error: ev.is_error ? text || `${S.agent.name} reported an error (${ev.subtype ?? "unknown"}). Its tab has the details.` : null };
        S.busy = false;
        if (isPaw(S.agent)) { expirePawCards(S); S.partial = null; inPane(S, () => renderPartial(S)); }
        refresh(S);
        setTimeout(() => { reloadNativeSkills(S); reloadForMcp(S); }, 0);
      }
    } catch {}
  }
  // A task tab shows the plan as a graph: the planner's JSON would only repeat it.
  if (S.task && S.mode === "claude" && l.stream === "stdout" && l.text.startsWith('{"type":"assistant"') && l.text.includes("```")) l = { ...l, text: foldPlanJson(l.text) };
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
        error: ok ? null : PawThemes.stripAnsi((S.runLines ?? []).slice(-20).join("\n")) || `exited with code ${pinfo.exit_code}` };
    } else if (wasBusy) {
      ended = { ok: false, stopped: pinfo.status === "stopped", text: S.lastAnswer ?? "", error: `${S.agent.name} stopped before it finished.` };
    }
  }
  if (pinfo.status !== "running" && resumeRejected(S, pinfo)) {
    S.resuming = false;
    S.session = null;
    S.runWithSession = false;
    sys(S, `couldn't continue the previous ${S.agent.name} session — starting a new one`);
    if (S.mode === "oneshot") startProc(S, S.lastPrompt);
    else startProc(S);
    return;
  }
  refresh(S);
  if (ended) taskTurnEnded(S, ended);
});

listen("settings:changed", ({ payload }) => {
  settings = payload;
  applyCurrentTheme();
  if (activeId == null) renderWelcome();
});
listen("agents:detected", ({ payload }) => {
  detections = payload;
  detectionsReady = true;
  if (activeId == null) renderWelcome();
});

// ---------- prompt line ----------
function autosize() {
  const ta = $("input");
  if (!ta) return;
  // Empty: natural one-line height (measuring before layout made it 3 lines tall).
  if (!ta.value || !ta.clientWidth) { ta.style.height = ""; return; }
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
}
function updateGlyph() {
  const S = curS();
  const g = $("prompt-glyph");
  const shell = S?.shellBusy || routeFor(S, $("input").value).shell;
  g.textContent = S?.shellBusy ? "›" : shell ? "$" : "❯";
  g.classList.toggle("sh", !!shell);
  g.title = S?.shellBusy ? "Input goes to the running command" : shell ? "Runs in the shell" : "Goes to the agent";
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
  await newSession(S?.agent.id, { cwd: S?.cwd });
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
  withPane(P, () => {
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
            sys(S, `✗ couldn't attach the pasted image: ${err}`);
          }
        };
        reader.readAsDataURL(file);
      }
    });
    $("input").addEventListener("input", () => { autosize(); updateGlyph(); scheduleAutocomplete(); scheduleLookup(); });
    $("input").addEventListener("blur", () => setTimeout(closeAc, 120));
    $("input").addEventListener("keydown", (e) => {
      const ta = e.target;
      const S = curS();
      if (!e.isComposing && autocompleteKey(e)) return;
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
      // Ctrl-C with nothing selected interrupts, like a terminal.
      if (e.ctrlKey && e.key === "c" && S && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        interrupt(S);
      }
    });
    $("terminal").addEventListener("mouseup", (e) => {
      if (e.target.closest("summary, button, a, textarea")) return;
      if (!String(window.getSelection())) $("input").focus();
    });

    $("mode-pill").onclick = () => { const S = curS(); if (S) { cycleInputMode(S); $("input").focus(); } };
    $("prompt-glyph").onclick = () => $("mode-pill").click();
    $("eof").onclick = () => { const S = curS(); if (S && isRunning(S)) invoke("close_input", { id: S.proc }); };
  });
}

// ---------- new-session menu & welcome ----------
function agentAvatar(a) {
  const ini = (a.name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<span class="mini-avatar">${esc(ini || "?")}</span>`;
}

function openMenu() {
  const menu = $("menu");
  const list = availableAgents();
  const def = defaultAgent();
  menu.innerHTML = "";
  if (!list.length) menu.appendChild(div("menu-empty", detectionsReady ? "No agents available" : "Detecting agents…"));
  for (const [i, a] of list.entries()) {
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
  if (list.some((a) => sessionMode(a) !== "stdin")) {
    const tk = document.createElement("button");
    tk.className = "menu-item";
    tk.innerHTML = `<span class="mini-avatar ghost">◇</span><span class="mi-name">New task…</span><span class="mi-sub">plan, then run</span>`;
    tk.onclick = () => { closeMenu(); const S = focusedS(); newTask({ cwd: S?.cwd }); };
    menu.appendChild(tk);
  }
  const s = document.createElement("button");
  s.className = "menu-item";
  s.innerHTML = `<span class="mini-avatar ghost">⚙</span><span class="mi-name">Manage Agents…</span>`;
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

function renderWelcome() {
  const box = $("welcome-agents");
  box.innerHTML = "";
  const list = availableAgents();
  if (!list.length) {
    box.appendChild(div("welcome-empty", detectionsReady
      ? `No agents found. <a id="w-settings">Open Settings</a> to add one.`
      : "Detecting installed agents…"));
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
  $("sidebar-toggle").title = visible ? "Hide sidebar (⌃⌘S)" : "Show sidebar (⌃⌘S)";
  $("sidebar-toggle").classList.toggle("on", visible);
  try { localStorage.setItem("paw.sidebar", visible ? "1" : "0"); } catch {}
}
const sidebarVisible = () => !document.querySelector(".app").classList.contains("sidebar-hidden");
const toggleSidebar = () => setSidebar(!sidebarVisible());
$("sidebar-toggle").onclick = toggleSidebar;
// ⌃⌘S is a menu accelerator (View › Toggle Sidebar); the menu forwards it here.
listen("ui:toggle-sidebar", toggleSidebar);
try { setSidebar(localStorage.getItem("paw.sidebar") !== "0", false); } catch { setSidebar(true, false); }

// ---------- side panels give way to the prompt ----------
// Clicking into the prompt box, or typing in it, closes the sidebar and the
// MCP panel. Only the user's own click or keystroke counts: Paw moves focus to
// the prompt by itself all the time, and that must not close anything.
function closeSidePanels() {
  if (sidebarVisible()) setSidebar(false);
  if (mcp.open) setMcpOpen(false);
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

// ---------- MCP panel width ----------
// Its left edge drags like the sidebar's; never wider than half the window.
const MCP_W = { min: 240, max: 640, normal: 300 };
function setMcpWidth(w, save = true) {
  const max = Math.min(MCP_W.max, Math.floor(window.innerWidth / 2));
  const px = Math.round(Math.min(max, Math.max(MCP_W.min, w)));
  document.querySelector(".app").style.setProperty("--mcp-w", px + "px");
  if (save) try { localStorage.setItem("paw.mcpWidth", String(px)); } catch {}
  return px;
}
try { const w = Number(localStorage.getItem("paw.mcpWidth")); if (w) setMcpWidth(w, false); } catch {}
makeResizer(
  $("mcp-resizer"),
  (x) => $("mcp-panel").getBoundingClientRect().right - x,
  setMcpWidth,
  () => setMcpWidth(MCP_W.normal),
);

$("tab-add").onclick = () => newSession();
$("settings-btn").onclick = () => invoke("open_preferences", {});

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
  if (!e.metaKey) return;
  if (e.ctrlKey && (e.key === "m" || e.key === "M")) { e.preventDefault(); setMcpOpen(!mcp.open); return; }
  const S = curS();
  if (e.altKey && e.key.startsWith("Arrow")) { e.preventDefault(); focusNeighbour(e.key); return; }
  if (e.key === ",") { e.preventDefault(); invoke("open_preferences", {}); }
  else if (e.key === "d" || e.key === "D") { e.preventDefault(); splitPane(e.shiftKey ? "column" : "row"); }
  else if (e.key === "t" || e.key === "n") { e.preventDefault(); e.shiftKey ? openMenu() : newSession(); }
  else if (e.key === "w" && S) { e.preventDefault(); closeSession(S.sid); }
  else if (e.key === "k" && S) { e.preventDefault(); S.lines = []; renderOutput(); }
  else if (e.key === "." && S) { e.preventDefault(); interrupt(S); }
  else if (/^[1-9]$/.test(e.key)) {
    const sid = openTabs[Number(e.key) - 1];
    if (sid != null) { e.preventDefault(); select(sid); }
  } else if (e.shiftKey && "[]{}".includes(e.key) && openTabs.length) {
    e.preventDefault();
    const i = openTabs.indexOf(activeId);
    const d = e.key === "]" || e.key === "}" ? 1 : -1;
    select(openTabs[(i + d + openTabs.length) % openTabs.length]);
  }
});

// Tick the sidebar/tabs while something is running (elapsed timers, dots).
setInterval(() => {
  if ([...sessions.values()].some(isBusy)) renderSidebar();
}, 1000);

// ---------- boot ----------
function waitForDetections(timeoutMs) {
  if (detectionsReady) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    listen("agents:detected", () => { clearTimeout(t); resolve(); });
  });
}

(async () => {
  homeDir = await invoke("home_dir");
  settings = await invoke("get_settings");
  const first = createPane();
  layout = { type: "pane", pane: first };
  focusedPane = activePane = first;
  first.root.classList.add("focused");
  renderLayout();
  applyCurrentTheme();
  detections = await invoke("get_detections", { rescan: false });
  detectionsReady = Object.keys(detections).length > 0;
  invoke("history_list").then((list) => { shellHistory = list; });
  invoke("shell_commands").then((list) => { shellCommands = new Set(list); for (const P of panes.values()) withPane(P, updateGlyph); });

  // Re-attach to processes that survived a webview reload.
  for (const pinfo of await invoke("list_agents")) {
    if (pinfo.status !== "running") continue;
    const agent = settings.agents.find((a) =>
      (detections[a.id]?.path && pinfo.command.startsWith(detections[a.id].path)) || pinfo.command.startsWith(a.binary + " "))
      ?? { id: "restored", name: pinfo.name, binary: "", template: "", io: "text", custom_models: [] };
    const S = {
      sid: nextSid++, agent, mode: sessionMode(agent), cwd: pinfo.cwd, model: "", approval: defaultApproval(agent),
      proc: pinfo.id, info: pinfo, lines: await invoke("agent_output", { id: pinfo.id }),
      busy: false, history: [], histIdx: 0, draft: "", unread: 0, inputMode: settings.general.input_mode || "auto",
    };
    sessions.set(S.sid, S);
    procToSid.set(pinfo.id, S.sid);
    openTabs.push(S.sid);
    openShell(S);
  }
  if (openTabs.length) { wsReady = true; select(openTabs[0]); return; }

  // Bring back last run's tabs (Claude conversations resume).
  const restored = await restoreWorkspace();
  wsReady = true;
  if (restored) { saveWorkspaceSoon(); return; }

  // Like a terminal: open a tab with the default agent on launch.
  select(null);
  await waitForDetections(15000);
  if (!sessions.size && defaultAgent()) newSession();
  else renderWelcome();
})();

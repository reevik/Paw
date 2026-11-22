// Factories: pipelines of agent nodes described in YAML files
// (~/.paw/factories/<id>.yaml), run by Paw's background process, so they keep
// going while the window is closed (src-tauri/src/factories/runner.rs).
//
// A factory tab looks like a task tab: the factory's graph on top (click a
// node for its task, settings and last run beside it), and below, Paw Agent,
// who can change the factory file for you. Run a task starts a run in the
// background; every change to a run comes back as a `factory:run` event.
//
// Loaded before app.js; everything here only runs when app.js calls it.

const factoryState = { dir: "", list: [], runs: new Map(), loaded: false, loading: null, triggers: { factories: {} } };

const RUN_STATE_TEXT = { running: tx("running"), done: tx("done"), failed: tx("failed"), stopped: tx("stopped") };

/** The factory files and their runs, from the background process. */
function loadFactories() {
  factoryState.loading ??= invoke("factory_list", { model: defaultPawModel() || null })
    .then((r) => {
      factoryState.dir = r.dir ?? "";
      factoryState.list = r.factories ?? [];
      if (r.triggers) factoryState.triggers = r.triggers;
      for (const run of r.runs ?? []) {
        // Lists come without the nodes' logs: keep the ones we have.
        const old = factoryState.runs.get(run.id);
        if (old) run.nodes.forEach((n, i) => { if (!n.log?.length && old.nodes[i]?.id === n.id) n.log = old.nodes[i].log; });
        factoryState.runs.set(run.id, run);
      }
      factoryState.loaded = true;
    })
    .catch((e) => { factoryState.error = String(e); })
    .finally(() => { factoryState.loading = null; renderFactoryTabs(); });
  return factoryState.loading;
}

function initFactories() {
  listen("factory:run", ({ payload }) => {
    const run = payload?.run;
    if (!run?.id) return;
    const before = factoryState.runs.get(run.id);
    factoryState.runs.set(run.id, run);
    renderFactoryTabs();
    // The node tabs of this run: a new question shows in the conversation too.
    for (const T of sessions.values()) {
      if (T.nodeOf?.run !== run.id) continue;
      const r = run.nodes.find((n) => n.id === T.nodeOf.node);
      const was = before?.nodes.find((n) => n.id === T.nodeOf.node);
      if (r?.question && r.question.request !== was?.question?.request) {
        sys(T, `? ${r.question.question}${r.question.choices?.length ? `  (${r.question.choices.join(" · ")})` : ""}`);
      }
      refresh(T);
    }
  });
  listen("factory:triggers", ({ payload }) => {
    if (!payload?.triggers) return;
    factoryState.triggers = payload.triggers;
    renderFactoryTabs();
  });
  // Countdowns to the next scheduled run.
  setInterval(() => { if (curS()?.factory && Object.keys(factoryState.triggers.factories ?? {}).length) renderFactoryTabs(); }, 15000);
  // Factory files change outside Paw too (an editor, an agent): look again.
  window.addEventListener("focus", () => loadFactories());
  $("factories-add")?.addEventListener("click", (e) => { e.stopPropagation(); askFactoryName(); });
  loadFactories();
}

// ---------- the sidebar's Factories section ----------
const triggerOf = (id) => factoryState.triggers.factories?.[id] ?? null;
const TRIGGER_WORD = { watch: tx("Watching"), every: tx("Scheduled"), at: tx("Scheduled"), webhook: tx("Webhook"), file: tx("Watching files"), repeat: tx("Repeating") };

function factoryStatus(id) {
  const f = factoryById(id);
  const run = runsOf(id)[0];
  const t = triggerOf(id);
  const going = runsOf(id).filter((r) => r.state === "running");
  if (f?.error) return tx("Can't be read · fix the file");
  if (going.length > 1) return tx("{n} runs going", { n: going.length });
  if (going.length) return tx("Running · {progress}", { progress: runProgress(going[0]) });
  const trig = t ? (t.paused ? tx("Paused") : TRIGGER_WORD[t.kinds[0]] ?? tx("Armed")) : "";
  const last = run ? tx("{state} {when}", { state: RUN_STATE_TEXT[run.state] ?? run.state, when: fmtWhen(run.started_at) }) : f ? tx("never run") : "";
  return [trig, last].filter(Boolean).join(" · ");
}

/** "in 12m", "in 3h 5m". */
function fmtIn(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 1) return tx("in under a minute");
  if (m < 60) return tx("in {m}m", { m });
  return m % 60 ? tx("in {h}h {m}m", { h: Math.floor(m / 60), m: m % 60 }) : tx("in {h}h", { h: Math.floor(m / 60) });
}

/** The trigger part of a factory's summary: what starts it, and how it's doing. */
function repeatText(r) {
  if (!r) return "";
  const o = typeof r === "object" ? r : {};
  const goOn = o.on_failure === "continue";
  if (o.after) return goOn ? tx("Starts again {after} after a run finishes, even a failed one", { after: esc(o.after) })
    : tx("Starts again {after} after a run finishes; a failed run stops the loop", { after: esc(o.after) });
  return goOn ? tx("Starts again when a run finishes, even a failed one") : tx("Starts again when a run finishes; a failed run stops the loop");
}

function triggerHtml(id, def) {
  const t = def.trigger ?? {};
  const rep = def.repeat && def.repeat !== false ? repeatText(def.repeat) : "";
  if (!def.trigger && !rep) return `<label class="tk-lbl">${tx("Trigger")}</label><div class="tk-dim">${tx("Manual: Run a task. Add a trigger to the file (every, at, watch, webhook or file) to start runs on their own, or repeat: true to loop.")}</div>`;
  const st = triggerOf(id);
  const rows = [];
  if (t.watch) rows.push(tx("When <code>{cmd}</code> starts succeeding (checked every {every})", { cmd: esc(t.watch), every: esc(t.every) }));
  else if (t.every) rows.push(tx("Every {every}", { every: esc(t.every) }));
  if (t.at) rows.push(tx("At {at}", { at: esc(t.at) }));
  if (t.file) rows.push(tx("When {file} changes", { file: esc(st?.watching_file ? tildify(st.watching_file) : t.file) }));
  if (t.webhook !== undefined && t.webhook !== false && t.webhook !== null) rows.push(tx("When its webhook is called"));
  if (rep) rows.push(rep);
  const parts = [`<label class="tk-lbl">${tx("Trigger")}${st?.paused ? ` <span class="fa-paused">${tx("paused")}</span>` : ""}</label><div>${rows.join("<br>")}</div>`];
  // How many runs it may have going at once (the file's parallel), and the ones waiting.
  const par = st?.parallel ?? def.parallel ?? 1;
  if (st?.waiting) {
    const queued = par === 1 ? tx("<b>{n} queued</b> · runs of this factory go one at a time", { n: st.waiting })
      : tx("<b>{n} queued</b> · runs of this factory go {par} at a time", { n: st.waiting, par });
    parts.push(`<div class="fa-waiting"><div>${queued}</div>
      <button class="tk-btn primary" data-fact="par-up" title="${esc(tx("Let one more run go at the same time"))}">${tx("Allow {n} at once", { n: par + 1 })}</button></div>`);
  }
  const edits = def.nodes.some((n) => !n.wait && n.edits !== false);
  parts.push(`<div class="fa-par"><span class="tk-dim">${tx("Runs at once")}</span>
    <button class="fa-zb" data-fact="par-down" title="${esc(tx("Fewer runs at the same time"))}"${par <= 1 ? " disabled" : ""}>−</button><b>${par}</b><button class="fa-zb" data-fact="par-up" title="${esc(tx("More runs at the same time"))}"${par >= 20 ? " disabled" : ""}>+</button></div>`);
  if (par > 1 && edits) parts.push(`<div class="tk-dim">${tx("These runs share {folder} unless they're started in another folder: they take turns changing files there, but they'd also switch its git branch under each other.", { folder: esc(def.folder?.trim() || "~") })}</div>`);
  if (!st) {
    parts.push(`<div class="tk-dim">${tx("Paw's background process hasn't picked this up yet.")}</div>`);
    return parts.join("");
  }
  const bits = [];
  if (st.next && !st.paused && !t.watch) bits.push(tx("Next run {in} ({when})", { in: fmtIn(st.next), when: fmtWhen(st.next) }));
  if (st.last_check) bits.push(tx("Last check {when}: {result}", { when: fmtWhen(st.last_check.at), result: st.last_check.ok ? tx("succeeded") : tx("not yet") }));
  if (st.last_fired) bits.push(`${fmtWhen(st.last_fired)}: ${st.last_note}`);
  if (bits.length) parts.push(`<div class="tk-dim">${bits.map(esc).join("<br>")}</div>`);
  if (st.last_check?.output?.trim() && !st.last_check.ok) parts.push(`<details class="tk-fold"><summary>${tx("Check output")}</summary><div class="tk-pre">${esc(st.last_check.output.trim())}</div></details>`);
  if (st.webhook) {
    const token = st.webhook_secret ? ` -H "X-Paw-Token: <secret>"` : "";
    const hookNote = st.webhook_secret ? tx("The body goes to the nodes as the trigger's payload. The secret from the file has to come along (X-Paw-Token, or ?token=).")
      : tx("The body goes to the nodes as the trigger's payload. Anything on this Mac can call it; give the webhook a secret to require one.");
    parts.push(`<div class="fa-hook"><div class="tk-dim">${tx("POST to")}</div><div class="tk-pre">${esc(st.webhook)}</div><div class="tk-dim">${tx("for example")}</div><div class="tk-pre">curl -X POST${esc(token)} -d @alert.json ${esc(st.webhook)}</div><div class="tk-dim">${hookNote}</div></div>`);
    if (factoryState.triggers.server_error) parts.push(`<div class="tk-warn">${esc(factoryState.triggers.server_error)}</div>`);
  }
  return parts.join("");
}

function renderFactoryNav() {
  const body = $("factories-body");
  if (!body) return;
  const list = factoryState.list;
  const count = $("factories-count");
  if (count) count.textContent = list.length || "";
  if (!list.length) {
    body.innerHTML = `<div class="sk-empty">${factoryState.loaded ? tx("No factories yet. + makes one.") : "…"}</div>`;
    return;
  }
  const open = new Set([...sessions.values()].filter((S) => S.factory && S.sid === activeId).map((S) => S.factory.id));
  // The filter, and pinned ones first.
  const q = navFilter("factories");
  const shown = list.filter((f) => navMatches(q, f.factory?.name, f.id, f.factory?.description, factoryStatus(f.id)));
  if (!shown.length) { body.innerHTML = `<div class="sk-empty">${tx("No factories match.")}</div>`; return; }
  const pinned = shown.filter((f) => isPinned("factories", f.id));
  const rest = shown.filter((f) => !isPinned("factories", f.id));
  const row = (f) => {
    const run = runsOf(f.id)[0];
    const going = runsOf(f.id).filter((r) => r.state === "running");
    const dot = f.error ? "failed" : going.length ? "running" : run?.state === "failed" ? "failed" : "idle";
    const needs = going.reduce((n, r) => n + r.nodes.filter((x) => x.state === "needs").length, 0);
    return `<div class="nav-item${open.has(f.id) ? " active" : ""}" data-factory="${esc(f.id)}" title="${esc(f.factory?.description || tildify(f.path))}">
      <span class="dot ${dot}"></span>
      <span class="nav-text"><span class="nav-name">${esc(f.factory?.name || f.id)}</span><span class="nav-status">${esc(factoryStatus(f.id))}</span></span>
      ${needs ? `<span class="tab-badge">${needs}</span>` : ""}${pinButton("factories", f.id)}</div>`;
  };
  body.innerHTML = (pinned.length ? `<div class="nav-pinned">${pinnedHead()}${pinned.map(row).join("")}</div>` : "") + rest.map(row).join("");
}

document.addEventListener("click", (e) => {
  const row = e.target.closest?.("#factories-body [data-factory]");
  if (row) openFactory(row.dataset.factory);
});

// Right-click a factory in the sidebar.
document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest?.("#factories-body [data-factory]");
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  const id = row.dataset.factory;
  contextMenu(e.clientX, e.clientY, [
    { label: tx("Open"), run: () => openFactory(id) },
    { label: isPinned("factories", id) ? tx("Unpin") : tx("Pin to the top"), run: () => togglePin("factories", id) },
    "-",
    { label: tx("Delete factory…"), run: () => deleteFactory(id) },
  ]);
}, true);

/** Delete a factory, after asking: its runs stop, its trigger stops listening,
 *  its file and run history go to the Trash, and its tabs close. */
async function deleteFactory(id) {
  if (!factoryState.loaded) await loadFactories();
  const f = factoryById(id);
  if (!f) return false;
  const name = f.factory?.name || id;
  const going = runsOf(id).filter((r) => r.state === "running").length;
  const detail = (going === 1 ? tx("Its run that's going stops. ") : going > 1 ? tx("Its {n} runs that are going stop. ", { n: going }) : "") +
    tx("Its file and its run history go to the Trash, where you can put them back.");
  // Asked in the tab you're in (not the factory's own, which closes).
  if (!await askSure(tx("Delete the factory “{name}”?", { name }), { yes: tx("Delete"), detail })) return false;
  try {
    await invoke("factory_delete", { factory: id });
  } catch (e) {
    const S = curS();
    if (S) sys(S, `✗ ${e}`);
    return false;
  }
  for (const [rid, r] of factoryState.runs) if (r.factory === id) factoryState.runs.delete(rid);
  // Its tabs: the factory's own and its nodes'.
  for (const S of [...sessions.values()]) if (S.factory?.id === id || S.nodeOf?.factory === id) await closeSession(S.sid);
  // What was allowed for it, and its pin: a new factory may get the same id.
  const rules = settings.allow_rules ?? [];
  if (rules.some((r) => r.agent === `factory:${id}`)) {
    settings.allow_rules = rules.filter((r) => r.agent !== `factory:${id}`);
    await invoke("save_settings", { settings }).catch(() => {});
  }
  if (isPinned("factories", id)) togglePin("factories", id);
  await loadFactories();
  const S = curS();
  if (S && !S.factory) sys(S, tx("— factory {name} deleted: its file and run history are in the Trash.", { name }));
  return true;
}

/** + in the sidebar: name the new factory in place. */
function askFactoryName() {
  const body = $("factories-body");
  if (!body) return;
  body.querySelector(".sk-empty")?.remove();
  const row = document.createElement("div");
  row.className = "nav-item";
  const name = document.createElement("span");
  row.appendChild(name);
  body.prepend(row);
  editInPlace(name, "", (text) => {
    row.remove();
    if (text) newFactory(text);
    else renderFactoryNav();
  });
}

function renderFactoryTabs() {
  renderFactoryNav();
  renderTabs();
  for (const P of panes.values()) {
    const S = sessions.get(P.sid);
    if (S?.factory) withPane(P, renderTaskView);
  }
}

const factoryById = (id) => factoryState.list.find((f) => f.id === id);
const runsOf = (id) => [...factoryState.runs.values()].filter((r) => r.factory === id).sort((a, b) => b.started_at - a.started_at);
/** A run's execution id, short: its UUID's first part. */
const shortRunId = (id) => String(id ?? "").split("-")[0];
/** The project folder a run works in. */
const runFolder = (r) => r?.folder || r?.def?.folder?.trim() || "~";
/** The folder a run works in, as a full path (like a tab's folder). */
const runFolderAbs = (r) => {
  const f = runFolder(r).replace(/\/+$/, "");
  return f === "~" ? homeDir : f.startsWith("~/") ? homeDir + f.slice(1) : f;
};

/** Keep an "always" decision for a factory in a folder (Settings lists it with Paw Agent's). */
async function saveFactoryRule(factory, folder, rule, label) {
  const agent = `factory:${factory}`;
  settings.allow_rules ??= [];
  if (settings.allow_rules.some((x) => x.agent === agent && x.folder === folder && x.rule === rule)) return;
  settings.allow_rules.push({ agent, folder, rule, label: label || rule });
  await invoke("save_settings", { settings }).catch(() => {});
}
const lastPart = (p) => String(p).replace(/\/+$/, "").split("/").pop() || p;
/** A run's own folder: ~/.paw/factories/<factory-id>/<execution-id>. */
const runDir = (r) => `${factoryState.dir}/${r.factory}/${r.id}`;

/** The run a factory tab shows: the one picked, else the latest. */
function shownRun(S) {
  const runs = runsOf(S.factory.id);
  return (S.factory.run && runs.find((r) => r.id === S.factory.run)) || runs[0] || null;
}

/** Do two versions of a factory have the same nodes, wired the same way? */
const sameShape = (a, b) => !!a && !!b &&
  JSON.stringify(a.nodes.map((n) => [n.id, n.needs ?? []])) === JSON.stringify(b.nodes.map((n) => [n.id, n.needs ?? []]));

// ---------- opening ----------
/** Open a factory's tab (or go to it), or make a new factory first. */
async function openFactory(id) {
  const open = [...sessions.values()].find((S) => S.factory?.id === id);
  if (open) { select(open.sid); return open; }
  if (!factoryState.loaded) await loadFactories();
  const S = await newSession("paw", { cwd: factoryState.dir || "~/.paw/factories", approval: "edits", factory: { id, run: null, selected: null } });
  return S;
}

async function newFactory(name) {
  try {
    const id = await invoke("factory_new", { name });
    await loadFactories();
    const S = await openFactory(id);
    if (S) {
      pushLine(S, { stream: "info", cls: "fa-guide", html: factoryGuideHtml(S), ts: Date.now() });
      refresh(S);
      // Open at the guide's start, not at the bottom of the output.
      requestAnimationFrame(() => [...document.querySelectorAll(".tl.info.fa-guide")].at(-1)?.scrollIntoView({ block: "start" }));
    }
    return S;
  } catch (e) {
    const S = curS();
    if (S) sys(S, `✗ ${e}`);
    return null;
  }
}

function factoryTabLabel(S) {
  const f = factoryById(S.factory.id);
  return f?.factory?.name || S.factory.id;
}

function factoryDotState(S) {
  const run = runsOf(S.factory.id)[0];
  if (run?.state === "running" || sessionState(S) === "running") return "running";
  return run?.state === "failed" ? "failed" : "idle";
}

function factoryBanner(S) {
  pushLine(S, { stream: "system", ts: Date.now(), text: tx("— factory {id}: ask {agent} below to change it (nodes, prompts, models, triggers). Run a task runs it in the background.", { id: S.factory.id, agent: S.agent.name }) });
}

/** Under a new factory's diagram: how to build it by talking to the agent. */
function factoryGuideHtml(S) {
  const agent = S.agent.name;
  const head = (t) => `<span class="help-h">${esc(t)}</span>`;
  const say = (t) => `  <span class="cmd">“${esc(t)}”</span>`;
  return [
    head(tx("Build this factory with {agent}", { agent })),
    `<span class="dim">${tx("It starts with one node. Tell {agent} below what the factory should do, in your own words: it writes the file and the diagram above follows.", { agent: esc(agent) })}</span>`,
    "",
    head(tx("Describe the process")),
    say(tx("When a customer email arrives, sort it, draft a reply and wait for my approval before sending it.")),
    say(tx("Check the repo every morning, update the dependencies, run the tests and open a pull request.")),
    "",
    head(tx("Change it step by step")),
    say(tx("Add a node after research that writes a summary.")),
    say(tx("Run the tests and fix in a loop until they pass.")),
    say(tx("Let the draft wait for my approval.")),
    say(tx("Ask me which project to work on before you start.")),
    say(tx("Use a different model for the summary node.")),
    "",
    head(tx("Start it on its own")),
    say(tx("Run it every day at 9:00.")),
    say(tx("Start a run when a webhook arrives.")),
    say(tx("Start a run when ./inbox changes.")),
    "",
    head(tx("Ask about it")),
    say(tx("What does this factory do?")),
    say(tx("Why did the last run fail?")),
    "",
    `<span class="dim">${tx("Run a task starts a run. Edit file opens the YAML if you'd rather write it yourself.")}</span>`,
  ].join("\n");
}

// ---------- the prompt: Paw Agent changes the factory file ----------
const FACTORY_FORMAT = `A factory file is YAML:
name: …            # required
description: …     # what it's for
folder: ~/path     # where the nodes work (default ~)
model: provider/model   # default model for nodes
approval: auto     # level for nodes that change files: ask, edits, auto, full
trigger:           # optional: what starts runs on its own (any of these; Paw's background process watches them)
  every: 15m       # a run every so often
  at: "09:00, 17:30"   # a run at these times of day
  watch: "./check.sh"  # a run each time this command STARTS succeeding (it must fail in between); with watch, every is how often it's checked
  webhook: s3cret  # a run when something POSTs to http://127.0.0.1:4747/factories/<file name>; the body reaches the nodes (true: no secret); ?folder=~/path runs it in that project folder
  file: ./inbox    # a run when this file or folder changes
sandbox:           # optional: its nodes' sandbox (without it, Settings › Sandbox decides); a section turns it on unless enabled: false
  write: ["~/.cargo"]       # folders it may also change, besides the one it works in
  run: [git, gh, npm]       # only these programs may run (and their helpers)
  network: [git, gh]        # only these may use the network (true / false for all)
parallel: 1        # optional: how many runs triggers and repeat may have going at once (default 1); Run a task (the view's button) always starts one. Each run has its own execution id (a UUID) and can work in its own project folder
repeat: true       # optional: start the next run when one finishes (or { after: 10s, on_failure: continue }); a failed run stops the loop unless on_failure: continue
nodes:             # required; ids use letters, digits, - and _
  - id: triage
    title: Short title
    description: What this node is for
    prompt: Complete instructions (the agent sees only this and its inputs)
    needs: [other-id]          # runs after these; their answers are its inputs
    join: all                  # or any: go on when the first input is done (needs 2+ inputs)
    when: { from: triage, matches: "critical|high" }   # a branch: run only if that answer matches (regex; also not_matches)
    model: anthropic/claude-sonnet-5-5
    edits: false               # only reads (default true); nodes that change files run one at a time
    approval: auto
    skills: [name]             # only these skills (default all)
    tools: [read, search, list]  # only these built-in tools: read, edit, write, search, list, shell
    mcp: [server]              # only these MCP servers (default all that are on)
    timeout: 20m
    approve: true              # when it's done, the run waits for the user to approve its answer (they may edit it) or reject it; rejecting stops the run, or with a loop goes back for another round with their reasons
    loop: { back_to: fix, until: { matches: "verdict: approved" }, max: 3 }   # send the run back to an earlier node (or this one) until this node's answer matches; the nodes on the way run again and back_to gets this answer as feedback; on_max: continue goes on after the last round instead of failing
  - id: settle                 # a wait node: no prompt; holds the run until the command succeeds
    needs: [triage]
    wait: "curl -sf localhost:8080/health"
    every: 30s
    timeout: 10m
Nodes that don't need each other run side by side. A node whose inputs were all skipped is skipped too.
Asking the user: every agent node has an ask_user tool: it asks the user a question (with choices if useful) in Paw, notifies them, and waits for the answer. For a plan or result the user should sign off, use approve: true on that node (with loop: { back_to: <node>, max: N } and no until, a rejection sends it back with the user's reasons). Never make nodes wait for answer files, poll with sleep loops or call osascript for this.
Files: each run has its own folder for files nodes share (each node is told where); keep plans and state there, not in a fixed folder, since runs can go in parallel. A run works in the factory's folder, or in the one a webhook (?folder=) or Paw Agent (run_factory) gave it. When a factory needs something from the user to start (which project, what to do), make its first node ask with ask_user: the user answers in the view or in that node's session. Don't ask for it with files.
A run goes once through the nodes. To react to events (a new commit, an alert, a file), prefer a trigger over a long wait node: a watch trigger whose command succeeds once per new event starts one run per event. Use repeat for a pipeline that should loop. Triggers start at most parallel runs of a factory at once; what fires beyond that waits its turn. The file name is the factory's id; each run is kept in ~/.paw/factories/<id>/<execution-id>/.`;

function factoryPrompt(S, text) {
  const f = factoryById(S.factory.id);
  const path = f?.path ?? `${factoryState.dir}/${S.factory.id}.yaml`;
  return [
    `You're helping with a Paw factory: a pipeline of agent nodes that Paw runs in the background. Its file is ${tildify(path)}.`,
    f?.error ? `The file has a problem right now: ${f.error}` : "",
    FACTORY_FORMAT,
    `What the user wants:\n${text}`,
    "If they want the factory changed, edit the file (keep it valid YAML in the format above), then say in a few lines what you changed. If they only ask something, answer without changing it.",
  ].filter(Boolean).join("\n\n");
}

function factorySubmit(S, text, atts) {
  return sendToAgent(S, text, atts, { wrap: (x) => factoryPrompt(S, x) });
}

// ---------- the board ----------
/** What the board draws: a run picked from the list, or the run going, as it
 *  was when it started; otherwise the file as it is now, with the last run's
 *  states on its nodes when that run had the same nodes. */
function factoryPlan(S) {
  const f = factoryById(S.factory.id);
  const latest = runsOf(S.factory.id)[0] ?? null;
  const picked = S.factory.run ? runsOf(S.factory.id).find((r) => r.id === S.factory.run) : null;
  let run, def;
  if (picked) { run = picked; def = picked.def; }
  else if (latest?.state === "running") { run = latest; def = latest.def; }
  else {
    def = f?.factory ?? latest?.def;
    run = latest && (!f?.factory || sameShape(latest.def, f.factory)) ? latest : null;
  }
  if (!def) return null;
  // Which loop each node is in (the looping node's), for "round 2/3".
  const loopOf = new Map();
  for (const n of def.nodes) {
    if (!n.loop) continue;
    for (const id of loopRegion(def.nodes, n.loop.back_to, n.id)) loopOf.set(id, n);
  }
  // Whether its agent nodes run in a sandbox: the file's section over Settings', else Settings'.
  const boxed = !!(def.sandbox ? factorySandbox(def.sandbox) : settings.sandbox ?? {}).enabled;
  const steps = def.nodes.map((n) => {
    const r = run?.nodes.find((x) => x.id === n.id);
    const lp = loopOf.get(n.id);
    const max = lp ? Math.min(Math.max(lp.loop.max ?? 3, 1), 20) : 0;
    return {
      badge: [lp && run && tx("round {n}/{max}", { n: Math.max(r?.round ?? 1, 1), max }), r?.question && tx("asks you"), r?.gate && tx("approve?")].filter(Boolean).join(" · "),
      id: n.id,
      title: n.title?.trim() || n.id,
      needs: n.needs ?? [],
      condFrom: n.when?.from ?? null,
      // A wait node at work is waiting on its check, not running an agent.
      state: n.wait && r?.state === "running" ? "checking" : r?.state ?? "waiting",
      model: n.wait ? tx("waits") : (n.model || def.model || ""),
      edits: n.wait ? true : n.edits !== false,
      startedAt: r?.started_at ?? null,
      endedAt: r?.ended_at ?? null,
      // A wait node's check is a plain command: never in the sandbox.
      sandbox: n.wait ? "wait" : boxed ? "on" : "off",
    };
  });
  return { def, run, latest, steps, selected: S.factory.selected };
}

function renderFactoryView(S, host) {
  host.classList.remove("hidden");
  $("task-split")?.classList.remove("hidden");
  applyBoardSizes(host);
  if (host.dataset.dragging) return;
  if (!factoryState.loaded) {
    if (!factoryState.loading) loadFactories();
    host.dataset.shown = "";
    host.innerHTML = `<div class="tk-empty"><span class="spin-ch">${SPIN[spinFrame % SPIN.length]}</span> ${tx("Reading the factory…")}</div>`;
    return;
  }
  const f = factoryById(S.factory.id);
  const plan = factoryPlan(S);
  const run = plan?.run ?? (S.factory.run ? null : plan?.latest);
  const runs = runsOf(S.factory.id);
  const going = runs.filter((r) => r.state === "running").length;
  const state = run ? run.state : f?.error ? "failed" : "draft";
  const waiting = triggerOf(S.factory.id)?.waiting ?? 0;
  const stateText = (run ? `${RUN_STATE_TEXT[run.state] ?? run.state} · ${runProgress(run)}` : f?.error ? tx("can't run") : tx("ready")) +
    (going > 1 ? ` · ${tx("{n} runs going", { n: going })}` : "") + (waiting ? ` · ${tx("{n} queued", { n: waiting })}` : "");
  const runFolderNow = f?.factory?.folder?.trim() || "~";
  const buttons = [
    f?.factory && `<button class="tk-btn primary" data-fact="run" title="${esc(going ? tx("Start a run in {folder} (alongside the runs going)", { folder: runFolderNow }) : tx("Start a run in {folder}", { folder: runFolderNow }))}">${tx("Run a task")}</button>`,
    run?.state === "running" && `<button class="tk-btn" data-fact="stop" title="${esc(tx("Stop this task ({run})", { run: shortRunId(run.id) }))}">${tx("Stop task")}</button>`,
    f && `<button class="tk-btn" data-fact="edit" title="${esc(tildify(f.path))}">${tx("Edit file")}</button>`,
    // Last, away from Run a task: pausing stops the trigger from listening.
    triggerOf(S.factory.id) && `<button class="tk-btn" data-fact="pause" title="${esc(triggerOf(S.factory.id).paused ? tx("Let the trigger start runs again") : tx("Stop the trigger from starting runs (Run a task still works)"))}">${triggerOf(S.factory.id).paused ? tx("Resume trigger") : tx("Pause trigger")}</button>`,
  ].filter(Boolean).join("");
  const picker = runs.length ? `<select class="tk-in fa-runs" data-fact="pick" title="${esc(tx("Show a run"))}">${
    `<option value=""${S.factory.run ? "" : " selected"}>${tx("Latest run")}</option>` +
    runs.map((r) => `<option value="${esc(r.id)}"${S.factory.run === r.id ? " selected" : ""}>${esc(fmtWhen(r.started_at))} · ${esc(RUN_STATE_TEXT[r.state] ?? r.state)} · ${esc(lastPart(runFolder(r)))} · ${esc(shortRunId(r.id))}</option>`).join("")}</select>` : "";
  const head = `<div class="tk-head">
      <span class="tk-title fa-title" title="${esc([`id: ${S.factory.id}`, f?.factory?.description].filter(Boolean).join("\n"))}"><span class="fa-ico" aria-hidden="true"></span>${esc(f?.factory?.name || S.factory.id)}</span>
      <span class="tk-state st-${esc(state)}">${esc(stateText)}</span>
      ${picker}<span class="grow"></span>${buttons}
    </div>${triggerOf(S.factory.id)?.paused ? `<div class="tk-note fa-paused-note"><span>${tx("The trigger is paused, so it isn't listening: only Run a task starts one.")}</span><button class="tk-btn primary" data-fact="pause">${tx("Resume trigger")}</button></div>` : ""}${run?.note ? `<div class="tk-note">${esc(run.note)}</div>` : ""}`;
  let body;
  if (!f && !run) {
    body = `<div class="tk-empty">${tx("There's no factory “{id}” in {dir} any more.", { id: esc(S.factory.id), dir: esc(tildify(factoryState.dir)) })}</div>`;
  } else if (!plan) {
    body = `<div class="tk-empty fa-broken"><b>${tx("{file} can't be read.", { file: esc(`${f.id}.yaml`) })}</b><div class="tk-err">${esc(f.error ?? "")}</div><div class="tk-dim">${tx("Fix the file (Edit file), or ask {agent} below to fix it.", { agent: esc(S.agent.name) })}</div></div>`;
  } else {
    const vsplit = `<div class="tk-vsplit" title="${esc(tx("Drag to resize · double-click to reset"))}"></div>`;
    const loop = repeats(plan.def) ? " fa-loop" : "";
    // The diagram scales inside a box of its zoomed size (so the scrollbars fit it), with the zoom bar over it.
    const z = typeof S.factory.zoom === "number" ? S.factory.zoom : 1;
    // Unlocked: rulers over the view's top and left, and a hint.
    const open = S.factory.unlocked;
    const rulers = open ? `<canvas class="fa-ruler fa-ruler-x"></canvas><canvas class="fa-ruler fa-ruler-y"></canvas><div class="fa-ruler-corner"></div><div class="fa-edit-hint">${tx("Drag boxes, lines and their dots · double-click a line for an elbow, an elbow to remove it · ⌥ doesn't snap")}</div>` : "";
    const graph = `<div class="fa-graph-wrap${open ? " unlocked" : ""}"><div class="tk-graph fa-graph"><div class="fa-sizer"><div class="fa-zoom${loop}" data-zoom="${z}" style="transform: scale(${z})">${graphHtml(plan)}</div></div></div>${rulers}${zoomBarHtml(S)}</div>`;
    body = `<div class="tk-body">${graph}${vsplit}<aside class="tk-side">${factorySideHtml(S, plan, f)}</aside></div>`;
  }
  // Not under the user's typing (an answer, an approval) while the same run and
  // node are shown; another tab, run or node is drawn even if a box kept focus
  // (a click on the sidebar or the run picker doesn't always move it).
  const shown = ["factory", S.sid, S.factory.id, S.factory.run ?? "", plan?.selected ?? ""].join("|");
  if (host.dataset.shown === shown && host.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
  host.dataset.shown = shown;
  // Keep where the graph was scrolled.
  const old = host.querySelector(".fa-graph");
  const scroll = old ? [old.scrollLeft, old.scrollTop] : null;
  const sideScroll = host.querySelector(".tk-side")?.scrollTop ?? 0;
  host.innerHTML = head + body;
  const g = host.querySelector(".fa-graph");
  if (g) {
    // Boxes where the layout puts them (now, before the first paint).
    placeNodes(g.querySelector(".fa-zoom"), S);
    requestAnimationFrame(() => {
      drawFactoryEdges(g.querySelector(".fa-zoom"), S, plan);
      applyZoom(host, S);
      if (scroll) [g.scrollLeft, g.scrollTop] = scroll;
      drawRulers(host, S);
    });
  }
  const side = host.querySelector(".tk-side");
  if (side) side.scrollTop = sideScroll;
}

const repeats = (def) => !!def?.repeat && def.repeat !== false;

// ---------- zooming the diagram ----------
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const ZOOM_MIN = ZOOM_STEPS[0], ZOOM_MAX = ZOOM_STEPS.at(-1);
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const LOCK_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
const LOCK_OPEN_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

function zoomBarHtml(S) {
  const fit = S.factory.zoom === "fit";
  const open = !!S.factory.unlocked;
  const L = layoutOf(S);
  const placed = L && (Object.keys(L.nodes ?? {}).length || Object.keys(L.ends ?? {}).length);
  return `<div class="fa-zoombar" role="toolbar" aria-label="${esc(tx("Zoom"))}">
    <button class="fa-zb fa-lock${open ? " on" : ""}" data-fact="lock" title="${esc(open ? tx("Lock the layout") : tx("Unlock the layout: move the boxes and where lines meet them"))}">${open ? LOCK_OPEN_SVG : LOCK_SVG}</button>
    ${open && placed ? `<button class="fa-zb" data-fact="layout-reset" title="${esc(tx("Put the boxes and lines back where Paw puts them"))}">${tx("Reset layout")}</button>` : ""}
    <span class="fa-zsep"></span>
    <button class="fa-zb" data-fact="zoom-out" title="${esc(tx("Zoom out (⌘− over the diagram)"))}">−</button>
    <button class="fa-zb fa-zpct" data-fact="zoom-100" title="${esc(tx("Actual size (⌘0 over the diagram)"))}">100%</button>
    <button class="fa-zb" data-fact="zoom-in" title="${esc(tx("Zoom in (⌘+ over the diagram)"))}">+</button>
    <button class="fa-zb${fit ? " on" : ""}" data-fact="zoom-fit" title="${esc(tx("Fit the diagram to the view"))}">${tx("Fit")}</button>
  </div>`;
}

/** The scale that shows the whole diagram in the view. */
function fitScale(g, inner) {
  // A free diagram: its boxes (its canvas can be as big as the view).
  const W = Number(inner.dataset.boxW) || inner.offsetWidth, H = Number(inner.dataset.boxH) || inner.offsetHeight;
  if (!W || !H) return 1;
  return clampZoom(Math.min((g.clientWidth - 16) / W, (g.clientHeight - 16) / H, 2));
}

/** Scale the diagram to the tab's zoom (a number, or "fit"). `anchor`
 *  ({x, y} in the view, and the diagram point under it) stays put. */
function applyZoom(host, S, anchor = null) {
  const g = host.querySelector(".fa-graph"), sizer = g?.querySelector(".fa-sizer"), inner = sizer?.querySelector(".fa-zoom");
  if (!inner) return 1;
  const z = S.factory.zoom === "fit" ? fitScale(g, inner) : clampZoom(Number(S.factory.zoom) || 1);
  inner.style.transform = `scale(${z})`;
  inner.dataset.zoom = String(z);
  // An unlocked canvas fills the view at this zoom.
  if (inner.classList.contains("fa-free")) fitFree(inner);
  sizer.style.width = `${Math.ceil(inner.offsetWidth * z)}px`;
  sizer.style.height = `${Math.ceil(inner.offsetHeight * z)}px`;
  const pct = host.querySelector(".fa-zpct");
  if (pct) pct.textContent = `${Math.round(z * 100)}%`;
  host.querySelector('[data-fact="zoom-fit"]')?.classList.toggle("on", S.factory.zoom === "fit");
  if (anchor) {
    g.scrollLeft = sizer.offsetLeft + anchor.px * z - anchor.x;
    g.scrollTop = sizer.offsetTop + anchor.py * z - anchor.y;
  }
  drawRulers(host, S);
  return z;
}

/** Where a view point (relative to the view) is on the unscaled diagram. */
function zoomAnchor(host, x, y) {
  const g = host.querySelector(".fa-graph"), sizer = g?.querySelector(".fa-sizer");
  const z = Number(sizer?.firstElementChild?.dataset.zoom) || 1;
  if (!sizer) return null;
  return { x, y, px: (g.scrollLeft + x - sizer.offsetLeft) / z, py: (g.scrollTop + y - sizer.offsetTop) / z };
}

/** Set the zoom: a scale, "fit", or a step in or out ("in" / "out"); around a point, or the view's middle. */
function setZoom(S, host, to, at = null) {
  const g = host.querySelector(".fa-graph");
  if (!g) return;
  const now = Number(g.querySelector(".fa-zoom")?.dataset.zoom) || 1;
  let z = to;
  if (to === "in") z = ZOOM_STEPS.find((s) => s > now + 0.001) ?? ZOOM_MAX;
  else if (to === "out") z = [...ZOOM_STEPS].reverse().find((s) => s < now - 0.001) ?? ZOOM_MIN;
  S.factory.zoom = z === "fit" ? "fit" : clampZoom(z);
  const anchor = z === "fit" ? null : zoomAnchor(host, at?.x ?? g.clientWidth / 2, at?.y ?? g.clientHeight / 2);
  applyZoom(host, S, anchor);
  saveWorkspaceSoon();
}

/** ⌘-scroll, or a trackpad pinch (which comes as ctrl-scroll): zoom around the pointer. */
function factoryWheel(S, e, host) {
  if (!(e.ctrlKey || e.metaKey)) return;
  const g = e.target.closest?.(".fa-graph");
  if (!g) return;
  e.preventDefault();
  const now = Number(g.querySelector(".fa-zoom")?.dataset.zoom) || 1;
  const d = Math.max(-60, Math.min(60, e.deltaY));
  const r = g.getBoundingClientRect();
  setZoom(S, host, clampZoom(now * Math.exp(-d * 0.01)), { x: e.clientX - r.left, y: e.clientY - r.top });
}

/** ⌘+ / ⌘− / ⌘0 with the pointer over a factory's diagram: zoom it (true: handled). */
function factoryZoomKey(key) {
  const g = document.querySelector(".fa-graph:hover");
  if (!g) return false;
  for (const P of panes.values()) {
    const host = withPane(P, () => $("task-view"));
    const S = sessions.get(P.sid);
    if (host?.contains(g) && S?.factory) {
      setZoom(S, host, key === "0" ? 1 : key === "-" || key === "_" ? "out" : "in");
      return true;
    }
  }
  return false;
}

// ---------- laying the diagram out by hand ----------
// Unlocked (the lock in the zoom bar), the boxes can be dragged, and the dots
// where lines meet a box moved along its edges. Where you put them is the
// factory's layout, kept beside its runs (<id>/layout.json):
//   { v: 1, nodes: { id: { x, y } }, ends: { "from>to": { from: { side, t }, to: { side, t } } } }
// side is l, r, t or b, and t how far along that side (0…1). Boxes it doesn't
// place stay where Paw's columns put them.
const layoutOf = (S) => factoryById(S.factory.id)?.layout ?? null;
const END_FROM = { side: "r", t: 0.5 }, END_TO = { side: "l", t: 0.5 };
const GRID = 10, SNAP_PX = 6;
let factoryDragAt = 0; // a drag just ended: the click that follows doesn't select

/** Free positions: when unlocked, or when the layout places boxes. Each box
 *  goes where it was saved, else where the columns had it. */
function placeNodes(zoomEl, S) {
  const saved = layoutOf(S)?.nodes ?? {};
  if (!S.factory.unlocked && !Object.keys(saved).length) return;
  const z = Number(zoomEl.dataset.zoom) || 1, zr = zoomEl.getBoundingClientRect();
  const at = [...zoomEl.querySelectorAll(".tk-node[data-step]")].map((n) => {
    const r = n.getBoundingClientRect(), p = saved[n.dataset.step];
    const ok = p && Number.isFinite(p.x) && Number.isFinite(p.y);
    return [n, ok ? Math.max(0, p.x) : (r.left - zr.left) / z, ok ? Math.max(0, p.y) : (r.top - zr.top) / z, n.offsetWidth];
  });
  zoomEl.classList.add("fa-free");
  for (const [n, x, y, w] of at) {
    Object.assign(n.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
    zoomEl.appendChild(n);
  }
  zoomEl.querySelectorAll(".tk-col").forEach((c) => c.remove());
  fitFree(zoomEl);
}

/** A free diagram's size: around its boxes; unlocked, at least the whole
 *  board you see at this zoom, and while dragging, room past the last box. */
function fitFree(zoomEl, grow = false) {
  let w = 0, h = 0;
  for (const n of zoomEl.querySelectorAll(":scope > .tk-node")) {
    w = Math.max(w, parseFloat(n.style.left) + n.offsetWidth);
    h = Math.max(h, parseFloat(n.style.top) + n.offsetHeight);
  }
  // What Fit fits: the boxes, not the canvas around them.
  zoomEl.dataset.boxW = String(Math.ceil(w + 12));
  zoomEl.dataset.boxH = String(Math.ceil(h + 12));
  w += 12; h += 12;
  const g = zoomEl.closest(".fa-graph");
  if (g && zoomEl.closest(".fa-graph-wrap.unlocked")) {
    const z = Number(zoomEl.dataset.zoom) || 1, cs = getComputedStyle(g);
    const viewW = g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const viewH = g.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // Dragging: room past the last box, so a box can go further out.
    w = Math.max(w + (grow ? 160 : 0), Math.floor(viewW / z) - 1);
    h = Math.max(h + (grow ? 120 : 0), Math.floor(viewH / z) - 1);
  }
  // While dragging it only grows, so the view doesn't jump under the pointer.
  if (grow) { w = Math.max(w, parseFloat(zoomEl.style.width) || 0); h = Math.max(h, parseFloat(zoomEl.style.height) || 0); }
  zoomEl.style.width = `${Math.ceil(w)}px`;
  zoomEl.style.height = `${Math.ceil(h)}px`;
}

/** A box's place in the diagram's own (unscaled) space. */
function boxIn(zoomEl, el) {
  const z = Number(zoomEl.dataset.zoom) || 1, zr = zoomEl.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: (r.left - zr.left) / z, y: (r.top - zr.top) / z, w: r.width / z, h: r.height / z };
}

/** The point on a box's side, and the way out of it. */
function endPoint(b, e) {
  const t = Math.min(1, Math.max(0, Number(e?.t ?? 0.5)));
  switch (e?.side) {
    case "l": return { x: b.x, y: b.y + t * b.h, nx: -1, ny: 0 };
    case "t": return { x: b.x + t * b.w, y: b.y, nx: 0, ny: -1 };
    case "b": return { x: b.x + t * b.w, y: b.y + b.h, nx: 0, ny: 1 };
    default: return { x: b.x + b.w, y: b.y + t * b.h, nx: 1, ny: 0 };
  }
}

/** The lines between nodes, each from and to its ends' points; unlocked, a
 *  dot at each end to move it. */
function drawLinks(g, S, plan) {
  const svg = g.querySelector(".tk-edges");
  if (!svg) return;
  const w = g.scrollWidth, h = g.scrollHeight;
  for (const s of [svg]) { s.setAttribute("width", w); s.setAttribute("height", h); s.setAttribute("viewBox", `0 0 ${w} ${h}`); }
  const ends = layoutOf(S)?.ends ?? {};
  const box = (id) => { const el = g.querySelector(`.tk-node[data-step="${CSS.escape(id)}"]`); return el && boxIn(g, el); };
  let paths = "", dots = "";
  for (const s of plan.steps) {
    const to = box(s.id);
    if (!to) continue;
    for (const n of s.needs) {
      const from = box(n);
      if (!from) continue;
      const key = `${n}>${s.id}`;
      const a = endPoint(from, ends[key]?.from ?? END_FROM), b = endPoint(to, ends[key]?.to ?? END_TO);
      // Out of each side along its way out, as far as half the distance that way.
      const k1 = Math.max(16, Math.abs((b.x - a.x) * a.nx + (b.y - a.y) * a.ny) / 2);
      const k2 = Math.max(16, Math.abs((a.x - b.x) * b.nx + (a.y - b.y) * b.ny) / 2);
      const live = stepView(s) === "running" || stepView(s) === "needs";
      const cond = s.condFrom === n ? " cond" : "";
      // Through its elbow points when it has some, else a curve between its ends.
      const elbows = bendsOf(S, key);
      const d = elbows ? polyPath([a, ...elbows, b]) : `M${a.x},${a.y} C${a.x + a.nx * k1},${a.y + a.ny * k1} ${b.x + b.nx * k2},${b.y + b.ny * k2} ${b.x},${b.y}`;
      paths += `<path class="${live ? "live" : ""}${cond}" d="${d}"/>`;
      if (S.factory.unlocked) {
        dots += lineHandles(key, d, [a, ...(elbows ?? []), b]);
        for (const [end, p] of [["from", a], ["to", b]]) dots += `<circle class="fa-anchor" r="4.5" cx="${p.x}" cy="${p.y}" data-edge="${esc(key)}" data-end="${end}"><title>${esc(tx("Drag along the box's edge"))}</title></circle>`;
      }
    }
  }
  svg.innerHTML = paths;
  return dots;
}

/** The handles over the boxes (the lines go under them): written once a
 *  drawing is done, with the loop lines' too. */
function writeHandles(g, S, markup) {
  let over = g.querySelector(":scope > .fa-anchors");
  if (!S.factory.unlocked) { over?.remove(); return; }
  const w = g.scrollWidth, h = g.scrollHeight;
  if (!over) { over = document.createElementNS("http://www.w3.org/2000/svg", "svg"); over.classList.add("fa-anchors"); g.appendChild(over); }
  over.setAttribute("width", w); over.setAttribute("height", h); over.setAttribute("viewBox", `0 0 ${w} ${h}`);
  over.innerHTML = markup;
}

// ---------- elbow points ----------
// A line can go through elbow points (layout.bends: {line: [{x, y}]}, a
// line being "from>to", or "loop:<node>" for a loop's line back). Unlocked:
// drag a line to bend it there, double-click it to add a point, double-click
// a point to take it away; right-click for the same, and to straighten it.

/** A line's elbow points, if it has its own. */
const bendsOf = (S, key) => { const b = layoutOf(S)?.bends?.[key]; return Array.isArray(b) && b.length ? b : null; };

/** A path through points, with rounded corners at the ones between. */
function polyPath(pts, r = 8) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (!l1 || !l2 || rr < 0.5) { d += ` L${c.x},${c.y}`; continue; }
    d += ` L${c.x + (p.x - c.x) * rr / l1},${c.y + (p.y - c.y) * rr / l1} Q${c.x},${c.y} ${c.x + (n.x - c.x) * rr / l2},${c.y + (n.y - c.y) * rr / l2}`;
  }
  const e = pts[pts.length - 1];
  return `${d} L${e.x},${e.y}`;
}

/** A line's handles: a wide invisible path to grab it, and its elbow dots. */
function lineHandles(key, d, pts) {
  const k = esc(key);
  const at = esc(JSON.stringify(pts.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }))));
  let out = `<path class="fa-hit" d="${d}" data-line="${k}" data-pts="${at}"><title>${esc(tx("Drag to bend the line · double-click for an elbow point"))}</title></path>`;
  for (let i = 1; i < pts.length - 1; i++) {
    out += `<circle class="fa-bend" r="4" cx="${pts[i].x}" cy="${pts[i].y}" data-line="${k}" data-i="${i - 1}"><title>${esc(tx("Drag to move · double-click to remove"))}</title></circle>`;
  }
  return out;
}

/** Where on the line's segments a point is nearest: the index to put an elbow at. */
function segmentAt(pts, p) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    const dd = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (dd < bestD) { bestD = dd; best = i; }
  }
  return best;
}

/** A point in the diagram's own (unscaled) space, from the pointer. */
function diagramPoint(zoomEl, ev) {
  const z = Number(zoomEl.dataset.zoom) || 1, zr = zoomEl.getBoundingClientRect();
  return { x: (ev.clientX - zr.left) / z, y: (ev.clientY - zr.top) / z };
}

/** The line's points as drawn now: its ends, and its elbows (its own, or a loop's lane corners). */
function currentPoints(zoomEl, key) {
  const el = zoomEl.querySelector(`.fa-anchors .fa-hit[data-line="${CSS.escape(key)}"]`);
  try { return JSON.parse(el?.dataset.pts || "null"); } catch { return null; }
}

/** Snap an elbow: in line with its neighbours (for right angles) when close, else to the grid. */
function snapBend(p, prev, next, tol) {
  const near = (v, list) => list.reduce((best, a) => (Math.abs(a - v) <= tol && (best == null || Math.abs(a - v) < Math.abs(best - v)) ? a : best), null);
  const x = near(p.x, [prev.x, next.x]), y = near(p.y, [prev.y, next.y]);
  return { x: x ?? Math.round(p.x / (GRID / 2)) * (GRID / 2), y: y ?? Math.round(p.y / (GRID / 2)) * (GRID / 2) };
}

/** Change a line's elbows (or the repeat line's lane) and draw and save it. */
function setBends(S, key, bends, save = true) {
  const L = structuredClone(layoutOf(S) ?? {});
  L.v = 1;
  L.bends ??= {};
  if (bends?.length) L.bends[key] = bends.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  else delete L.bends[key];
  const f = factoryById(S.factory.id);
  if (f) f.layout = L;
  if (save) saveLayout(S, L);
  return L;
}

/** Press on a line: an elbow there that follows the pointer (a click alone adds nothing). */
function dragLine(S, e, host, zoomEl, hit) {
  e.preventDefault();
  e.stopPropagation();
  const key = hit.dataset.line;
  const plan = factoryPlan(S);
  // The repeat line: its lane goes up or down.
  if (key === "repeat") {
    const y0 = Number(hit.dataset.lane) || 0, z = Number(zoomEl.dataset.zoom) || 1;
    let y = y0;
    follow(e, host, (ev, dx, dy) => {
      y = Math.max(0, ev.altKey ? y0 + dy / z : Math.round((y0 + dy / z) / (GRID / 2)) * (GRID / 2));
      const L = structuredClone(layoutOf(S) ?? {}); L.v = 1; L.repeat_y = y;
      const f = factoryById(S.factory.id); if (f) f.layout = L;
      drawFactoryEdges(zoomEl, S, plan);
    }, () => saveLayout(S, layoutOf(S)));
    return;
  }
  const pts = currentPoints(zoomEl, key);
  if (!pts) return;
  const p0 = diagramPoint(zoomEl, e);
  const at = segmentAt(pts, p0);
  const bends = pts.slice(1, -1);
  bends.splice(at, 0, p0);
  const i = at; // the new elbow's index among the elbows
  const z = Number(zoomEl.dataset.zoom) || 1;
  follow(e, host, (ev) => {
    const p = diagramPoint(zoomEl, ev);
    bends[i] = ev.altKey ? p : snapBend(p, [pts[0], ...bends][i], [...bends, pts.at(-1)][i + 1], SNAP_PX / z);
    setBends(S, key, bends, false);
    drawFactoryEdges(zoomEl, S, plan);
  }, () => setBends(S, key, bends));
}

/** Move an elbow point. */
function dragBend(S, e, host, zoomEl, dot) {
  e.preventDefault();
  e.stopPropagation();
  const key = dot.dataset.line, i = Number(dot.dataset.i);
  const pts = currentPoints(zoomEl, key);
  if (!pts) return;
  const bends = pts.slice(1, -1);
  const plan = factoryPlan(S);
  const z = Number(zoomEl.dataset.zoom) || 1;
  follow(e, host, (ev) => {
    const p = diagramPoint(zoomEl, ev);
    bends[i] = ev.altKey ? p : snapBend(p, pts[i], pts[i + 2], SNAP_PX / z);
    setBends(S, key, bends, false);
    drawFactoryEdges(zoomEl, S, plan);
  }, () => setBends(S, key, bends));
}

/** Double-click: on an elbow takes it away, on a line adds one there. */
function factoryDblClick(S, e, host) {
  if (!S.factory.unlocked) return false;
  const zoomEl = e.target.closest?.(".fa-zoom");
  if (!zoomEl) return false;
  const dot = e.target.closest(".fa-bend"), hit = e.target.closest(".fa-hit");
  if (!dot && !hit) return false;
  e.preventDefault();
  const key = (dot ?? hit).dataset.line;
  if (key === "repeat") return true;
  const pts = currentPoints(zoomEl, key);
  if (!pts) return true;
  const bends = pts.slice(1, -1);
  if (dot) bends.splice(Number(dot.dataset.i), 1);
  else { const p = diagramPoint(zoomEl, e); bends.splice(segmentAt(pts, p), 0, p); }
  setBends(S, key, bends);
  drawFactoryEdges(zoomEl, S, factoryPlan(S));
  return true;
}

/** Right-click on a line or an elbow: add, remove, straighten. */
function factoryLineMenu(S, e) {
  if (!S.factory.unlocked) return false;
  const zoomEl = e.target.closest?.(".fa-zoom");
  const dot = e.target.closest?.(".fa-bend"), hit = e.target.closest?.(".fa-hit");
  if (!zoomEl || (!dot && !hit)) return false;
  e.preventDefault();
  const key = (dot ?? hit).dataset.line;
  const redraw = () => drawFactoryEdges(zoomEl, S, factoryPlan(S));
  const p = diagramPoint(zoomEl, e);
  const items = [];
  if (key === "repeat") {
    items.push({ label: tx("Put the line back where Paw puts it"), run: () => { const L = structuredClone(layoutOf(S) ?? {}); delete L.repeat_y; saveLayout(S, L); redraw(); } });
  } else {
    const pts = currentPoints(zoomEl, key) ?? [];
    const bends = pts.slice(1, -1);
    if (dot) items.push({ label: tx("Remove this elbow point"), run: () => { bends.splice(Number(dot.dataset.i), 1); setBends(S, key, bends); redraw(); } });
    else items.push({ label: tx("Add an elbow point here"), run: () => { bends.splice(segmentAt(pts, p), 0, p); setBends(S, key, bends); redraw(); } });
    items.push({ label: tx("Straighten the line"), run: () => { setBends(S, key, null); redraw(); } });
  }
  contextMenu(e.clientX, e.clientY, items);
  return true;
}


async function saveLayout(S, L) {
  const f = factoryById(S.factory.id);
  if (f) f.layout = L;
  await invoke("factory_set_layout", { factory: S.factory.id, layout: L }).catch((e) => { const T = curS(); if (T) sys(T, `✗ ${e}`); });
}

/** Unlocked: press on a box to move it, or on a line's dot to move that end. */
function factoryPointer(S, e, host) {
  if (e.button !== 0 || !S.factory.unlocked) return;
  const zoomEl = e.target.closest?.(".fa-zoom");
  if (!zoomEl?.classList.contains("fa-free")) return;
  const dot = e.target.closest(".fa-anchor");
  if (dot) return dragEnd(S, e, host, zoomEl, dot);
  const bend = e.target.closest(".fa-bend");
  if (bend) return dragBend(S, e, host, zoomEl, bend);
  const hit = e.target.closest(".fa-hit");
  if (hit) return dragLine(S, e, host, zoomEl, hit);
  const node = e.target.closest(".tk-node");
  if (node) dragBox(S, e, host, zoomEl, node);
}

/** Follow the pointer until it's let go (moves of 3px or more count). */
function follow(e, host, move, done) {
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    if (!moved) { moved = true; host.dataset.dragging = "1"; document.body.classList.add("fa-dragging"); }
    move(ev, (ev.clientX - sx), (ev.clientY - sy));
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!moved) return;
    delete host.dataset.dragging;
    document.body.classList.remove("fa-dragging");
    factoryDragAt = Date.now();
    done(ev);
  };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** Lines across the diagram where a box lines up with another. */
function guideLines(zoomEl, x, y) {
  for (const [cls, v, prop] of [["fa-guide-v", x, "left"], ["fa-guide-h", y, "top"]]) {
    let el = zoomEl.querySelector(`:scope > .${cls}`);
    if (v == null) { el?.remove(); continue; }
    if (!el) { el = document.createElement("div"); el.className = `fa-guide ${cls}`; zoomEl.appendChild(el); }
    el.style[prop] = `${v}px`;
  }
}

/** Snap one coordinate: to another box's start, middle or end within the
 *  snapping distance (that line shown), else to the grid. */
function snapAxis(pos, size, lines, tol) {
  let best = null;
  for (const a of lines) for (const off of [0, size / 2, size]) {
    const d = a - (pos + off);
    if (Math.abs(d) <= tol && (best == null || Math.abs(d) < Math.abs(best.d))) best = { d, at: a };
  }
  return best ? { pos: pos + best.d, guide: best.at } : { pos: Math.round(pos / GRID) * GRID, guide: null };
}

function dragBox(S, e, host, zoomEl, node) {
  e.preventDefault();
  const z = Number(zoomEl.dataset.zoom) || 1;
  const x0 = parseFloat(node.style.left) || 0, y0 = parseFloat(node.style.top) || 0, w = node.offsetWidth, h = node.offsetHeight;
  const others = [...zoomEl.querySelectorAll(":scope > .tk-node")].filter((n) => n !== node)
    .map((n) => ({ x: parseFloat(n.style.left) || 0, y: parseFloat(n.style.top) || 0, w: n.offsetWidth, h: n.offsetHeight }));
  const xs = others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w]), ys = others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]);
  const plan = factoryPlan(S);
  follow(e, host, (ev, dx, dy) => {
    let x = x0 + dx / z, y = y0 + dy / z, gx = null, gy = null;
    // ⌥ (Alt): no snapping.
    if (!ev.altKey) {
      ({ pos: x, guide: gx } = snapAxis(x, w, xs, SNAP_PX / z));
      ({ pos: y, guide: gy } = snapAxis(y, h, ys, SNAP_PX / z));
    }
    x = Math.max(0, x); y = Math.max(0, y);
    node.classList.add("fa-moving");
    Object.assign(node.style, { left: `${x}px`, top: `${y}px` });
    fitFree(zoomEl, true);
    guideLines(zoomEl, gx, gy);
    drawFactoryEdges(zoomEl, S, plan);
    drawRulers(host, S, { x, y, w, h });
  }, () => {
    node.classList.remove("fa-moving");
    guideLines(zoomEl, null, null);
    // Every box where it is now, so the others don't move if the columns change.
    const nodes = {};
    for (const n of zoomEl.querySelectorAll(":scope > .tk-node[data-step]")) nodes[n.dataset.step] = { x: Math.round(parseFloat(n.style.left) || 0), y: Math.round(parseFloat(n.style.top) || 0) };
    fitFree(zoomEl);
    applyZoom(host, S);
    saveLayout(S, { ...(layoutOf(S) ?? {}), v: 1, nodes });
  });
}

/** Move where a line meets a box: along the box's edges, to the side nearest the pointer. */
function dragEnd(S, e, host, zoomEl, dot) {
  e.preventDefault();
  e.stopPropagation();
  const key = dot.dataset.edge, end = dot.dataset.end;
  const id = key.split(">")[end === "from" ? 0 : 1];
  const el = zoomEl.querySelector(`.tk-node[data-step="${CSS.escape(id)}"]`);
  if (!el) return;
  const b = boxIn(zoomEl, el);
  const z = Number(zoomEl.dataset.zoom) || 1, zr = zoomEl.getBoundingClientRect();
  const f = factoryById(S.factory.id);
  const L = structuredClone(layoutOf(S) ?? {});
  L.v = 1;
  L.ends ??= {};
  const plan = factoryPlan(S);
  follow(e, host, (ev) => {
    const px = (ev.clientX - zr.left) / z, py = (ev.clientY - zr.top) / z;
    const cx = Math.min(b.x + b.w, Math.max(b.x, px)), cy = Math.min(b.y + b.h, Math.max(b.y, py));
    const sides = [["l", Math.hypot(px - b.x, py - cy)], ["r", Math.hypot(px - b.x - b.w, py - cy)], ["t", Math.hypot(px - cx, py - b.y)], ["b", Math.hypot(px - cx, py - b.y - b.h)]];
    const side = sides.sort((p, q) => p[1] - q[1])[0][0];
    let t = side === "l" || side === "r" ? (cy - b.y) / b.h : (cx - b.x) / b.w;
    if (!ev.altKey && Math.abs(t - 0.5) < 0.08) t = 0.5; // the middle catches it
    L.ends[key] = { from: END_FROM, to: END_TO, ...L.ends[key], [end]: { side, t: Math.round(t * 1000) / 1000 } };
    if (f) f.layout = L;
    drawFactoryEdges(zoomEl, S, plan);
  }, () => saveLayout(S, L));
}

/** Unlocked: rulers along the top and left of the view, in the diagram's
 *  units; `span` (a box being dragged) is marked on them. */
function drawRulers(host, S, span = null) {
  if (!S.factory.unlocked) return;
  const zoomEl = host.querySelector(".fa-zoom");
  if (!zoomEl) return;
  const z = Number(zoomEl.dataset.zoom) || 1, zr = zoomEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const step = [5, 10, 20, 25, 50, 100, 200, 500].find((s) => s * z >= 6) ?? 500;
  const every = [50, 100, 200, 500, 1000, 2000].find((s) => s * z >= 48) ?? 2000;
  for (const c of host.querySelectorAll(".fa-ruler")) {
    const across = c.classList.contains("fa-ruler-x");
    const cr = c.getBoundingClientRect();
    if (!cr.width || !cr.height) continue;
    c.width = Math.round(cr.width * dpr);
    c.height = Math.round(cr.height * dpr);
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    const cs = getComputedStyle(c);
    const len = across ? cr.width : cr.height, thick = across ? cr.height : cr.width;
    const origin = across ? zr.left - cr.left : zr.top - cr.top;
    if (span) {
      ctx.fillStyle = cs.outlineColor;
      ctx.globalAlpha = 0.22;
      const a = origin + (across ? span.x : span.y) * z, l = (across ? span.w : span.h) * z;
      across ? ctx.fillRect(a, 0, l, thick) : ctx.fillRect(0, a, thick, l);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = ctx.fillStyle = cs.color;
    ctx.lineWidth = 1;
    ctx.font = `9px ${cs.fontFamily}`;
    ctx.beginPath();
    for (let u = Math.floor(-origin / z / step) * step; origin + u * z <= len; u += step) {
      const p = Math.round(origin + u * z) + 0.5;
      const big = u % every === 0, mid = u % (step * 5) === 0;
      const tl = big ? thick - 3 : mid ? 6 : 3;
      if (across) { ctx.moveTo(p, thick); ctx.lineTo(p, thick - tl); } else { ctx.moveTo(thick, p); ctx.lineTo(thick - tl, p); }
      if (!big || u < 0) continue;
      if (across) ctx.fillText(String(u), p + 3, 9);
      else { ctx.save(); ctx.translate(9, p - 3); ctx.rotate(-Math.PI / 2); ctx.fillText(String(u), 0, 0); ctx.restore(); }
    }
    ctx.stroke();
  }
}

/** The nodes a loop runs again: back_to, the looping node, and every node on a path between them. */
function loopRegion(nodes, backTo, node) {
  if (backTo === node) return [node];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = (id) => {
    const seen = new Set(), todo = [...(byId.get(id)?.needs ?? [])];
    while (todo.length) { const x = todo.pop(); if (!seen.has(x)) { seen.add(x); todo.push(...(byId.get(x)?.needs ?? [])); } }
    return seen;
  };
  const up = ancestors(node);
  return nodes.filter((n) => n.id === backTo || n.id === node || (up.has(n.id) && ancestors(n.id).has(backTo))).map((n) => n.id);
}

/** "a and b", "a" or "b" (either may be empty). */
const bothText = (a, b) => (a && b ? tx("{a} and {b}", { a, b }) : a || b || "");
const untilText = (u) => bothText(u?.matches && tx("matches “{text}”", { text: u.matches }), u?.not_matches && tx("doesn't match “{text}”", { text: u.not_matches }));

/** The lines between nodes, and for a factory that repeats, a line from its
 *  last nodes back under the graph to its first ones. */
function drawFactoryEdges(g, S, plan = factoryPlan(S)) {
  if (!plan) return;
  const loops = plan.def.nodes.filter((n) => n.loop);
  const L = layoutOf(S) ?? {};
  // Room under the graph for the loop lines (before the lines' canvas takes its size).
  g.style.paddingBottom = loops.length || repeats(plan.def) ? `${40 + loops.length * 22}px` : "";
  let handles = drawLinks(g, S, plan) ?? "";
  const done = () => writeHandles(g, S, handles);
  if (!loops.length && !repeats(plan.def)) return done();
  const svg = g.querySelector(".tk-edges");
  const box = g.getBoundingClientRect();
  const z = Number(g.dataset.zoom) || 1; // measured on screen, drawn unscaled
  const at = (id) => g.querySelector(`.tk-node[data-step="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const cx = (r) => (r.left + r.width / 2 - box.left) / z + g.scrollLeft;
  const bot = (r) => (r.bottom - box.top) / z + g.scrollTop;
  const lowest = Math.max(...plan.def.nodes.map((n) => at(n.id)).filter(Boolean).map(bot));
  const head = (p, q, cls) => {
    // An arrowhead at q, pointing the way from p.
    const l = Math.hypot(q.x - p.x, q.y - p.y) || 1, ux = (q.x - p.x) / l, uy = (q.y - p.y) / l;
    return `<path class="fa-loop-head${cls}" d="M${q.x - ux * 7 - uy * 4},${q.y - uy * 7 + ux * 4} L${q.x},${q.y} L${q.x - ux * 7 + uy * 4},${q.y - uy * 7 - ux * 4}"/>`;
  };
  // Each loop: from the looping node down, back under the graph, up into
  // back_to (one lane each), or through the elbows you gave it.
  let lane = 0;
  for (const n of loops) {
    const from = at(n.id), to = at(n.loop.back_to);
    if (!from || !to) continue;
    const y = lowest + 20 + lane++ * 22;
    const x2 = n.loop.back_to === n.id ? cx(to) - 26 : cx(to);
    const xa = n.loop.back_to === n.id ? cx(from) + 26 : cx(from);
    const key = `loop:${n.id}`;
    const pts = [{ x: xa, y: bot(from) }, ...(bendsOf(S, key) ?? [{ x: xa, y }, { x: x2, y }]), { x: x2, y: bot(to) + 4 }];
    const d = polyPath(pts);
    const st = plan.run?.nodes.find((x) => x.id === n.id);
    const max = Math.min(Math.max(n.loop.max ?? 3, 1), 20);
    const live = (st?.round ?? 1) > 1 && plan.run?.state === "running" ? " live" : "";
    const u = n.loop.until;
    const cond = u ? (u.matches != null ? tx("until {text}", { text: u.matches }) : tx("until not {text}", { text: u.not_matches ?? "" })) : tx("until you approve");
    const label = `${cond} · ${tx("max {n}", { n: max })}${plan.run ? ` · ${tx("round {n}", { n: Math.max(st?.round ?? 1, 1) })}` : ""}`;
    // The label over its longest stretch.
    let li = 0, ll = -1;
    for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); if (l > ll) { ll = l; li = i; } }
    const mid = { x: (pts[li].x + pts[li + 1].x) / 2, y: (pts[li].y + pts[li + 1].y) / 2 };
    svg.insertAdjacentHTML("beforeend", `<path class="fa-loop-line fa-back${live}" d="${d}"/>${head(pts.at(-2), pts.at(-1), " fa-back")}<text class="fa-loop-label" x="${mid.x}" y="${mid.y - 4}" text-anchor="middle">${esc(label.length > 60 ? label.slice(0, 59) + "…" : label)}</text>`);
    if (S.factory.unlocked) handles += lineHandles(key, d, pts);
  }
  if (!repeats(plan.def)) return done();
  const needed = new Set(plan.steps.flatMap((s) => s.needs));
  const ends = plan.steps.filter((s) => !needed.has(s.id)).map((s) => at(s.id)).filter(Boolean);
  const starts = plan.steps.filter((s) => !s.needs.length).map((s) => at(s.id)).filter(Boolean);
  if (!ends.length || !starts.length) return done();
  const x = (r) => (r.left + r.width / 2 - box.left) / z + g.scrollLeft;
  const bottom = (r) => (r.bottom - box.top) / z + g.scrollTop;
  // Below every node and loop, or where you dragged its lane.
  const y = Number.isFinite(L.repeat_y) ? L.repeat_y : Math.max(...[...ends, ...starts].map(bottom)) + 22 + lane * 22;
  const r = 10;
  let d = "";
  // Down from each last node, along the bottom, up into each first node.
  for (const e of ends) d += `M${x(e)},${bottom(e)} V${y - r} Q${x(e)},${y} ${x(e) - r},${y} `;
  const left = Math.min(...starts.map(x)), right = Math.max(...ends.map(x));
  d += `M${right - r},${y} H${left + r} `;
  for (const st of starts) d += `M${x(st) + r},${y} Q${x(st)},${y} ${x(st)},${y - r} V${bottom(st) + 6} `;
  const arrows = starts.map((st) => `<path class="fa-loop-head" d="M${x(st) - 4},${bottom(st) + 11} L${x(st)},${bottom(st) + 4} L${x(st) + 4},${bottom(st) + 11}"/>`).join("");
  const o = typeof plan.def.repeat === "object" ? plan.def.repeat : {};
  const label = o.after ? tx("repeat after {after}", { after: o.after }) : tx("repeat");
  const live = plan.run?.state === "running" ? " live" : "";
  svg.insertAdjacentHTML("beforeend", `<path class="fa-loop-line${live}" d="${d}"/>${arrows}<text class="fa-loop-label" x="${(left + right) / 2}" y="${y - 5}" text-anchor="middle">${esc(label)}</text>`);
  if (S.factory.unlocked) handles += `<path class="fa-hit" d="M${Math.min(left, right) - r},${y} H${Math.max(left, right) + r}" data-line="repeat" data-lane="${y}"><title>${esc(tx("Drag the line up or down"))}</title></path>`;
  done();
}

/** A factory's run on the time line: each node's span, tokens and state. */
function factoryTimelineHtml(S) {
  const plan = factoryPlan(S);
  const run = plan?.run ?? null;
  const now = Date.now();
  const level = plan ? stepLevels(plan.steps) : new Map();
  const rows = (plan?.steps ?? []).map((st) => {
    const r = run?.nodes.find((n) => n.id === st.id);
    const spans = (r?.rounds ?? []).filter((x) => x.started_at).map((x) => ({ at: x.started_at, end: x.ended_at ?? x.started_at, view: x.state }));
    if (r?.started_at) spans.push({ at: r.started_at, end: r.ended_at ?? (st.state === "running" || st.state === "needs" || st.state === "checking" ? null : r.started_at), view: st.state });
    return {
      id: st.id, name: st.title, agent: stepModelName(st), level: level.get(st.id) ?? 0, view: st.state, spans,
      tokens: { known: !!(r?.input_tokens || r?.output_tokens), input: r?.input_tokens ?? 0, output: r?.output_tokens ?? 0 },
    };
  });
  const tokIn = rows.reduce((n, r) => n + r.tokens.input, 0), tokOut = rows.reduce((n, r) => n + r.tokens.output, 0);
  const done = run ? run.nodes.filter((n) => n.state === "done" || n.state === "skipped").length : 0;
  const elapsed = run ? (run.ended_at ?? now) - run.started_at : 0;
  const side = `<aside class="tl-side">
      <div class="tl-k">${tx("Tokens")}</div>
      <div class="tl-big">${fmtCount(tokIn + tokOut)} <span class="tl-of">${tx("tokens")}</span></div>
      <div class="tl-sub">${tokIn || tokOut ? esc(tx("{in} in · {out} out", { in: fmtCount(tokIn), out: fmtCount(tokOut) })) : tx("No tokens yet.")}</div>
      <div class="tl-grid2">
        <div><div class="tl-k">${tx("Elapsed")}</div><div class="tl-v">${elapsed ? esc(fmtElapsed(elapsed)) : "–"}</div></div>
        <div><div class="tl-k">${tx("Nodes")}</div><div class="tl-v">${tx("{done} of {total}", { done, total: rows.length })}</div></div>
        <div><div class="tl-k">${tx("Started by")}</div><div class="tl-v">${esc(run?.trigger ?? "–")}</div></div>
        <div><div class="tl-k">${tx("Started")}</div><div class="tl-v">${run ? esc(fmtWhen(run.started_at)) : "–"}</div></div>
      </div>
      <div class="tl-k">${tx("Outcome")}</div>
      <div class="tk-state st-${esc(run?.state ?? "draft")}">${esc(run ? RUN_STATE_TEXT[run.state] ?? run.state : tx("not run yet"))}</div>
    </aside>`;
  return timelineCore({
    rows, selected: S.factory.selected, side, label: tx("node"), legend: [["checking", tx("checking")]], again: tx("rounds"),
    empty: run ? tx("This run hasn't started any node yet.") : tx("Nothing has run yet. Each node shows here as it runs, on one time line."),
    foot: (total) => {
      const failed = run?.nodes.filter((n) => n.state === "failed").length ?? 0;
      const head = run?.state === "done" ? tx("Done in {time}", { time: fmtElapsed(total) }) : `${RUN_STATE_TEXT[run?.state] ?? tx("Not run")} · ${fmtElapsed(total)}`;
      return failed ? tx("{head}: {done} of {total} nodes, {failed} failed.", { head, done, total: rows.length, failed })
        : tx("{head}: {done} of {total} nodes.", { head, done, total: rows.length });
    },
  });
}

function runProgress(run) {
  const done = run.nodes.filter((n) => n.state === "done" || n.state === "skipped").length;
  const needs = run.nodes.filter((n) => n.state === "needs").length;
  return needs ? tx("{done}/{total} nodes · {needs} waiting for you", { done, total: run.nodes.length, needs }) : tx("{done}/{total} nodes", { done, total: run.nodes.length });
}

function fmtWhen(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const chips = (list) => list.map((x) => `<span class="fa-chip">${esc(x)}</span>`).join("");

function factorySideHtml(S, plan, f) {
  const { def, run } = plan;
  const node = def.nodes.find((n) => n.id === S.factory.selected);
  if (!node) return factorySummaryHtml(S, plan, f);
  const r = run?.nodes.find((x) => x.id === node.id);
  const st = plan.steps.find((s) => s.id === node.id);
  const v = r?.state ?? "waiting";
  const parts = [`<div class="tk-side-title">${esc(st.title)}</div>`];
  const time = stepTime(st);
  parts.push(`<div class="tk-dim"><span class="tk-dot v-${esc(v)}"></span>${node.wait ? tx("wait node") : esc(stepModelName(st))} · ${esc(STEP_STATE_TEXT[v] ?? v)}${time && v !== "waiting" ? ` · ${esc(time)}` : ""}${!node.wait && node.edits === false ? ` · ${tx("reads only")}` : ""}</div>`);
  if (node.description?.trim()) parts.push(`<div class="fa-desc">${esc(node.description.trim())}</div>`);
  // What it waits for from you comes first.
  if (r?.question) parts.push(questionHtml(S, run, r));
  if (r?.gate) parts.push(gateHtml(S, run, r, node));
  // How it's wired.
  const title = (id) => def.nodes.find((n) => n.id === id)?.title?.trim() || id;
  if (node.needs?.length) {
    parts.push(`<label class="tk-lbl">${node.join === "any" ? tx("Goes on when the first of these is done") : tx("Gets the results of")}</label><div>${node.needs.map((n) => esc(title(n))).join(", ")}</div>`);
  }
  if (node.when) {
    const w = node.when;
    const cond = bothText(w.matches && tx("matches <code>{text}</code>", { text: esc(w.matches) }), w.not_matches && tx("doesn't match <code>{text}</code>", { text: esc(w.not_matches) }));
    parts.push(`<label class="tk-lbl">${tx("Runs only when")}</label><div>${tx("{node}'s answer {cond}", { node: esc(title(w.from)), cond })}</div>`);
  }
  if (node.loop) {
    const max = Math.min(Math.max(node.loop.max ?? 3, 1), 20);
    const until = node.loop.until ? tx("until its answer {cond}", { cond: esc(untilText(node.loop.until)) }) : tx("each time you reject its answer");
    const lv = { node: esc(title(node.loop.back_to)), until, rounds: max === 1 ? tx("{n} round", { n: max }) : tx("{n} rounds", { n: max }) };
    const loopText = node.loop.on_max === "continue" ? tx("Back to {node} {until}, at most {rounds}; then it goes on anyway.", lv) : tx("Back to {node} {until}, at most {rounds}; then it fails.", lv);
    parts.push(`<label class="tk-lbl">${tx("Loops")}</label><div>${loopText}${r ? ` <span class="tk-dim">${tx("Round {n} of {max}.", { n: Math.max(r.round ?? 1, 1), max })}</span>` : ""}</div>`);
  }
  if (node.approve) parts.push(`<label class="tk-lbl">${tx("Approval")}</label><div>${node.loop ? tx("When it's done, its answer waits for you: approve it (you can edit it first) or reject it for another round.") : tx("When it's done, its answer waits for you: approve it (you can edit it first) or reject it, which stops the run.")}</div>`);
  if (r?.feedback) {
    // "Rejected by you" is how the background process words a rejection (not shown text of ours).
    const sentBack = r.feedback.text.startsWith("Rejected by you") ? tx("Sent back by you in round {n}", { n: r.feedback.round })
      : tx("Sent back by {node} in round {n}", { node: esc(title(r.feedback.from)), n: r.feedback.round });
    parts.push(`<details class="tk-fold" open><summary>${sentBack}</summary><div class="tk-md">${renderMarkdown(clipEnd(r.feedback.text, 4000))}</div></details>`);
  }
  if (node.wait) {
    const every = esc(node.every || "30s");
    const checks = node.timeout ? tx("Checks every {every}, gives up after {timeout}", { every, timeout: esc(node.timeout) }) : tx("Checks every {every}", { every });
    parts.push(`<label class="tk-lbl">${tx("Waits until this succeeds")}</label><div class="tk-pre">${esc(node.wait)}</div><div class="tk-dim">${checks}${r?.checks ? ` · ${(r.checks === 1 ? tx("checked {n} time", { n: r.checks }) : tx("checked {n} times", { n: r.checks }))}` : ""}</div>`);
  } else {
    const what = [
      node.skills && `<label class="tk-lbl">${tx("Skills")}</label><div>${node.skills.length ? chips(node.skills) : `<span class="tk-dim">${tx("none")}</span>`}</div>`,
      node.tools && `<label class="tk-lbl">${tx("Tools")}</label><div>${node.tools.length ? chips(node.tools) : `<span class="tk-dim">${tx("no built-in tools")}</span>`}</div>`,
      node.mcp && `<label class="tk-lbl">${tx("MCP servers")}</label><div>${node.mcp.length ? chips(node.mcp) : `<span class="tk-dim">${tx("none")}</span>`}</div>`,
    ].filter(Boolean);
    parts.push(what.length ? what.join("") : `<div class="tk-dim">${tx("All your skills, tools and MCP servers.")}</div>`);
    if (node.timeout) parts.push(`<div class="tk-dim">${tx("Gives up after {timeout}", { timeout: esc(node.timeout) })}</div>`);
  }
  // The run's side of it.
  if (r?.state === "needs" && r.approval) {
    const a = r.approval;
    parts.push(`<div class="fa-ask"><div><b>${tx("Waiting for your approval")}</b></div><div>${esc(a.label || a.tool || tx("A tool call"))}</div>${a.detail ? `<div class="tk-pre">${esc(String(a.detail).slice(0, 1200))}</div>` : ""}${a.why ? `<div class="tk-dim">${esc(a.why)}</div>` : ""}
      <div class="tk-row"><button class="tk-btn primary" data-fact="approve" data-decision="once">${tx("Allow")}</button>${a.rule && !a.broad ? `<button class="tk-btn" data-fact="approve" data-decision="always" title="${esc(a.rule)}">${tx("Always allow")}</button>` : ""}<button class="tk-btn danger" data-fact="approve" data-decision="deny">${tx("Deny")}</button></div></div>`);
  }
  const btns = [
    run && ["failed", "stopped"].includes(v) && `<button class="tk-btn primary" data-fact="retry">${tx("Retry")}</button>`,
    run && !node.wait && r?.started_at && `<button class="tk-btn" data-fact="session" title="${esc(r.state === "running" || r.state === "needs" ? tx("Its conversation in a tab: live, and you can answer it there") : tx("Its conversation in a tab"))}">${tx("Open session")}</button>`,
    run && ["failed", "stopped", "waiting"].includes(v) && run.state !== "done" && `<button class="tk-btn" data-fact="skip">${tx("Skip")}</button>`,
  ].filter(Boolean);
  if (btns.length) parts.push(`<div class="tk-row">${btns.join("")}</div>`);
  if (r?.note) parts.push(`<div class="tk-dim">${esc(r.note)}</div>`);
  if (r?.error) parts.push(`<label class="tk-lbl">${tx("What went wrong")}</label><div class="tk-err">${esc(r.error)}</div>`);
  if (r?.result && r.state === "done" && !r.gate) parts.push(`<label class="tk-lbl">${node.wait ? tx("Output") : tx("Result")}</label><div class="tk-md">${renderMarkdown(clipEnd(r.result, 6000))}</div>`);
  if (r?.log?.length && (r.state !== "done" || r.gate)) {
    parts.push(`<label class="tk-lbl">${tx("Activity")}</label><div class="fa-log">${r.log.slice(-40).map((l) =>
      `<div class="fa-log-${esc(l.kind)}">${l.kind === "tool" ? "→ " : l.kind === "ask" ? "? " : l.kind === "you" ? esc(tx("you: ")) : ""}${esc(l.text)}</div>`).join("")}</div>`);
  }
  if (r?.input_tokens || r?.output_tokens) parts.push(`<div class="tk-dim">${esc(tx("↑ {in} ↓ {out} tokens", { in: fmtTokens(r.input_tokens ?? 0), out: fmtTokens(r.output_tokens ?? 0) }))}</div>`);
  if (!node.wait) parts.push(`<details class="tk-fold"${run ? "" : " open"}><summary>${tx("Prompt")}</summary><div class="tk-pre">${esc(node.prompt ?? "")}</div></details>`);
  return parts.join("");
}

/** A draft you're typing for a node (an answer, an edit), kept across redraws. */
const draftKey = (run, r, k) => `${run.id}/${r.id}/${k}`;
const draftOf = (S, key, dflt = "") => (S.factory.drafts ??= {})[key] ?? dflt;

/** A node's agent asks you something (ask_user). */
function questionHtml(S, run, r) {
  const q = r.question;
  const choices = (q.choices ?? []).map((c, i) => `<button class="tk-btn" data-fact="answer" data-choice="${i}">${esc(c)}</button>`).join("");
  return `<div class="fa-ask"><div><b>${tx("{node} asks you", { node: esc(r.id) })}</b></div><div class="tk-md">${renderMarkdown(String(q.question ?? ""))}</div>
    ${choices ? `<div class="tk-row fa-choices">${choices}</div>` : ""}
    <textarea class="tk-in" rows="3" data-fact-in="${esc(draftKey(run, r, "answer"))}" placeholder="${esc(choices ? tx("Or write your answer…") : tx("Your answer…"))}">${esc(draftOf(S, draftKey(run, r, "answer")))}</textarea>
    <div class="tk-row"><button class="tk-btn primary" data-fact="answer">${tx("Send answer")}</button><span class="tk-dim">${tx("or answer in its session")}</span></div></div>`;
}

/** A node's answer waiting for your approval (approve: true). */
function gateHtml(S, run, r, node) {
  return `<div class="fa-ask fa-gate"><div><b>${tx("Its answer waits for your approval")}</b></div>
    <div class="tk-dim">${tx("Edit it if you like: the next nodes get it as you approve it.")}</div>
    <textarea class="tk-in fa-gate-text" rows="10" data-fact-in="${esc(draftKey(run, r, "gate"))}">${esc(draftOf(S, draftKey(run, r, "gate"), r.result ?? ""))}</textarea>
    <input class="tk-in" data-fact-in="${esc(draftKey(run, r, "why"))}" value="${esc(draftOf(S, draftKey(run, r, "why")))}" placeholder="${esc(node.loop ? tx("Why you reject it (goes back as feedback)") : tx("Why you reject it (the run stops)"))}">
    <div class="tk-row"><button class="tk-btn primary" data-fact="gate-approve">${tx("Approve")}</button><button class="tk-btn danger" data-fact="gate-reject">${node.loop ? tx("Reject") : tx("Reject and stop")}</button></div></div>`;
}

function factorySummaryHtml(S, plan, f) {
  const { def, run } = plan;
  const parts = [`<div class="tk-side-title">${esc(def.name)}</div>`];
  if (def.description?.trim()) parts.push(`<div class="tk-goal">${esc(def.description.trim())}</div>`);
  parts.push(`<div class="tk-dim"><code class="fa-id" title="${esc(tx("The factory's id (its file name)"))}">${esc(S.factory.id)}</code> · ${(def.nodes.length === 1 ? tx("{n} node", { n: 1 }) : tx("{n} nodes", { n: def.nodes.length }))} · ${tx("works in {folder}", { folder: esc(def.folder?.trim() || "~") })}${def.model ? ` · ${esc(modelShort(def.model))}` : ""}</div>`);
  // Its nodes' sandbox: the file's section over Settings', or Settings' as it is.
  const sb = def.sandbox ? factorySandbox(def.sandbox) : settings.sandbox;
  parts.push(`<div class="tk-dim">${sb?.enabled ? esc(sandboxSummary(sb)) : tx("No sandbox: its nodes run like a tab without one.")}</div>`);
  // What runs outside it even so: wait nodes' and the watch trigger's commands.
  const waits = def.nodes.filter((n) => n.wait).length, watch = !!def.trigger?.watch;
  if (sb?.enabled && (waits || watch)) {
    parts.push(`<div class="tk-dim fa-unboxed">${waits && watch ? tx("Its wait nodes' and its watch trigger's commands run without a sandbox.")
      : waits ? tx("Its wait nodes' commands run without a sandbox.") : tx("Its watch trigger's command runs without a sandbox.")}</div>`);
  }
  // The trigger as the file has it now (the run may be of an older version).
  parts.push(triggerHtml(S.factory.id, f?.factory ?? def));
  if (run && f?.factory && JSON.stringify(f.factory) !== JSON.stringify(def)) {
    parts.push(`<div class="tk-hint">${tx("The graph shows this run as it was when it started; the file has changed since.")}</div>`);
  } else if (!run && plan.latest) {
    parts.push(`<div class="tk-hint">${tx("The last run ({when}, {state}) used an earlier version of the file; pick it in the run list to see it.", { when: esc(fmtWhen(plan.latest.started_at)), state: esc(RUN_STATE_TEXT[plan.latest.state] ?? plan.latest.state) })}</div>`);
  }
  if (f?.error && run) parts.push(`<div class="tk-warn">${tx("The file has a problem now: {error}", { error: esc(f.error) })}</div>`);
  if (run) {
    parts.push(`<label class="tk-lbl">${tx("This run")}</label><div class="tk-dim">${tx("Started {when} ({trigger})", { when: esc(fmtWhen(run.started_at)), trigger: esc(run.trigger) })}${run.ended_at ? ` · ${tx("took {time}", { time: esc(fmtElapsed(run.ended_at - run.started_at)) })}` : ""} · ${tx("works in {folder}", { folder: esc(runFolder(run)) })}</div>
      <div class="fa-exec"><span class="tk-dim">${tx("Execution")}</span><code title="${esc(tx("The run's execution id"))}">${esc(run.id)}</code><button class="tk-btn" data-fact="rundir" title="${esc(tildify(runDir(run)))}">${tx("Open its folder")}</button></div>`);
    if ((run.trigger === "manual" || run.trigger === "chat") && run.payload?.trim()) parts.push(`<label class="tk-lbl">${tx("Task")}</label><div class="tk-md">${renderMarkdown(clipEnd(run.payload.trim(), 2000))}</div>`);
    if (run.state === "done") {
      // The nodes nobody else needed: their answers are the run's outcome.
      const needed = new Set(def.nodes.flatMap((n) => n.needs ?? []));
      const ends = run.nodes.filter((n) => !needed.has(n.id) && n.state === "done");
      parts.push(`<label class="tk-lbl">${tx("Outcome")}</label>${ends.map((n) =>
        `<div class="tk-out"><div class="tk-dim">${esc(def.nodes.find((d) => d.id === n.id)?.title || n.id)}</div><div class="tk-md">${renderMarkdown(clipEnd(String(n.result ?? ""), 4000))}</div></div>`).join("")}`);
    }
  } else {
    parts.push(`<div class="tk-hint">${tx("Click a node to see its task. Run a task runs the factory in the background: it keeps going if you close the window. Nodes that don't need each other run side by side, as many as Settings › General › Agents at once allows; nodes that change files run one at a time.")}</div>`);
  }
  parts.push(`<div class="tk-dim fa-path">${esc(tildify(f?.path ?? ""))}</div>`);
  return parts.join("");
}

/** A factory's sandbox section over Settings' policy (as the background process applies it). */
function factorySandbox(spec) {
  const p = structuredClone(settings.sandbox ?? {});
  p.enabled = spec.enabled !== false;
  if (spec.write) p.write = spec.write;
  if (spec.run) { p.any_program = false; p.programs = spec.run; }
  if (spec.network === true) p.network = "on";
  else if (spec.network === false) p.network = "off";
  else if (Array.isArray(spec.network)) { p.network = "listed"; p.network_programs = spec.network; }
  return p;
}

/** Clicks on a factory board (bindTaskView passes them here). */
async function factoryClick(S, e, P) {
  const node = e.target.closest(".tk-node");
  if (node) {
    if (Date.now() - factoryDragAt < 300) return; // the end of a drag, not a click
    S.factory.selected = S.factory.selected === node.dataset.step ? null : node.dataset.step;
    saveWorkspaceSoon();
    withPane(P, renderTaskView);
    return;
  }
  const b = e.target.closest("[data-fact]");
  if (!b || b.tagName === "SELECT") return;
  // Stop, Retry, Skip and approvals act on the run shown.
  const run = factoryPlan(S)?.run;
  const fail = (err) => sys(S, `✗ ${err}`);
  try {
    switch (b.dataset.fact) {
      case "run": await startFactoryRun(S, P, null, null); break;
      case "rundir": if (run) await invoke("open_folder", { path: runDir(run) }); break;
      case "par-up": case "par-down": {
        const f = factoryById(S.factory.id);
        const now = triggerOf(S.factory.id)?.parallel ?? f?.factory?.parallel ?? 1;
        const to = Math.max(1, Math.min(20, now + (b.dataset.fact === "par-up" ? 1 : -1)));
        if (to !== now) { await invoke("factory_set_parallel", { factory: S.factory.id, parallel: to }); await loadFactories(); }
        break;
      }
      case "zoom-in": case "zoom-out": setZoom(S, withPane(P, () => $("task-view")), b.dataset.fact.slice(5)); break;
      case "zoom-100": setZoom(S, withPane(P, () => $("task-view")), 1); break;
      case "zoom-fit": setZoom(S, withPane(P, () => $("task-view")), "fit"); break;
      case "lock":
        S.factory.unlocked = !S.factory.unlocked;
        saveWorkspaceSoon();
        withPane(P, renderTaskView);
        break;
      case "layout-reset":
        if (!await askSure(tx("Reset this diagram's layout? The boxes and lines go back to where Paw puts them."), { yes: tx("Reset") })) break;
        await saveLayout(S, null);
        withPane(P, renderTaskView);
        break;
      case "answer": {
        const r = run?.nodes.find((n) => n.id === S.factory.selected);
        if (!r?.question) break;
        const key = draftKey(run, r, "answer");
        const text = b.dataset.choice != null ? r.question.choices?.[+b.dataset.choice] : draftOf(S, key).trim();
        if (!text) { b.closest(".fa-ask")?.querySelector("textarea")?.focus(); break; }
        await invoke("factory_answer", { run: run.id, node: r.id, text });
        delete S.factory.drafts[key];
        break;
      }
      case "gate-approve": case "gate-reject": {
        const r = run?.nodes.find((n) => n.id === S.factory.selected);
        if (!r?.gate) break;
        const approve = b.dataset.fact === "gate-approve";
        const text = approve ? draftOf(S, draftKey(run, r, "gate"), r.result ?? "") : draftOf(S, draftKey(run, r, "why"));
        await invoke("factory_decide", { run: run.id, node: r.id, approve, text: text || null });
        for (const k of ["gate", "why"]) delete S.factory.drafts?.[draftKey(run, r, k)];
        break;
      }
      case "session": if (run && S.factory.selected) await openNodeSession(S, run.id, S.factory.selected); break;
      case "stop": if (run?.state === "running") await invoke("factory_stop", { run: run.id }); break;
      case "pause": {
        const t = triggerOf(S.factory.id);
        if (t) { await invoke("factory_pause", { factory: S.factory.id, paused: !t.paused }); await loadFactories(); }
        break;
      }
      case "retry": if (run) await invoke("factory_retry", { run: run.id, node: S.factory.selected }); break;
      case "skip": if (run) await invoke("factory_skip", { run: run.id, node: S.factory.selected }); break;
      case "edit": {
        const f = factoryById(S.factory.id);
        if (f) await invoke("open_folder", { path: f.path });
        break;
      }
      case "approve": {
        const r = run?.nodes.find((n) => n.id === S.factory.selected);
        if (!r?.approval || r.agent == null) break;
        await invoke("paw_agent_approve", { id: r.agent, request: r.approval.request, decision: b.dataset.decision, rule: r.approval.rule ?? null });
        // Always: for this factory in this folder, for its other nodes and its next runs too.
        if (b.dataset.decision === "always" && r.approval.rule) await saveFactoryRule(run.factory, runFolderAbs(run), r.approval.rule, r.approval.label);
        break;
      }
    }
  } catch (err) {
    fail(err);
  }
  withPane(P, renderTaskView);
}

/** Start a run and show it, with its first node picked: its session is a
 *  click away (Open session), for a factory whose first node talks with you. */
async function startFactoryRun(S, P, folder, task) {
  const id = await invoke("factory_run", { factory: S.factory.id, payload: task, folder, model: defaultPawModel() || null });
  S.factory.run = id; // show this run, even with others going
  const def = factoryById(S.factory.id)?.factory;
  S.factory.selected = def?.nodes.find((n) => !(n.needs ?? []).length)?.id ?? def?.nodes[0]?.id ?? null;
  saveWorkspaceSoon();
  await loadFactories();
  if (!factoryState.runs.has(id)) {
    const r = await invoke("factory_get", { run: id });
    if (r) factoryState.runs.set(id, r);
  }
  withPane(P, renderTaskView);
}

/** Typing an answer or an edit in the side panel (kept across redraws). */
function factoryInput(S, e) {
  const k = e.target.dataset?.factIn;
  if (k) (S.factory.drafts ??= {})[k] = e.target.value;
}

function factoryChange(S, e, P) {
  if (!e.target.matches?.("select[data-fact=pick]")) return false;
  S.factory.run = e.target.value || null;
  saveWorkspaceSoon();
  withPane(P, renderTaskView);
  return true;
}

// ---------- a node's session in a tab ----------
/** Open (or go to) a node's conversation in a tab: live while it runs (you can
 *  answer its questions there), its saved conversation once it's done. */
async function openNodeSession(F, runId, nodeId) {
  const open = [...sessions.values()].find((T) => T.nodeOf?.run === runId && T.nodeOf?.node === nodeId);
  if (open) { select(open.sid); return open; }
  const run = factoryState.runs.get(runId);
  const node = run?.def.nodes.find((n) => n.id === nodeId);
  if (!run || !node) return null;
  const T = await newSession("paw", { cwd: runFolder(run), nodeOf: { factory: run.factory, run: runId, node: nodeId }, after: F });
  if (!T) return null;
  T.title = `${node.title?.trim() || nodeId} · ${run.def.name}`;
  await loadNodeSession(T);
  renderTabs();
  return T;
}

/** Fill a node's tab: attach to its agent while it works, else read its saved conversation. */
async function loadNodeSession(T) {
  const { run: runId, node: nodeId } = T.nodeOf;
  const run = factoryState.runs.get(runId) ?? await invoke("factory_get", { run: runId }).catch(() => null);
  const r = run?.nodes.find((n) => n.id === nodeId);
  const live = r && (r.state === "running" || r.state === "needs") && !r.gate && r.agent != null;
  if (live) {
    const att = await invoke("daemon_attach", { procs: [r.agent], shells: [], after: 0 }).catch(() => null);
    if (att?.procs?.[String(r.agent)]) {
      T.proc = r.agent;
      T.info = att.procs[String(r.agent)].info;
      procToSid.set(T.proc, T.sid);
      T.busy = !!att.procs[String(r.agent)].working;
      sys(T, tx("— {node} in run {run}: live. When it asks you something, type your answer here. —", { node: nodeId, run: shortRunId(runId) }));
      replayEvents(att.events ?? []);
      if (r.question) sys(T, `? ${r.question.question}`);
      refresh(T);
      return;
    }
  }
  const convs = await invoke("factory_conversation", { run: runId, node: nodeId }).catch((e) => { sys(T, `✗ ${e}`); return []; });
  const where = { node: nodeId, run: shortRunId(runId) };
  sys(T, r ? tx("— {node} in run {run} ({state}): its saved conversation; read only. —", { ...where, state: r.state === "needs" && r.gate ? tx("waiting for your approval") : STEP_STATE_TEXT[r.state] ?? r.state })
    : tx("— {node} in run {run}: its saved conversation; read only. —", where));
  convs.forEach((lines, i) => {
    if (convs.length > 1) sys(T, tx("— round {n} —", { n: i + 1 }));
    for (const text of lines) {
      // The prompts it got show as yours do; the rest as the agent's events.
      const prompt = text.startsWith('{"type":"user"') && !text.includes('"tool_result"');
      pushLine(T, { stream: prompt ? "stdin" : "stdout", text, ts: Date.now() });
    }
  });
  if (!convs.length) sys(T, tx("Nothing saved for it yet."));
  refresh(T);
}

/** The run's state of the node a tab shows. */
const nodeRunOf = (T) => factoryState.runs.get(T.nodeOf.run)?.nodes.find((n) => n.id === T.nodeOf.node) ?? null;

function nodePlaceholder(T) {
  const r = nodeRunOf(T);
  if (r?.question) return tx("Answer its question… (⏎ sends it to the node)");
  if (r?.gate) return tx("Its answer waits for your approval in the factory's view");
  if (r?.state === "running" || r?.state === "needs") return tx("It's working: when it asks you something, answer here");
  return tx("Read only: this node has finished");
}

/** A prompt typed in a node's tab: the answer to its question, if it asks one. */
async function nodeSessionSend(T, text) {
  const run = factoryState.runs.get(T.nodeOf.run);
  const r = run?.nodes.find((n) => n.id === T.nodeOf.node);
  if (r?.question) {
    pushLine(T, { stream: "stdin", text, ts: Date.now() });
    try { await invoke("factory_answer", { run: run.id, node: r.id, text }); }
    catch (e) { sys(T, `✗ ${e}`); }
    return;
  }
  sys(T, r && (r.state === "running" || r.state === "needs")
    ? tx("It's working: you can write here when it asks you something (it shows in the factory's view too).")
    : tx("This node has finished: its session is read only. Retry it in the factory's view to run it again."));
}

// ---------- starting runs from a tab ----------
/** A note in a tab that a run started, with a link to it. */
function factoryRunNote(S, ev) {
  const started = tx("Started <b>{name}</b> in {folder} · run <code>{run}</code>", { name: esc(ev.name ?? ev.factory), folder: esc(tildify(ev.folder ?? "")), run: esc(shortRunId(ev.run)) });
  info(S, `<span class="fa-ico" aria-hidden="true"></span> ${started} · <a href="#" class="fa-open-run" data-factory="${esc(ev.factory)}" data-run="${esc(ev.run)}">${tx("Open run")}</a>`);
}

/** /factory run <name> [task]: a run in the tab's folder (or the factory's, from a home-folder tab). */
async function runFactoryFromTab(S, which, task) {
  await loadFactories();
  const want = which.toLowerCase();
  const f = factoryState.list.find((x) => x.id === which || x.id.toLowerCase() === want || x.factory?.name?.toLowerCase() === want);
  if (!f) { sys(S, tx("No factory “{name}”. /factories lists them.", { name: which })); return; }
  if (!f.factory) { sys(S, `✗ ${tx("{file} can't be read: {error}", { file: `${f.id}.yaml`, error: f.error })}`); return; }
  const folder = S.cwd && S.cwd !== homeDir ? S.cwd : null;
  try {
    const run = await invoke("factory_run", { factory: f.id, payload: task || null, folder, model: defaultPawModel() || null });
    factoryRunNote(S, { factory: f.id, name: f.factory.name, run, folder: folder ?? (f.factory.folder?.trim() || "~") });
    loadFactories();
  } catch (e) { sys(S, `✗ ${e}`); }
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest?.(".fa-open-run");
  if (!a) return;
  e.preventDefault();
  if (!factoryState.loaded) await loadFactories();
  const F = await openFactory(a.dataset.factory);
  if (F?.factory) { F.factory.run = a.dataset.run; F.factory.selected = null; saveWorkspaceSoon(); renderFactoryTabs(); }
});

// ---------- /factories ----------
async function factoriesListHtml() {
  await loadFactories();
  const list = factoryState.list;
  const dir = tildify(factoryState.dir);
  if (!list.length) return `<span class="dim">${tx("No factories yet. Make one with {cmd} (they live in {dir}).", { cmd: `<span class="cmd">/factory new &lt;name&gt;</span>`, dir: esc(dir) })}</span>`;
  const glyph = { running: "●", done: "✓", failed: "✗", stopped: "■" };
  const cls = { running: "ok", done: "ok", failed: "err", stopped: "warn" };
  const rows = list.map((f) => {
    const run = runsOf(f.id)[0];
    const name = f.factory?.name || f.id;
    const what = f.error ? `<span class="err">${tx("can't be read: {error}", { error: esc(f.error.length > 80 ? f.error.slice(0, 79) + "…" : f.error) })}</span>`
      : (f.factory.nodes.length === 1 ? tx("{n} node", { n: 1 }) : tx("{n} nodes", { n: f.factory.nodes.length })) +
        (run ? ` · ${tx("last run {when}", { when: esc(fmtWhen(run.started_at)) })} <span class="${cls[run.state] ?? "dim"}">${esc(RUN_STATE_TEXT[run.state] ?? run.state)}</span>` : ` · ${tx("never run")}`);
    return `<span class="${run ? cls[run.state] ?? "dim" : "dim"}">${run ? glyph[run.state] ?? "·" : "◇"}</span> ` +
      `<a href="#" class="task-link" data-open-factory="${esc(f.id)}" title="${esc(tx("Open this factory"))}">${esc(name)}</a>  ${what}`;
  });
  return `<span class="help-h">${tx("Factories ({n})", { n: list.length })}</span> <span class="dim">${esc(dir)}</span>\n${rows.join("\n")}`;
}

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-open-factory]");
  if (!a) return;
  e.preventDefault();
  openFactory(a.dataset.openFactory);
});

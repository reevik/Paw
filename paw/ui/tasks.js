// Tasks: one goal, planned into steps that several agents work through.
//
// A task tab is an ordinary session whose agent is the *planner*: you describe
// the task in its prompt box, the planner answers with a plan (JSON at the end
// of its answer), and the tab shows that plan as a graph above its transcript.
// Nothing runs until you press Run. Each step then runs as an ordinary tab of
// its own (opened in the background, right after the task tab), and when its
// turn ends, its final answer goes to the steps that need it.
//
// Loaded before app.js; everything here only runs when app.js calls it.

const TASK_INPUT_BUDGET = 8000; // characters of earlier results one step gets
const TASK_MAX_STEPS = 12;

const STEP_STATE_TEXT = {
  waiting: "waiting", running: "running", needs: "needs you", done: "done",
  failed: "failed", stopped: "stopped", skipped: "skipped",
};

// ---------- lookups ----------
function taskTabById(id) {
  for (const S of sessions.values()) if (S.task?.id === id) return S;
  return null;
}
/** The task and step a tab runs, if it's a step tab whose task is still open. */
function stepOfTab(C) {
  if (!C?.stepOf) return null;
  const T = taskTabById(C.stepOf.task);
  const st = T?.task.steps.find((s) => s.id === C.stepOf.step);
  return T && st && st.sid === C.sid ? { T, st } : null;
}
/** Agents a step can run on: anything that ends its turns (not raw stdin programs). */
const taskAgents = () => availableAgents().filter((a) => sessionMode(a) !== "stdin");
const agentName = (id) => settings.agents.find((a) => a.id === id)?.name ?? id;

function hasPendingApproval(C) {
  if (!C) return false;
  if (C.waitingApproval > 0) return true;
  for (let i = C.lines.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
    const l = C.lines[i];
    if (l.stream === "approval" && l.state === "pending") return true;
  }
  return false;
}

/** What a step's box shows: its own state, refined by its tab. */
function stepView(st) {
  const C = st.sid != null ? sessions.get(st.sid) : null;
  if ((st.state === "running" || st.state === "blocked") && hasPendingApproval(C)) return "needs";
  if (st.state === "blocked") return "running";
  return st.state;
}

// ---------- the plan ----------
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "step";

/** Order steps so every step comes after the ones it needs; null on a cycle. */
function topoOrder(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set(), out = [];
  let progress = true;
  while (out.length < steps.length && progress) {
    progress = false;
    for (const s of steps) {
      if (done.has(s.id) || !s.needs.every((n) => done.has(n) || !byId.has(n))) continue;
      done.add(s.id);
      out.push(s);
      progress = true;
    }
  }
  return out.length === steps.length ? out : null;
}

/** Column of each step: 0 for steps that need nothing, else one after their latest need. */
function stepLevels(steps) {
  const level = new Map();
  for (const s of topoOrder(steps) ?? steps) {
    level.set(s.id, s.needs.length ? 1 + Math.max(...s.needs.map((n) => level.get(n) ?? 0)) : 0);
  }
  return level;
}

/** Turn whatever the planner wrote into a plan Paw can run, or say why not. */
function checkPlan(raw, plannerAgentId) {
  const warnings = [];
  const agents = taskAgents();
  const fallback = agents.find((a) => a.id === plannerAgentId) ?? agents[0];
  const list = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, TASK_MAX_STEPS);
  if (!list.length) return { error: "The plan has no steps." };
  if (raw.steps.length > TASK_MAX_STEPS) warnings.push(`Only the first ${TASK_MAX_STEPS} steps are kept.`);
  const ids = new Map(); // the planner's id → ours
  const used = new Set();
  const steps = list.map((p, i) => {
    let id = slug(p?.id || p?.title || `step-${i + 1}`);
    for (let n = 2; used.has(id); n++) id = `${slug(p?.id || p?.title)}-${n}`;
    used.add(id);
    ids.set(String(p?.id ?? id), id);
    const want = String(p?.agent ?? "").trim().toLowerCase();
    let agent = agents.find((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want);
    if (!agent) {
      agent = fallback;
      if (want) warnings.push(`“${p.agent}” isn't available here, so ${agent?.name ?? "the planner's agent"} does “${p?.title ?? id}”.`);
    }
    return {
      id,
      title: String(p?.title || id).trim().slice(0, 120),
      agent: agent?.id ?? plannerAgentId,
      needs: Array.isArray(p?.needs) ? p.needs.map(String) : [],
      edits: p?.edits !== false,
      prompt: String(p?.prompt || p?.title || "").trim(),
      state: "waiting",
    };
  });
  for (const s of steps) {
    s.needs = [...new Set(s.needs.map((n) => ids.get(n) ?? (used.has(slug(n)) ? slug(n) : null)).filter((n) => n && n !== s.id))];
  }
  const order = topoOrder(steps);
  if (!order) return { error: "The plan's steps wait on each other in a circle." };
  return { title: String(raw.title ?? "").trim().slice(0, 80), steps: order, warnings };
}

/** JSON as models write it: sometimes without its last bracket, or with a
 *  trailing comma, or just the list of steps. */
function looseJson(text) {
  const t = text.trim().replace(/,\s*([\]}])/g, "$1");
  for (const c of [t, t + "}", t + "]}", t + "\n]}"]) {
    try {
      const v = JSON.parse(c);
      return Array.isArray(v) ? { steps: v } : v;
    } catch {}
  }
  return null;
}

/** The plan at the end of the planner's answer: the last ```json block with steps. */
function parsePlan(text, plannerAgentId) {
  const t = String(text ?? "");
  const blocks = [...t.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  // No fence: the JSON from its last {"title" (or the whole answer) on.
  const at = t.lastIndexOf('{"title"');
  const bare = [at >= 0 ? t.slice(at) : null, t.trim().startsWith("{") || t.trim().startsWith("[") ? t.trim() : null].filter(Boolean);
  let lastError = null;
  for (const c of [...blocks, ...bare]) {
    const p = looseJson(c);
    if (!p || !Array.isArray(p.steps)) continue;
    const plan = checkPlan(p, plannerAgentId);
    if (!plan.error) return plan;
    lastError = plan.error;
  }
  return { error: lastError ?? "The answer has no plan in it." };
}

/** The planner's message with its JSON plan replaced by a pointer to the board. */
function foldPlanJson(line) {
  try {
    const ev = JSON.parse(line);
    let changed = false;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== "text") continue;
      c.text = c.text.replace(/```(?:json)?[ \t]*\n([\s\S]*?)```/g, (whole, body) => {
        if (!Array.isArray(looseJson(body)?.steps)) return whole;
        changed = true;
        return "_(The plan is on the board above.)_";
      });
    }
    return changed ? JSON.stringify(ev) : line;
  } catch { return line; }
}

// ---------- prompts ----------
function plannerPrompt(T, goal) {
  const agents = taskAgents().map((a) => `- ${a.id}: ${a.name}${isPaw(a) ? " (built into Paw: reads, searches, edits files and runs commands)" : ""}`).join("\n");
  return `Plan this task for a team of coding agents working in ${tildify(T.cwd)}.

The task:
${goal}

Look around the folder first if that helps, but don't change anything: other agents do the work.

Split the task into steps (usually 2 to 6). Each step is one prompt for one agent, so make each prompt complete: the agent sees only its prompt and the results of the steps it needs. A step can use the results of earlier steps (list their ids in "needs"); steps that don't need each other can run at the same time. Mark steps that only read, research or review with "edits": false. Steps that change files run one after another.

Agents you can give steps to:
${agents}

Explain the plan in a few lines, then end your answer with the plan as JSON in a \`\`\`json block, in exactly this shape:
\`\`\`json
{"title": "short name for the task", "steps": [
  {"id": "short-id", "title": "what this step does", "agent": "agent id", "needs": [], "edits": true, "prompt": "complete instructions for this step"}
]}
\`\`\``;
}

const revisePrompt = (text) =>
  `Change the plan: ${text}\n\nAnswer with the complete updated plan as JSON in a \`\`\`json block, in the same shape as before.`;

/** Keep the end of a long result: that's where the summary is. */
const clipEnd = (s, n) => (s.length <= n ? s : "…" + s.slice(-n));

function stepPrompt(T, st, text) {
  const t = T.task;
  const byId = new Map(t.steps.map((s) => [s.id, s]));
  const needs = st.needs.map((id) => byId.get(id)).filter(Boolean);
  const each = Math.floor(TASK_INPUT_BUDGET / Math.max(1, needs.length));
  const inputs = needs.map((n) => `<input from="${n.id}" step="${n.title.replace(/"/g, "'")}">\n${clipEnd(String(n.result || "(no answer)").trim(), each)}\n</input>`).join("\n\n");
  return [
    `You're doing one step of a larger task that several agents work on together, in ${tildify(T.cwd)}.`,
    `The whole task: ${t.goal}`,
    `Your step: ${st.title}`,
    inputs && `Results of the steps before yours:\n${inputs}`,
    st.edits ? "" : "This step only reads: don't change any files.",
    text,
    "When you're done, end with a short summary of what you did and what you found. The next steps get it.",
  ].filter(Boolean).join("\n\n");
}

// ---------- starting a task ----------
async function newTask({ agentId, cwd, goal, atts = [] } = {}) {
  const usable = taskAgents();
  const agent = usable.find((a) => a.id === agentId) ?? usable.find((a) => a.id === defaultAgent()?.id) ?? usable[0];
  if (!agent) { invoke("open_preferences", { tab: "agents" }); return null; }
  // The planner only reads: Paw Agent has a read-only level; other agents ask before changing anything.
  const levels = approvalLevels(agent);
  const approval = isPaw(agent) ? "plan" : levels.includes("ask") ? "ask" : undefined;
  const task = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: "", goal: "", state: "new", steps: [], selected: null, note: "", createdAt: Date.now(),
  };
  const T = await newSession(agent.id, { cwd, approval, task });
  if (T && (goal?.trim() || atts.length)) await taskSubmit(T, (goal ?? "").trim(), atts);
  return T;
}

function taskBanner(S) {
  info(S, `<b>New task</b> <span class="dim">planned by</span> ${esc(S.agent.name)}  <span class="dim">in</span> ${esc(tildify(S.cwd))}\n` +
    `<span class="dim">Describe the task below. ${esc(S.agent.name)} splits it into steps for your agents; you review the plan before anything runs.</span>`);
}

/** The task tab's prompt box: the first message is the task, later ones change the plan. */
async function taskSubmit(S, text, atts) {
  const t = S.task;
  if (t.state === "new") {
    // Pasted text badges are part of the goal.
    t.goal = withPasted(text, atts);
    const first = t.goal.split("\n").find((l) => l.trim())?.trim() ?? "";
    t.title = first.length > 60 ? first.slice(0, 57) + "…" : first;
    t.state = "planning";
    t.note = "";
    taskChanged(S);
    return sendToAgent(S, text, atts, { wrap: (x) => plannerPrompt(S, x) });
  }
  if (t.state === "draft") {
    t.state = "planning";
    t.note = "";
    taskChanged(S);
    return sendToAgent(S, text, atts, { wrap: revisePrompt });
  }
  // Planning, running or done: an ordinary message to the planner.
  return sendToAgent(S, text, atts);
}

// ---------- turns ending ----------
/** Called by app.js when a tab's turn ends: { ok, stopped, text, error }. */
function taskTurnEnded(S, r) {
  if (S.task) return plannerTurnEnded(S, r);
  const link = stepOfTab(S);
  if (!link) return;
  const { T, st } = link;
  if (st.state !== "running" && st.state !== "blocked") return; // you talking to a finished step
  if (hasPendingApproval(S)) {
    st.state = "blocked"; // waits for the approval card in its tab
    return taskChanged(T);
  }
  st.endedAt = Date.now();
  if (r.stopped) st.state = "stopped";
  else if (!r.ok) { st.state = "failed"; st.error = String(r.error || r.text || "The agent reported an error.").slice(0, 2000); }
  else { st.state = "done"; st.result = String(r.text ?? "").trim(); st.error = null; }
  taskPump(T);
}

function plannerTurnEnded(S, r) {
  const t = S.task;
  if (t.state !== "planning") return;
  t.state = "draft";
  if (r.stopped) t.note = "Planning stopped. Describe what you want below to plan again.";
  else if (!r.ok) t.note = "Planning failed; the planner's output is below. Ask again below.";
  else {
    const plan = parsePlan(r.text, S.agent.id);
    if (plan.error) t.note = `${plan.error} Ask the planner again below, for example “give me the plan as JSON”.`;
    else {
      t.title = plan.title || t.title;
      t.steps = plan.steps;
      t.selected = null;
      t.note = plan.warnings.join(" ");
    }
  }
  taskChanged(S);
}

// ---------- running ----------
const activeStep = (s) => s.state === "running" || s.state === "blocked";

function runTask(T) {
  const t = T.task;
  if (!t.steps.length || t.state === "planning") return;
  for (const s of t.steps) if (s.state === "stopped" || s.state === "failed") s.state = "waiting";
  t.state = "running";
  t.note = "";
  t.startedAt ??= Date.now();
  taskPump(T);
}

async function stopTask(T) {
  const t = T.task;
  t.state = "stopped";
  for (const s of t.steps) {
    if (!activeStep(s)) continue;
    s.state = "stopped";
    const C = sessions.get(s.sid);
    if (C && isBusy(C)) await interrupt(C).catch(() => {});
  }
  taskChanged(T);
}

/** Start every step whose inputs are ready, within the limits; notice the end. */
function taskPump(T) {
  const t = T.task;
  if (t.state === "running") {
    const byId = new Map(t.steps.map((s) => [s.id, s]));
    const ready = (s) => s.needs.every((n) => ["done", "skipped"].includes(byId.get(n)?.state));
    let editing = t.steps.some((s) => activeStep(s) && s.edits);
    for (const s of t.steps) {
      if (atCapacity()) break; // Settings › General › Agents at once
      if (s.state !== "waiting" || !ready(s) || (s.edits && editing)) continue;
      if (s.edits) editing = true;
      startStep(T, s);
    }
    if (t.steps.every((s) => s.state === "done" || s.state === "skipped")) {
      t.state = "done";
      t.endedAt = Date.now();
      t.selected = null;
      recordTask(T);
    } else if (!t.steps.some(activeStep) && !t.steps.some((s) => s.state === "waiting" && ready(s))) {
      t.state = t.steps.some((s) => s.state === "failed") ? "failed" : "stopped";
      t.note = t.state === "failed" ? "A step failed. Retry it, skip it, or change it and run again." : "";
    }
  }
  taskChanged(T);
}

async function startStep(T, st) {
  st.state = "running";
  st.startedAt = Date.now();
  st.endedAt = null;
  st.error = null;
  taskChanged(T);
  let C = st.sid != null ? sessions.get(st.sid) : null;
  if (!C) {
    const agent = settings.agents.find((a) => a.id === st.agent);
    if (!agent) return stepFailed(T, st, `${agentName(st.agent)} isn't set up in Paw any more.`);
    // Read-only steps: Paw Agent's read-only level; other agents ask first.
    const approval = st.edits ? undefined : isPaw(agent) ? "plan" : approvalLevels(agent).includes("ask") ? "ask" : undefined;
    C = await newSession(agent.id, { cwd: T.cwd, background: true, after: T, approval, stepOf: { task: T.task.id, step: st.id } });
    if (!C) return stepFailed(T, st, `Couldn't open a tab for ${agentName(st.agent)}.`);
    st.sid = C.sid;
  }
  if (!activeStep(st)) return; // stopped while its tab was opening
  // Its slot was counted when the step started (slot: true skips the queue).
  await sendToAgent(C, st.prompt, [], { wrap: (x) => stepPrompt(T, st, x), slot: true });
}

function stepFailed(T, st, why) {
  st.state = "failed";
  st.error = why;
  st.endedAt = Date.now();
  taskPump(T);
}

function retryStep(T, st) {
  st.state = "waiting";
  st.error = null;
  if (T.task.state !== "running") runTask(T);
  else taskPump(T);
}

function skipStep(T, st) {
  st.state = "skipped";
  st.result = "(This step was skipped.)";
  if (T.task.state === "failed" || T.task.state === "stopped") { T.task.state = "running"; }
  taskPump(T);
}

/** A tab is closing: a task stops its steps; a step's task forgets the tab. */
function taskTabClosing(S) {
  if (S.task) {
    for (const s of S.task.steps) {
      const C = sessions.get(s.sid);
      if (C && activeStep(s) && isBusy(C)) interrupt(C).catch(() => {});
      if (C) C.stepOf = null; // the step tabs stay open as ordinary tabs
    }
    return;
  }
  const link = stepOfTab(S);
  if (!link) return;
  const { T, st } = link;
  st.sid = null;
  if (activeStep(st)) { st.state = "stopped"; st.endedAt = Date.now(); }
  taskPump(T);
}

/** Where a new step tab goes: after the task tab and the step tabs already there. */
function tabInsertIndex(T) {
  let i = openTabs.indexOf(T.sid);
  if (i < 0) return openTabs.length;
  while (i + 1 < openTabs.length && sessions.get(openTabs[i + 1])?.stepOf?.task === T.task.id) i++;
  return i + 1;
}

// ---------- saving ----------
function taskSnapshot(S) {
  if (!S.task) return null;
  const t = S.task;
  return {
    ...t,
    steps: t.steps.map(({ sid, ...s }) => ({ ...s, result: s.result ? clipEnd(String(s.result), 20000) : s.result })),
  };
}

/** A restored task: whatever was in flight is stopped. */
/** `live`: the daemon that ran it still runs, so its steps are still working. */
function restoreTask(saved, { live = false } = {}) {
  const t = structuredClone(saved);
  t.steps ??= [];
  for (const s of t.steps) {
    s.sid = null;
    if (activeStep(s) && !live) { s.state = "stopped"; s.endedAt = Date.now(); }
  }
  if (live) return t;
  if (t.state === "planning") { t.state = t.goal ? "draft" : "new"; t.note = t.goal ? "Paw restarted while planning. Ask the planner again below." : ""; }
  if (t.state === "running") { t.state = "stopped"; t.note = "Paw restarted while this task ran. Press Run to carry on where it stopped."; }
  return t;
}

/** After a restore, connect step tabs to their tasks again. */
function relinkTasks() {
  for (const C of sessions.values()) {
    if (!C.stepOf) continue;
    const T = taskTabById(C.stepOf.task);
    const st = T?.task.steps.find((s) => s.id === C.stepOf.step);
    if (st && st.sid == null) st.sid = C.sid;
    else C.stepOf = null;
  }
}

// ---------- tabs ----------
function taskTabLabel(S) {
  const t = S.task;
  const name = t.title || "New task";
  if (t.state === "running") {
    const n = t.steps.filter(activeStep).length;
    return `${name} · ${n} running`;
  }
  return name;
}

/** The tab's dot: the planner while planning, otherwise the task. */
function taskDotState(S) {
  const t = S.task;
  if (t.state === "planning" || t.state === "running") return "running";
  if (t.state === "failed") return "failed";
  return sessionState(S) === "running" ? "running" : "idle";
}

const taskNeedsYou = (S) => S.task.steps.filter((s) => stepView(s) === "needs").length;

function taskPlaceholder(S) {
  return {
    new: "Describe the task, and the planner splits it into steps…",
    planning: "Planning… (⌘. to stop)",
    draft: "Change the plan: add a step, use Copilot for the UI step, re-plan…",
    running: "Ask the planner something…",
  }[S.task.state] ?? "Ask the planner something…";
}

function taskChanged(T) {
  saveWorkspaceSoon();
  renderTabs();
  inPane(T, () => { renderTaskView(); renderHeader(); });
  pluginTaskChanged(T);
}

// ---------- the board ----------
function taskStatusText(t) {
  const n = t.steps.length;
  const done = t.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  switch (t.state) {
    case "new": return "Waiting for the task";
    case "planning": return "Planning…";
    case "draft": return n ? `Plan · ${n} step${n > 1 ? "s" : ""}` : "No plan yet";
    case "running": return `Running · ${done} of ${n} done`;
    case "done": return `Done · ${n} step${n > 1 ? "s" : ""}`;
    case "failed": return `Stopped on a failed step · ${done} of ${n} done`;
    case "stopped": return `Stopped · ${done} of ${n} done`;
    default: return t.state;
  }
}

function stepTime(st) {
  if (!st.startedAt) return "";
  return fmtElapsed((st.endedAt ?? Date.now()) - st.startedAt);
}

function renderTaskView() {
  const host = $("task-view");
  if (!host) return;
  const S = curS();
  const t = S?.task;
  host.classList.toggle("hidden", !t);
  if (!t) { host.innerHTML = ""; return; }
  // Don't rebuild under the user's typing (the step editor is part of it).
  if (host.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) {
    updateTaskTimes(host, t);
    return;
  }
  const scroll = host.querySelector(".tk-graph")?.scrollLeft ?? 0;
  const canRun = t.steps.length && ["draft", "stopped", "failed"].includes(t.state);
  const buttons = [
    canRun && `<button class="tk-btn primary" data-act="run">${t.state === "draft" ? "Run" : "Run again"}</button>`,
    t.state === "running" && `<button class="tk-btn" data-act="stop">Stop</button>`,
    t.state === "planning" && `<button class="tk-btn" data-act="stop-plan">Stop planning</button>`,
    t.state === "draft" && t.steps.length > 0 && `<button class="tk-btn" data-act="add">Add step</button>`,
  ].filter(Boolean).join("");
  // Views plugins add (Settings › Plugins), next to the graph.
  const views = t.steps.length ? boardViews() : [];
  let viewKey = S.boardView && views.some(([k]) => k === S.boardView) ? S.boardView : "graph";
  if (viewKey === "graph" && S.view) closeBoardView(S);
  const switcher = views.length ? `<div class="tk-views" role="tablist">${[["graph", { label: "Graph" }], ...views].map(([k, v]) =>
    `<button class="tk-viewbtn${k === viewKey ? " on" : ""}" data-view="${esc(k)}">${esc(v.label)}</button>`).join("")}</div>` : "";
  const head = `<div class="tk-head">
      <span class="tk-title" title="${esc(t.goal)}">${esc(t.title || "New task")}</span>
      <span class="tk-state st-${esc(t.state)}">${esc(taskStatusText(t))}</span>
      ${switcher}<span class="grow"></span>${buttons}
    </div>${t.note ? `<div class="tk-note">${esc(t.note)}</div>` : ""}`;
  let body;
  if (t.state === "new" || (!t.steps.length && t.state !== "planning")) {
    body = `<div class="tk-empty">${t.state === "new"
      ? `Describe the task in the prompt box below. ${esc(S.agent.name)} splits it into steps for your agents, and you check the plan before anything runs.`
      : "No steps yet."}</div>`;
  } else if (!t.steps.length) {
    body = `<div class="tk-empty"><span class="spin-ch">${SPIN[spinFrame % SPIN.length]}</span> ${esc(S.agent.name)} is planning…</div>`;
  } else {
    body = viewKey === "graph"
      ? `<div class="tk-body"><div class="tk-graph">${graphHtml(t)}</div><aside class="tk-side">${sideHtml(S)}</aside></div>`
      : `<div class="tk-body"><div class="tk-viewslot"></div><aside class="tk-side">${sideHtml(S)}</aside></div>`;
  }
  // A plugin's view keeps its canvas across redraws: take it out first.
  S.view?.el.remove();
  host.innerHTML = head + body;
  const slot = host.querySelector(".tk-viewslot");
  if (slot) {
    const el = boardViewElement(S, viewKey);
    if (el) slot.replaceWith(el);
  }
  const g = host.querySelector(".tk-graph");
  if (g) {
    g.scrollLeft = scroll;
    requestAnimationFrame(() => drawEdges(g, t));
  }
}

function graphHtml(t) {
  const level = stepLevels(t.steps);
  const cols = [];
  for (const s of t.steps) (cols[level.get(s.id) ?? 0] ??= []).push(s);
  return `<svg class="tk-edges" aria-hidden="true"></svg>` + cols.map((col) => `<div class="tk-col">${col.map((s) => {
    const v = stepView(s);
    const time = stepTime(s);
    return `<button class="tk-node v-${v}${t.selected === s.id ? " sel" : ""}" data-step="${esc(s.id)}" title="${esc(s.title)}">
      <span class="tk-node-title">${esc(s.title)}</span>
      <span class="tk-node-sub"><span class="tk-dot v-${v}"></span>${esc(agentName(s.agent))} · ${esc(STEP_STATE_TEXT[v] ?? v)}${time && v !== "waiting" ? ` · <span data-time="${esc(s.id)}">${esc(time)}</span>` : ""}${s.edits ? "" : ` · <span class="tk-ro">reads</span>`}</span>
    </button>`;
  }).join("")}</div>`).join("");
}

/** Curves from each step to the steps that need it. */
function drawEdges(g, t) {
  const svg = g.querySelector(".tk-edges");
  if (!svg) return;
  const box = g.getBoundingClientRect();
  const w = g.scrollWidth, h = g.scrollHeight;
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const at = (id) => g.querySelector(`.tk-node[data-step="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  let paths = "";
  for (const s of t.steps) {
    const to = at(s.id);
    if (!to) continue;
    for (const n of s.needs) {
      const from = at(n);
      if (!from) continue;
      const x1 = from.right - box.left + g.scrollLeft, y1 = from.top + from.height / 2 - box.top + g.scrollTop;
      const x2 = to.left - box.left + g.scrollLeft, y2 = to.top + to.height / 2 - box.top + g.scrollTop;
      const dx = Math.max(16, (x2 - x1) / 2);
      const live = stepView(s) === "running" || stepView(s) === "needs";
      paths += `<path class="${live ? "live" : ""}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
    }
  }
  svg.innerHTML = paths;
}

function updateTaskTimes(host, t) {
  for (const s of t.steps) {
    const el = host.querySelector(`[data-time="${CSS.escape(s.id)}"]`);
    if (el) el.textContent = stepTime(s);
  }
}

function sideHtml(S) {
  const t = S.task;
  const st = t.steps.find((s) => s.id === t.selected);
  if (!st) return taskSummaryHtml(S);
  const draft = t.state === "draft";
  const C = st.sid != null ? sessions.get(st.sid) : null;
  const v = stepView(st);
  const others = t.steps.filter((o) => o.id !== st.id && !dependsOn(t, o, st.id));
  const parts = [];
  if (draft) {
    parts.push(`<label class="tk-lbl">Step</label><input class="tk-in" data-field="title" value="${esc(st.title)}" spellcheck="false">`);
    parts.push(`<label class="tk-lbl">Agent</label><select class="tk-in" data-field="agent">${taskAgents().map((a) =>
      `<option value="${esc(a.id)}"${a.id === st.agent ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>`);
    parts.push(`<label class="tk-check"><input type="checkbox" data-field="edits"${st.edits ? " checked" : ""}> Changes files</label>`);
    parts.push(`<label class="tk-lbl">Gets the results of</label>${others.length ? others.map((o) =>
      `<label class="tk-check"><input type="checkbox" data-need="${esc(o.id)}"${st.needs.includes(o.id) ? " checked" : ""}> ${esc(o.title)}</label>`).join("")
      : `<span class="tk-dim">No other steps</span>`}`);
    parts.push(`<label class="tk-lbl">Prompt</label><textarea class="tk-in tk-prompt" data-field="prompt" spellcheck="false">${esc(st.prompt)}</textarea>`);
    parts.push(`<div class="tk-row"><button class="tk-btn danger" data-act="delete" data-id="${esc(st.id)}">Delete step</button></div>`);
  } else {
    parts.push(`<div class="tk-side-title">${esc(st.title)}</div>`);
    parts.push(`<div class="tk-dim"><span class="tk-dot v-${v}"></span>${esc(agentName(st.agent))} · ${esc(STEP_STATE_TEXT[v] ?? v)}${stepTime(st) ? ` · ${esc(stepTime(st))}` : ""}${st.edits ? "" : " · reads only"}</div>`);
    if (st.needs.length) parts.push(`<label class="tk-lbl">Gets the results of</label><div>${st.needs.map((n) => esc(t.steps.find((x) => x.id === n)?.title ?? n)).join(", ")}</div>`);
    const btns = [
      C && `<button class="tk-btn" data-act="open" data-id="${esc(st.id)}">Open its tab</button>`,
      ["failed", "stopped"].includes(st.state) && `<button class="tk-btn primary" data-act="retry" data-id="${esc(st.id)}">Retry</button>`,
      ["failed", "stopped", "waiting"].includes(st.state) && t.state !== "done" && `<button class="tk-btn" data-act="skip" data-id="${esc(st.id)}">Skip</button>`,
    ].filter(Boolean);
    if (btns.length) parts.push(`<div class="tk-row">${btns.join("")}</div>`);
    if (v === "needs") parts.push(`<div class="tk-warn">Waiting for your approval in its tab.</div>`);
    if (st.error) parts.push(`<label class="tk-lbl">What went wrong</label><div class="tk-err">${esc(st.error)}</div>`);
    if (st.result && st.state === "done") parts.push(`<label class="tk-lbl">Result</label><div class="tk-md">${renderMarkdown(clipEnd(st.result, 6000))}</div>`);
    parts.push(`<details class="tk-fold"><summary>Prompt</summary><div class="tk-pre">${esc(st.prompt)}</div></details>`);
  }
  return parts.join("");
}

function taskSummaryHtml(S) {
  const t = S.task;
  const parts = [`<div class="tk-side-title">The task</div><div class="tk-goal">${esc(t.goal)}</div>`,
    `<div class="tk-dim">Planned by ${esc(S.agent.name)} · ${esc(tildify(S.cwd))}</div>`];
  if (t.state === "draft") parts.push(`<div class="tk-hint">Click a step to change it, or ask the planner below to change the plan. Steps that change files run one at a time; others run side by side, as many as Settings › General › Agents at once allows (${maxAgents() === Infinity ? "no limit" : maxAgents()}).</div>`);
  if (t.state === "done") {
    // The steps nobody else needed: their answers are the task's outcome.
    const needed = new Set(t.steps.flatMap((s) => s.needs));
    const ends = t.steps.filter((s) => !needed.has(s.id) && s.state === "done");
    parts.push(`<label class="tk-lbl">Outcome</label>${ends.map((s) =>
      `<div class="tk-out"><div class="tk-dim">${esc(s.title)}</div><div class="tk-md">${renderMarkdown(clipEnd(String(s.result ?? ""), 4000))}</div></div>`).join("")}`);
    if (t.startedAt && t.endedAt) parts.push(`<div class="tk-dim">Took ${esc(fmtElapsed(t.endedAt - t.startedAt))}</div>`);
  }
  return parts.join("");
}

/** Whether `s` needs `id`, directly or through other steps. */
function dependsOn(t, s, id, seen = new Set()) {
  if (seen.has(s.id)) return false;
  seen.add(s.id);
  return s.needs.some((n) => n === id || dependsOn(t, t.steps.find((x) => x.id === n) ?? { id: n, needs: [] }, id, seen));
}

// ---------- the board's controls ----------
function bindTaskView(P) {
  const host = withPane(P, () => $("task-view"));
  const S = () => sessions.get(P.sid);
  host.addEventListener("click", (e) => {
    const T = S();
    if (!T?.task) return;
    const t = T.task;
    const vb = e.target.closest(".tk-viewbtn");
    if (vb) {
      T.boardView = vb.dataset.view;
      if (T.boardView === "graph") closeBoardView(T);
      withPane(P, renderTaskView);
      return;
    }
    const node = e.target.closest(".tk-node");
    if (node) {
      t.selected = t.selected === node.dataset.step ? null : node.dataset.step;
      withPane(P, renderTaskView);
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const st = t.steps.find((s) => s.id === b.dataset.id);
    switch (b.dataset.act) {
      case "run": runTask(T); break;
      case "stop": stopTask(T); break;
      case "stop-plan": interrupt(T); break;
      case "retry": if (st) retryStep(T, st); break;
      case "skip": if (st) skipStep(T, st); break;
      case "open": if (st?.sid != null) select(st.sid); break;
      case "delete":
        if (!st) break;
        t.steps = t.steps.filter((s) => s.id !== st.id);
        for (const s of t.steps) s.needs = s.needs.filter((n) => n !== st.id);
        t.selected = null;
        taskChanged(T);
        break;
      case "add": {
        let id = "new-step";
        for (let n = 2; t.steps.some((s) => s.id === id); n++) id = `new-step-${n}`;
        t.steps.push({ id, title: "New step", agent: T.agent.id, needs: [], edits: true, prompt: "", state: "waiting" });
        t.selected = id;
        taskChanged(T);
        break;
      }
    }
  });
  host.addEventListener("dblclick", (e) => {
    const node = e.target.closest(".tk-node");
    const st = node && S()?.task?.steps.find((s) => s.id === node.dataset.step);
    if (st?.sid != null && sessions.has(st.sid)) select(st.sid);
  });
  // Editing a step of the draft plan.
  const edit = (e, rerender) => {
    const T = S();
    const t = T?.task;
    const st = t?.steps.find((s) => s.id === t.selected);
    if (!st || t.state !== "draft") return;
    const el = e.target;
    if (el.dataset.need) {
      st.needs = el.checked ? [...new Set([...st.needs, el.dataset.need])] : st.needs.filter((n) => n !== el.dataset.need);
      t.steps = topoOrder(t.steps) ?? t.steps;
    } else if (el.dataset.field === "edits") st.edits = el.checked;
    else if (el.dataset.field === "title") st.title = el.value.slice(0, 120) || st.id;
    else if (el.dataset.field === "agent") st.agent = el.value;
    else if (el.dataset.field === "prompt") st.prompt = el.value;
    else return;
    saveWorkspaceSoon();
    if (rerender) { el.blur(); taskChanged(T); }
  };
  host.addEventListener("input", (e) => { if (e.target.matches("input[type=text], input:not([type]), textarea")) edit(e, false); });
  host.addEventListener("change", (e) => edit(e, true));
  host.addEventListener("focusout", (e) => {
    // Titles show in the graph: redraw when you leave the field.
    if (e.target.dataset?.field === "title") setTimeout(() => { const T = S(); if (T?.task) withPane(P, renderTaskView); }, 0);
  });
  new ResizeObserver(() => {
    const T = S();
    const g = host.querySelector(".tk-graph");
    if (T?.task && g) drawEdges(g, T.task);
  }).observe(host);
}

// Running steps' times and states tick on screen.
setInterval(() => {
  for (const P of panes.values()) {
    const T = sessions.get(P.sid);
    if (!T?.task) continue;
    if (T.task.state === "running") withPane(P, renderTaskView);
    else if (T.task.state === "planning" && !T.task.steps.length) withPane(P, () => {
      const sp = $("task-view")?.querySelector(".tk-empty .spin-ch");
      if (sp) sp.textContent = SPIN[spinFrame % SPIN.length];
    });
  }
}, 1000);

// ---------- /tasks ----------
/** Every open task, one line each: state, steps, time, planner; the title opens its tab. */
function tasksListHtml() {
  const tasks = openTabs.map((sid) => sessions.get(sid)).filter((S) => S?.task);
  if (!tasks.length) return `<span class="dim">No tasks yet. Start one with</span> <span class="cmd">/task &lt;what&gt;</span> <span class="dim">or select text, right-click, Create a task.</span>`;
  const glyph = { running: "●", planning: "●", done: "✓", failed: "✗", stopped: "■", draft: "◇", new: "◇" };
  const cls = { running: "ok", planning: "ok", done: "ok", failed: "err", stopped: "warn", draft: "dim", new: "dim" };
  const rows = tasks.map((T) => {
    const t = T.task;
    const steps = t.steps;
    const count = (v) => steps.filter((st) => stepView(st) === v).length;
    const done = steps.filter((st) => st.state === "done" || st.state === "skipped").length;
    const bits = [];
    if (t.state === "planning") bits.push("planning…");
    else if (!steps.length) bits.push("no plan yet");
    else if (t.state === "draft") bits.push(`${steps.length} step${steps.length === 1 ? "" : "s"} planned`);
    else bits.push(`${done}/${steps.length} steps`);
    if (t.state !== "draft") {
      if (count("running")) bits.push(`${count("running")} running`);
      if (count("needs")) bits.push(`<span class="warn">${count("needs")} waiting for you</span>`);
      if (count("failed")) bits.push(`<span class="err">${count("failed")} failed</span>`);
    }
    const time = t.startedAt ? fmtElapsed((t.endedAt ?? Date.now()) - t.startedAt) : "";
    const title = t.title || t.goal?.split("\n")[0] || "New task";
    return `<span class="${cls[t.state] ?? "dim"}">${glyph[t.state] ?? "·"}</span> ` +
      `<a href="#" class="task-link" data-open-task="${esc(t.id)}" title="Open this task">${esc(title.length > 48 ? title.slice(0, 47) + "…" : title)}</a>` +
      `  <span class="${cls[t.state] ?? "dim"}">${esc(t.state)}</span>  ${bits.join(" · ")}` +
      (time ? `  <span class="dim">${esc(time)}</span>` : "") +
      `  <span class="dim">${esc(T.agent.name)} · ${esc(tildify(T.cwd))}</span>`;
  });
  return `<span class="help-h">Tasks (${tasks.length})</span>\n${rows.join("\n")}`;
}

// A task's title in /tasks opens its tab (its group unfolds if it's folded).
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-open-task]");
  if (!a) return;
  e.preventDefault();
  const T = [...sessions.values()].find((S) => S.task?.id === a.dataset.openTask);
  if (!T) { const S = curS(); if (S) sys(S, "That task's tab is closed."); return; }
  const g = T.group ? groups.get(T.group) : null;
  if (g?.collapsed) g.collapsed = false;
  select(T.sid);
});

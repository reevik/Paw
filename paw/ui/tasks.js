// Tasks: one goal, planned into steps that Paw Agent works through, each
// step on the model the plan gives it.
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
  waiting: tx("waiting"), running: tx("running"), needs: tx("needs you"), done: tx("done"),
  failed: tx("failed"), stopped: tx("stopped"), skipped: tx("skipped"),
  checking: tx("checking"), // a factory's wait node, checking its command
};
/** A plan's state as /plans shows it. */
const TASK_STATE_TEXT = {
  new: tx("new"), planning: tx("planning"), draft: tx("draft"), running: tx("running"),
  done: tx("done"), failed: tx("failed"), stopped: tx("stopped"),
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
/** Models a step can run on: the visible ones (Settings › Agents). */
const taskModels = () => visibleModels();
/** Deprecated: CLI agents (CLI_AGENTS). Steps used to name an agent. */
const agentName = (id) => settings.agents.find((a) => a.id === id)?.name ?? id;
/** What a step runs on, short: claude-sonnet-5-5. */
const stepModelName = (st) => (st.model ? modelShort(st.model) : CLI_AGENTS && st.agent ? agentName(st.agent) : tx("default model"));

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
function checkPlan(raw, plannerModel) {
  const warnings = [];
  const models = taskModels();
  const fallback = plannerModel || defaultPawModel();
  const list = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, TASK_MAX_STEPS);
  if (!list.length) return { error: tx("The plan has no steps.") };
  if (raw.steps.length > TASK_MAX_STEPS) warnings.push(tx("Only the first {n} steps are kept.", { n: TASK_MAX_STEPS }));
  const ids = new Map(); // the planner's id → ours
  const used = new Set();
  const steps = list.map((p, i) => {
    let id = slug(p?.id || p?.title || `step-${i + 1}`);
    for (let n = 2; used.has(id); n++) id = `${slug(p?.id || p?.title)}-${n}`;
    used.add(id);
    ids.set(String(p?.id ?? id), id);
    // A full "provider/model", or a bare id only one provider has (older plans said "agent").
    const want = String(p?.model ?? p?.agent ?? "").trim();
    let model = models.includes(want) ? want : null;
    const hits = model || !want ? [] : models.filter((m) => modelShort(m) === want);
    if (hits.length === 1) model = hits[0];
    if (!model) {
      model = fallback;
      const vars = { want, models: hits.join(` ${tx("or")} `), model: model ? modelShort(model) : tx("the planner's model"), step: p?.title ?? id };
      if (want) warnings.push(hits.length ? tx("“{want}” could be {models}, so {model} does “{step}”.", vars) : tx("“{want}” isn't available here, so {model} does “{step}”.", vars));
    }
    return {
      id,
      title: String(p?.title || id).trim().slice(0, 120),
      model: model || "",
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
  if (!order) return { error: tx("The plan's steps wait on each other in a circle.") };
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
function parsePlan(text, plannerModel) {
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
  return { error: lastError ?? tx("The answer has no plan in it.") };
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
        return tx("_(The plan is on the board above.)_");
      });
    }
    return changed ? JSON.stringify(ev) : line;
  } catch { return line; }
}

// ---------- prompts ----------
function plannerPrompt(T, goal) {
  const models = taskModels().map((m) => `- ${m} (${providerName(providerOf(m))})`).join("\n");
  return `Plan this task for a team of coding agents working in ${tildify(T.cwd)}.

The task:
${goal}

Look around the folder first if that helps, but don't change anything: other agents do the work.

Split the task into steps (usually 2 to 6). Each step is one prompt for one agent, so make each prompt complete: the agent sees only its prompt and the results of the steps it needs. A step can use the results of earlier steps (list their ids in "needs"); steps that don't need each other can run at the same time. Mark steps that only read, research or review with "edits": false. Steps that change files run one after another.

Each step runs Paw's own coding agent (it reads, searches, edits files and runs commands) on the model you give it. Models you can give steps to:
${models}

Explain the plan in a few lines, then end your answer with the plan as JSON in a \`\`\`json block, in exactly this shape:
\`\`\`json
{"title": "short name for the task", "steps": [
  {"id": "short-id", "title": "what this step does", "model": "provider/model", "needs": [], "edits": true, "prompt": "complete instructions for this step"}
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
async function newTask({ model, cwd, goal, atts = [] } = {}) {
  // The planner is Paw Agent on the tab's model (or the default one), at its read-only level.
  model = (providerOf(model) ? model : "") || defaultPawModel();
  if (!model) { invoke("open_preferences", { tab: "agents" }); return null; }
  const task = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: "", goal: "", state: "new", steps: [], selected: null, note: "", createdAt: Date.now(),
  };
  const T = await newSession("paw", { model, cwd, approval: "plan", task });
  if (T && (goal?.trim() || atts.length)) await taskSubmit(T, (goal ?? "").trim(), atts);
  return T;
}

function taskBanner(S) {
  info(S, tx('<b>New plan</b> <span class="dim">by</span> {agent} <span class="dim">on</span> {model}  <span class="dim">in</span> {cwd}', { agent: esc(S.agent.name), model: esc(modelShort(S.model) || tx("no model")), cwd: esc(tildify(S.cwd)) }) + "\n" +
    `<span class="dim">${tx("Describe what you want done below. {agent} splits it into steps, each on one of your models; you review the plan before anything runs.", { agent: esc(S.agent.name) })}</span>`);
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
    (t.plans ??= []).push({ at: Date.now() });
    t.note = "";
    taskChanged(S);
    return sendToAgent(S, text, atts, { wrap: (x) => plannerPrompt(S, x) });
  }
  if (t.state === "draft") {
    t.state = "planning";
    (t.plans ??= []).push({ at: Date.now() });
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
  if (S.factory) loadFactories(); // its agent may have changed the file
  if (S.task) return plannerTurnEnded(S, r);
  const link = stepOfTab(S);
  if (!link) return;
  const { T, st } = link;
  if (st.state !== "running" && st.state !== "blocked") return; // you talking to a finished step
  if (hasPendingApproval(S)) {
    st.state = "blocked"; // waits for the approval card in its tab
    return taskChanged(T);
  }
  if (r.stopped) st.state = "stopped";
  else if (!r.ok) { st.state = "failed"; st.error = String(r.error || r.text || tx("The agent reported an error.")).slice(0, 2000); }
  else { st.state = "done"; st.result = String(r.text ?? "").trim(); st.error = null; }
  closeRun(st);
  taskPump(T);
}

function plannerTurnEnded(S, r) {
  const t = S.task;
  if (t.state !== "planning") return;
  t.state = "draft";
  closeSpan(t.plans, r.stopped ? "stopped" : r.ok ? "done" : "failed");
  if (r.stopped) t.note = tx("Planning stopped. Describe what you want below to plan again.");
  else if (!r.ok) t.note = tx("Planning failed; the planner's output is below. Ask again below.");
  else {
    const plan = parsePlan(r.text, S.model);
    if (plan.error) t.note = tx("{error} Ask the planner again below, for example “give me the plan as JSON”.", { error: plan.error });
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

/** The last span of `spans` that's still open ends now, as `state`. */
function closeSpan(spans, state) {
  const r = spans?.at(-1);
  if (r && r.end == null) { r.end = Date.now(); r.state = state; }
}
/** The step's run ends now; its state says how. */
function closeRun(st) {
  st.endedAt = Date.now();
  closeSpan(st.runs, st.state);
}

// ---------- tokens ----------
// A finished turn's tokens go to what it worked for: the planner, or a step.
// The turn under way adds its live count. Agents that report no usage
// (only Claude Code and Paw Agent do) leave nothing.
const noTokens = () => ({ input: 0, output: 0 });
function taskUsage(S, u) {
  if (!u || !(u.input || u.output)) return;
  const add = (o) => { o.input += u.input; o.output += u.output; };
  if (S.task) return add(S.task.planTokens ??= noTokens());
  const link = stepOfTab(S);
  if (link) add(link.st.tokens ??= noTokens());
}
/** `base` plus the live turn of tab `C`, and whether anything was reported. */
function withLive(base, C) {
  const live = C?.turnStarted ? C.turnUsage : null;
  return { input: (base?.input ?? 0) + (live?.input ?? 0), output: (base?.output ?? 0) + (live?.output ?? 0), known: !!(base || live?.input || live?.output) };
}
const stepTokens = (st) => withLive(st.tokens, activeStep(st) ? sessions.get(st.sid) : null);
const planTokens = (T) => withLive(T.task.planTokens, T.task.state === "planning" ? T : null);
function taskTokens(T) {
  const all = [planTokens(T), ...T.task.steps.map(stepTokens)];
  return { input: all.reduce((n, x) => n + x.input, 0), output: all.reduce((n, x) => n + x.output, 0), known: all.some((x) => x.known) };
}

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
    closeRun(s);
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
      t.note = t.state === "failed" ? tx("A step failed. Retry it, skip it, or change it and run again.") : "";
    }
  }
  taskChanged(T);
}

async function startStep(T, st) {
  st.state = "running";
  st.startedAt = Date.now();
  st.endedAt = null;
  (st.runs ??= []).push({ at: st.startedAt });
  st.error = null;
  taskChanged(T);
  let C = st.sid != null ? sessions.get(st.sid) : null;
  if (!C) {
    if (CLI_AGENTS && st.agent && !st.model) {
      // Deprecated: CLI agents (CLI_AGENTS). Steps from before models named an agent.
      const agent = settings.agents.find((a) => a.id === st.agent);
      if (!agent) return stepFailed(T, st, tx("{agent} isn't set up in Paw any more.", { agent: agentName(st.agent) }));
      // Read-only steps: Paw Agent's read-only level; other agents ask first.
      const approval = st.edits ? undefined : isPaw(agent) ? "plan" : approvalLevels(agent).includes("ask") ? "ask" : undefined;
      C = await newSession(agent.id, { cwd: T.cwd, background: true, after: T, approval, stepOf: { task: T.task.id, step: st.id } });
      if (!C) return stepFailed(T, st, tx("Couldn't open a tab for {name}.", { name: agentName(st.agent) }));
    } else {
      // A step without a model (or from before models) runs on the default one.
      st.model = savedModel(st.model);
      delete st.agent;
      if (!st.model) return stepFailed(T, st, tx("No model to run this step on: connect a provider in Settings › Agents."));
      // Read-only steps run at Paw Agent's read-only level.
      C = await newSession("paw", { model: st.model, cwd: T.cwd, background: true, after: T, approval: st.edits ? undefined : "plan", stepOf: { task: T.task.id, step: st.id } });
      if (!C) return stepFailed(T, st, tx("Couldn't open a tab for {name}.", { name: modelShort(st.model) }));
    }
    st.sid = C.sid;
  }
  if (!activeStep(st)) return; // stopped while its tab was opening
  // Its slot was counted when the step started (slot: true skips the queue).
  await sendToAgent(C, st.prompt, [], { wrap: (x) => stepPrompt(T, st, x), slot: true });
}

function stepFailed(T, st, why) {
  st.state = "failed";
  st.error = why;
  closeRun(st);
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
  if (activeStep(st)) { st.state = "stopped"; closeRun(st); }
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
    // Steps name a model; a bare id is matched, and one from before models (an agent) gets the default model.
    if (s.model || !CLI_AGENTS) { s.model = savedModel(s.model); delete s.agent; }
    if (activeStep(s) && !live) { s.state = "stopped"; closeRun(s); }
  }
  if (live) return t;
  if (t.state === "planning") { closeSpan(t.plans, "stopped"); t.state = t.goal ? "draft" : "new"; t.note = t.goal ? tx("Paw restarted while planning. Ask the planner again below.") : ""; }
  if (t.state === "running") { t.state = "stopped"; t.note = tx("Paw restarted while this plan ran. Press Run to carry on where it stopped."); }
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
  const name = t.title || tx("New plan");
  if (t.state === "running") {
    const n = t.steps.filter(activeStep).length;
    return tx("{name} · {n} running", { name, n });
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
    new: tx("Describe what you want done, and the planner splits it into steps…"),
    planning: tx("Planning… (⌘. to stop)"),
    draft: tx("Change the plan: add a step, use Copilot for the UI step, re-plan…"),
    running: tx("Ask the planner something…"),
  }[S.task.state] ?? tx("Ask the planner something…");
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
    case "new": return tx("Waiting for your goal");
    case "planning": return tx("Planning…");
    case "draft": return n ? (n > 1 ? tx("Draft · {n} steps", { n }) : tx("Draft · {n} step", { n })) : tx("No steps yet");
    case "running": return tx("Running · {done} of {n} done", { done, n });
    case "done": return n > 1 ? tx("Done · {n} steps", { n }) : tx("Done · {n} step", { n });
    case "failed": return tx("Stopped on a failed step · {done} of {n} done", { done, n });
    case "stopped": return tx("Stopped · {done} of {n} done", { done, n });
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
  // A factory tab has its own board (factories.js).
  if (S?.factory) { renderTaskLower(S); return renderFactoryView(S, host); }
  const t = S?.task;
  host.classList.toggle("hidden", !t);
  renderTaskLower(S);
  if (!t) { host.innerHTML = ""; $("task-split")?.classList.add("hidden"); return; }
  // Sizes the user dragged (the dividers): the board's height, the details' width.
  $("task-split")?.classList.toggle("hidden", !t);
  applyBoardSizes(host);
  if (host.dataset.dragging) return; // a divider is being dragged
  // Don't rebuild under the user's typing (the step editor is part of it).
  if (host.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) {
    updateTaskTimes(host, t);
    return;
  }
  const scroll = host.querySelector(".tk-graph")?.scrollLeft ?? 0;
  const canRun = t.steps.length && ["draft", "stopped", "failed"].includes(t.state);
  const buttons = [
    canRun && `<button class="tk-btn primary" data-act="run">${t.state === "draft" ? tx("Run") : tx("Run again")}</button>`,
    t.state === "running" && `<button class="tk-btn" data-act="stop">${tx("Stop")}</button>`,
    t.state === "planning" && `<button class="tk-btn" data-act="stop-plan">${tx("Stop planning")}</button>`,
    t.state === "draft" && t.steps.length > 0 && `<button class="tk-btn" data-act="add">${tx("Add step")}</button>`,
  ].filter(Boolean).join("");
  // Views plugins add (Settings › Plugins), next to the graph.
  const views = t.steps.length ? boardViews() : [];
  let viewKey = S.boardView && views.some(([k]) => k === S.boardView) ? S.boardView : "graph";
  if (viewKey === "graph" && S.view) closeBoardView(S);
  const switcher = views.length ? `<div class="tk-views" role="tablist">${[["graph", { label: tx("Graph") }], ...views].map(([k, v]) =>
    `<button class="tk-viewbtn${k === viewKey ? " on" : ""}" data-view="${esc(k)}">${esc(v.label)}</button>`).join("")}</div>` : "";
  const head = `<div class="tk-head">
      <span class="tk-title" title="${esc(t.goal)}">${esc(t.title || tx("New plan"))}</span>
      <span class="tk-state st-${esc(t.state)}">${esc(taskStatusText(t))}</span>
      ${switcher}<span class="grow"></span>${buttons}
    </div>${t.note ? `<div class="tk-note">${esc(t.note)}</div>` : ""}`;
  let body;
  if (t.state === "new" || (!t.steps.length && t.state !== "planning")) {
    body = `<div class="tk-empty">${t.state === "new"
      ? tx("Describe what you want done in the prompt box below. {agent} splits it into steps for your agents, and you check the plan before anything runs.", { agent: esc(S.agent.name) })
      : tx("No steps yet.")}</div>`;
  } else if (!t.steps.length) {
    body = `<div class="tk-empty"><span class="spin-ch">${SPIN[spinFrame % SPIN.length]}</span> ${tx("{agent} is planning…", { agent: esc(S.agent.name) })}</div>`;
  } else {
    const vsplit = `<div class="tk-vsplit" title="${esc(tx("Drag to resize · double-click to reset"))}"></div>`;
    body = viewKey === "graph"
      ? `<div class="tk-body"><div class="tk-graph">${graphHtml(t)}</div>${vsplit}<aside class="tk-side">${sideHtml(S)}</aside></div>`
      : `<div class="tk-body"><div class="tk-viewslot"></div>${vsplit}<aside class="tk-side">${sideHtml(S)}</aside></div>`;
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

// ---------- the lower half: stream or timeline ----------
// A task tab shows the planner's stream below the board, or the timeline of
// everything that ran: planning, then each step's runs on one time axis,
// with the task's token budget and what it has used beside it.
function renderTaskLower(S) {
  const lower = $("task-lower"), tl = $("task-timeline"), term = $("terminal");
  if (!lower || !tl) return;
  const t = S?.task ?? S?.factory;
  const timeline = !!t && S.lowerView === "timeline";
  lower.classList.toggle("hidden", !t);
  for (const b of lower.querySelectorAll("[data-lower]")) b.classList.toggle("on", b.dataset.lower === (timeline ? "timeline" : "stream"));
  term?.classList.toggle("tk-tl", timeline);
  tl.classList.toggle("hidden", !timeline);
  if (!timeline) { tl.innerHTML = ""; return; }
  // Not under the user's typing (the budget).
  if (tl.contains(document.activeElement) && document.activeElement.matches("input")) return;
  const rows = tl.querySelector(".tl-rows");
  const scroll = rows?.scrollTop ?? 0;
  tl.innerHTML = S.task ? timelineHtml(S) : factoryTimelineHtml(S);
  const again = tl.querySelector(".tl-rows");
  if (again) again.scrollTop = scroll;
}

/** A tick every 1, 2, 5, 10… seconds or minutes: about eight across `ms`. */
function tickStep(ms) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);
  return steps.find((s) => ms / s <= 8) ?? 14_400_000;
}
/** A tick's time from the start: 45s, 1m, 1m30s, 2h. */
function fmtTick(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s / 60}m`;
  const m = Math.round(s / 60);
  return m % 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m / 60}h`;
}
const fmtCount = (n) => Math.round(n).toLocaleString("en-US");

/** Every row: the planner's spans, then each step's runs (an older step without runs: its last one). */
function timelineRows(T) {
  const t = T.task;
  const rows = [];
  if (t.plans?.length) {
    const last = t.plans.at(-1);
    rows.push({
      id: null, name: tx("Planning"), agent: modelShort(T.model) || T.agent.name, level: 0, view: last.end == null ? "running" : last.state ?? "done",
      spans: t.plans.map((p) => ({ at: p.at, end: p.end, view: p.end == null ? "running" : p.state ?? "done" })),
      tokens: planTokens(T),
    });
  }
  const level = stepLevels(t.steps);
  for (const s of t.steps) {
    const view = stepView(s);
    const runs = s.runs?.length ? s.runs : s.startedAt ? [{ at: s.startedAt, end: s.endedAt, state: s.state }] : [];
    rows.push({
      id: s.id, name: s.title, agent: stepModelName(s), level: level.get(s.id) ?? 0, view,
      spans: runs.map((r, i) => ({ at: r.at, end: r.end, view: r.end == null ? (i === runs.length - 1 ? view : "stopped") : r.state ?? "done" })),
      tokens: stepTokens(s),
    });
  }
  return rows;
}

function timelineHtml(T) {
  return timelineCore({
    rows: timelineRows(T), selected: T.task.selected, side: budgetHtml(T),
    empty: tx("Nothing has run yet. Planning and the steps show here as they run, on one time line."),
    foot: (total) => timelineSummary(T, total),
  });
}

/** Rows on one time axis, with a side panel: tasks' and factories' timelines. */
function timelineCore({ rows, selected, side, empty, foot, label = tx("step"), legend = [], again = tx("runs") }) {
  const now = Date.now();
  const spans = rows.flatMap((r) => r.spans);
  if (!spans.length) {
    return `<div class="tl-wrap"><div class="tl-main"><div class="tl-empty">${esc(empty)}</div></div>${side}</div>${legendHtml(legend)}`;
  }
  const t0 = Math.min(...spans.map((s) => s.at));
  const t1 = Math.max(...spans.map((s) => s.end ?? now), t0 + 1000);
  const total = t1 - t0;
  const pct = (ms) => `${((ms / total) * 100).toFixed(3)}%`;
  const step = tickStep(total);
  const ticks = [];
  for (let ms = 0; ms <= total; ms += step) ticks.push(`<span class="tl-tick" style="left:${pct(ms)}">${fmtTick(ms)}</span>`);
  const rowHtml = (r) => {
    const dur = r.spans.reduce((n, s) => n + ((s.end ?? now) - s.at), 0);
    const bars = r.spans.map((s) => {
      const w = Math.max((s.end ?? now) - s.at, 0);
      return `<span class="tl-bar v-${esc(s.view)}" style="left:${pct(s.at - t0)};width:max(3px, ${pct(w)})" title="${esc(STEP_STATE_TEXT[s.view] ?? s.view)} · ${esc(fmtElapsed(w))}"></span>`;
    }).join("");
    const runs = r.spans.length > 1 ? `<span class="tl-tag">${r.spans.length} ${again}</span>` : "";
    return `<div class="tl-row${r.id && r.id === selected ? " sel" : ""}"${r.id ? ` data-step="${esc(r.id)}"` : ""}>
      <div class="tl-lbl" style="padding-left:${8 + r.level * 8}px">
        <span class="tl-name" title="${esc(r.name)} · ${esc(r.agent)}">${esc(r.name)}</span>
        <span class="tl-tag v-${esc(r.view)}">${esc(STEP_STATE_TEXT[r.view] ?? r.view)}</span>${runs}
        <span class="tl-grow"></span>
        <span class="tl-tok" title="${r.tokens.known ? esc(tx("{in} in · {out} out", { in: fmtCount(r.tokens.input), out: fmtCount(r.tokens.output) })) : esc(tx("{agent} reports no tokens", { agent: r.agent }))}">${r.tokens.known ? fmtTokens(r.tokens.input + r.tokens.output) : "–"}</span>
        <span class="tl-dur">${r.spans.length ? esc(fmtElapsed(dur)) : ""}</span>
      </div>
      <div class="tl-track">${bars}</div>
    </div>`;
  };
  return `<div class="tl-wrap"><div class="tl-main">
      <div class="tl-head"><div class="tl-lbl"><span class="tl-name">${esc(label)}</span><span class="tl-grow"></span><span class="tl-tok">${esc(tx("tokens"))}</span><span class="tl-dur">${esc(tx("time"))}</span></div><div class="tl-axis">${ticks.join("")}</div></div>
      <div class="tl-rows">${rows.map(rowHtml).join("")}</div>
      <div class="tl-foot">${esc(foot(total))}</div>
    </div>${side}</div>${legendHtml(legend)}`;
}

function timelineSummary(T, total) {
  const s = T.task.steps;
  const count = (st) => s.filter((x) => x.state === st).length;
  const retried = s.filter((x) => (x.runs?.length ?? 0) > 1).length;
  const parts = [s.length === 1 ? tx("{n} step", { n: 1 }) : tx("{n} steps", { n: s.length })];
  const words = { done: (n) => tx("{n} done", { n }), running: (n) => tx("{n} running", { n }), failed: (n) => tx("{n} failed", { n }), stopped: (n) => tx("{n} stopped", { n }), skipped: (n) => tx("{n} skipped", { n }) };
  for (const st of ["done", "running", "failed", "stopped", "skipped"]) {
    const n = st === "running" ? s.filter(activeStep).length : count(st);
    if (n && !(st === "done" && n === s.length)) parts.push(words[st](n));
  }
  if (retried) parts.push(tx("{n} retried", { n: retried }));
  const head = T.task.state === "done" ? tx("Done in {time}", { time: fmtElapsed(total) }) : `${taskStatusText(T.task)} · ${fmtElapsed(total)}`;
  return `${head}: ${parts.join(", ")}.`;
}

/** "40k", "1.5M", "40,000": tokens; null when it isn't a number. */
function parseTokens(s) {
  const m = String(s).trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
}

function budgetHtml(T) {
  const t = T.task;
  const used = taskTokens(T);
  const sum = used.input + used.output;
  const budget = t.budget > 0 ? t.budget : 0;
  const share = budget ? Math.min(1, sum / budget) : 0;
  const over = budget && sum > budget;
  const elapsedFrom = t.plans?.[0]?.at ?? t.startedAt;
  const elapsed = elapsedFrom ? (t.endedAt && t.state === "done" ? t.endedAt : Date.now()) - elapsedFrom : 0;
  const done = t.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const running = t.steps.filter(activeStep).length;
  return `<aside class="tl-side">
      <div class="tl-k">${tx("Budget")} <button class="tl-link" data-act="budget">${budget ? tx("Change") : tx("Set")}</button></div>
      ${budget ? `<div class="tl-meter${over ? " over" : ""}"><span style="width:${(share * 100).toFixed(1)}%"></span></div>` : ""}
      <div class="tl-big"><span data-budget-used>${fmtCount(sum)}</span>${budget ? ` <span class="tl-of">/ <span data-budget>${fmtCount(budget)}</span> ${tx("tokens")}</span>` : ` <span class="tl-of">${tx("tokens")}</span>`}</div>
      <div class="tl-sub">${used.known ? tx("{in} in · {out} out", { in: fmtCount(used.input), out: fmtCount(used.output) }) : tx("No agent here reports its tokens yet.")}${over ? ` · <span class="tl-over">${tx("{n} over", { n: fmtCount(sum - budget) })}</span>` : ""}</div>
      <div class="tl-grid2">
        <div><div class="tl-k">${tx("Elapsed")}</div><div class="tl-v">${elapsed ? esc(fmtElapsed(elapsed)) : "–"}</div></div>
        <div><div class="tl-k">${tx("Steps")}</div><div class="tl-v">${tx("{done} of {n}", { done, n: t.steps.length })}</div></div>
        <div><div class="tl-k">${tx("Running")}</div><div class="tl-v">${running}</div></div>
        <div><div class="tl-k">${tx("Planning")}</div><div class="tl-v">${planTokens(T).known ? fmtTokens(planTokens(T).input + planTokens(T).output) : "–"}</div></div>
      </div>
      <div class="tl-k">${tx("Outcome")}</div>
      <div class="tk-state st-${esc(t.state)}">${esc(taskStatusText(t))}</div>
    </aside>`;
}

function legendHtml(extra = []) {
  const items = [["running", tx("running")], ["done", tx("done")], ["needs", tx("needs you")], ...extra, ["failed", tx("failed")], ["stopped", tx("stopped")], ["skipped", tx("skipped")]];
  return `<div class="tl-legend">${items.map(([v, label]) => `<span><i class="tl-swatch v-${v}"></i>${label}</span>`).join("")}</div>`;
}

// ---------- resizing the board ----------
// Two dividers: under the board (its height against the transcript) and
// between the graph and the step's details (their width). The sizes are
// kept for every task tab; double-click a divider for the default.
const BOARD_KEY = "paw.taskBoard";
function boardSizes() {
  try { return JSON.parse(localStorage.getItem(BOARD_KEY)) || {}; } catch { return {}; }
}
function saveBoardSizes(s) {
  try { localStorage.setItem(BOARD_KEY, JSON.stringify(s)); } catch { /* not kept */ }
}
function applyBoardSizes(host) {
  const s = boardSizes();
  if (s.side) host.style.setProperty("--tk-side-w", `${s.side}px`);
  else host.style.removeProperty("--tk-side-w");
  // The board's height as a share of the tab, so it fits any window size.
  if (s.height) { host.style.height = `${(s.height * 100).toFixed(2)}%`; host.classList.add("sized"); }
  else { host.style.removeProperty("height"); host.classList.remove("sized"); }
}

/** Drag from pointerdown until the button is released (the document follows it). */
function dragging(e, host, move, done) {
  e.preventDefault();
  host.dataset.dragging = "1";
  document.querySelector(".app")?.classList.add("resizing");
  e.target.classList.add("dragging");
  const handle = e.target;
  const mv = (ev) => move(ev);
  const up = (ev) => {
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    delete host.dataset.dragging;
    document.querySelector(".app")?.classList.remove("resizing");
    handle.classList.remove("dragging");
    done(ev);
  };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
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
      <span class="tk-node-sub"><span class="tk-dot v-${v}"></span>${esc(stepModelName(s))} · ${esc(STEP_STATE_TEXT[v] ?? v)}${time && v !== "waiting" ? ` · <span data-time="${esc(s.id)}">${esc(time)}</span>` : ""}${s.edits ? "" : ` · <span class="tk-ro">${tx("reads")}</span>`}${s.badge ? ` · <span class="tk-round">${esc(s.badge)}</span>` : ""}</span>
    </button>`;
  }).join("")}</div>`).join("");
}

/** Curves from each step to the steps that need it. */
function drawEdges(g, t) {
  const svg = g.querySelector(".tk-edges");
  if (!svg) return;
  const box = g.getBoundingClientRect();
  // A zoomed graph (a factory's): measure on screen, draw in its own unscaled space.
  const z = Number(g.dataset.zoom) || 1;
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
      const x1 = (from.right - box.left) / z + g.scrollLeft, y1 = (from.top + from.height / 2 - box.top) / z + g.scrollTop;
      const x2 = (to.left - box.left) / z + g.scrollLeft, y2 = (to.top + to.height / 2 - box.top) / z + g.scrollTop;
      const dx = Math.max(16, (x2 - x1) / 2);
      const live = stepView(s) === "running" || stepView(s) === "needs";
      // A factory's branch: the node runs only if this input's answer matches.
      const cond = s.condFrom === n ? " cond" : "";
      paths += `<path class="${live ? "live" : ""}${cond}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
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
    parts.push(`<label class="tk-lbl">${tx("Step")}</label><input class="tk-in" data-field="title" value="${esc(st.title)}" spellcheck="false">`);
    parts.push(`<label class="tk-lbl">${tx("Model")}</label><select class="tk-in" data-field="model">${modelOptions(st.model)}</select>`);
    parts.push(`<label class="tk-check"><input type="checkbox" data-field="edits"${st.edits ? " checked" : ""}> ${tx("Changes files")}</label>`);
    parts.push(`<label class="tk-lbl">${tx("Gets the results of")}</label>${others.length ? others.map((o) =>
      `<label class="tk-check"><input type="checkbox" data-need="${esc(o.id)}"${st.needs.includes(o.id) ? " checked" : ""}> ${esc(o.title)}</label>`).join("")
      : `<span class="tk-dim">${tx("No other steps")}</span>`}`);
    parts.push(`<label class="tk-lbl">${tx("Prompt")}</label><textarea class="tk-in tk-prompt" data-field="prompt" spellcheck="false">${esc(st.prompt)}</textarea>`);
    parts.push(`<div class="tk-row"><button class="tk-btn danger" data-act="delete" data-id="${esc(st.id)}">${tx("Delete step")}</button></div>`);
  } else {
    parts.push(`<div class="tk-side-title">${esc(st.title)}</div>`);
    parts.push(`<div class="tk-dim"><span class="tk-dot v-${v}"></span>${esc(stepModelName(st))} · ${esc(STEP_STATE_TEXT[v] ?? v)}${stepTime(st) ? ` · ${esc(stepTime(st))}` : ""}${st.edits ? "" : ` · ${tx("reads only")}`}</div>`);
    if (st.needs.length) parts.push(`<label class="tk-lbl">${tx("Gets the results of")}</label><div>${st.needs.map((n) => esc(t.steps.find((x) => x.id === n)?.title ?? n)).join(", ")}</div>`);
    const btns = [
      C && `<button class="tk-btn" data-act="open" data-id="${esc(st.id)}">${tx("Open its tab")}</button>`,
      ["failed", "stopped"].includes(st.state) && `<button class="tk-btn primary" data-act="retry" data-id="${esc(st.id)}">${tx("Retry")}</button>`,
      ["failed", "stopped", "waiting"].includes(st.state) && t.state !== "done" && `<button class="tk-btn" data-act="skip" data-id="${esc(st.id)}">${tx("Skip")}</button>`,
    ].filter(Boolean);
    if (btns.length) parts.push(`<div class="tk-row">${btns.join("")}</div>`);
    if (v === "needs") parts.push(`<div class="tk-warn">${tx("Waiting for your approval in its tab.")}</div>`);
    if (st.error) parts.push(`<label class="tk-lbl">${tx("What went wrong")}</label><div class="tk-err">${esc(st.error)}</div>`);
    if (st.result && st.state === "done") parts.push(`<label class="tk-lbl">${tx("Result")}</label><div class="tk-md">${renderMarkdown(clipEnd(st.result, 6000))}</div>`);
    parts.push(`<details class="tk-fold"><summary>${tx("Prompt")}</summary><div class="tk-pre">${esc(st.prompt)}</div></details>`);
  }
  return parts.join("");
}

/** The Model select's options, by provider; a step's model that isn't listed (hidden, or its provider left) stays. */
function modelOptions(cur) {
  const opt = (m) => `<option value="${esc(m)}"${m === cur ? " selected" : ""}>${esc(modelShort(m))}</option>`;
  const head = !cur ? `<option value="" selected>${esc(tx("default model"))}</option>` : visibleModels().includes(cur) ? "" : opt(cur);
  return head + modelsByProvider().map(([p, list]) => `<optgroup label="${esc(providerName(p))}">${list.map(opt).join("")}</optgroup>`).join("");
}

function taskSummaryHtml(S) {
  const t = S.task;
  const parts = [`<div class="tk-side-title">${tx("The goal")}</div><div class="tk-goal">${esc(t.goal)}</div>`,
    `<div class="tk-dim">${S.model ? tx("Planned by {agent} on {model}", { agent: esc(S.agent.name), model: esc(modelShort(S.model)) }) : tx("Planned by {agent}", { agent: esc(S.agent.name) })} · ${esc(tildify(S.cwd))}</div>`];
  if (t.state === "draft") parts.push(`<div class="tk-hint">${tx("Click a step to change it, or ask the planner below to change the plan. Steps that change files run one at a time; others run side by side, as many as Settings › General › Agents at once allows ({max}).", { max: maxAgents() === Infinity ? tx("no limit") : maxAgents() })}</div>`);
  if (t.state === "done") {
    // The steps nobody else needed: their answers are the task's outcome.
    const needed = new Set(t.steps.flatMap((s) => s.needs));
    const ends = t.steps.filter((s) => !needed.has(s.id) && s.state === "done");
    parts.push(`<label class="tk-lbl">${tx("Outcome")}</label>${ends.map((s) =>
      `<div class="tk-out"><div class="tk-dim">${esc(s.title)}</div><div class="tk-md">${renderMarkdown(clipEnd(String(s.result ?? ""), 4000))}</div></div>`).join("")}`);
    if (t.startedAt && t.endedAt) parts.push(`<div class="tk-dim">${tx("Took {time}", { time: esc(fmtElapsed(t.endedAt - t.startedAt)) })}</div>`);
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
  const split = withPane(P, () => $("task-split"));
  const S = () => sessions.get(P.sid);
  // Between the graph and the details: the details' width.
  host.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.target.classList?.contains("tk-vsplit")) return;
    const body = e.target.closest(".tk-body");
    let w = 0;
    dragging(e, host, (ev) => {
      const r = body.getBoundingClientRect();
      w = Math.round(Math.min(r.width - 240, Math.max(200, r.right - ev.clientX)));
      host.style.setProperty("--tk-side-w", `${w}px`);
    }, () => {
      if (w) saveBoardSizes({ ...boardSizes(), side: w });
      for (const Q of panes.values()) withPane(Q, renderTaskView);
    });
  });
  host.addEventListener("dblclick", (e) => {
    if (!e.target.classList?.contains("tk-vsplit")) return;
    const s = boardSizes();
    delete s.side;
    saveBoardSizes(s);
    for (const Q of panes.values()) withPane(Q, renderTaskView);
  });
  // Under the board: its height against the transcript.
  split?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const total = host.parentElement.getBoundingClientRect().height;
    let frac = 0;
    dragging(e, host, (ev) => {
      const top = host.getBoundingClientRect().top;
      const hpx = Math.min(total - 160, Math.max(120, ev.clientY - top));
      frac = hpx / total;
      host.style.height = `${(frac * 100).toFixed(2)}%`;
      host.classList.add("sized");
    }, () => {
      if (frac) saveBoardSizes({ ...boardSizes(), height: frac });
      for (const Q of panes.values()) withPane(Q, renderTaskView);
    });
  });
  split?.addEventListener("dblclick", () => {
    const s = boardSizes();
    delete s.height;
    saveBoardSizes(s);
    for (const Q of panes.values()) withPane(Q, renderTaskView);
  });
  // A factory's diagram: ⌘-scroll or pinch zooms it.
  host.addEventListener("wheel", (e) => { const T = S(); if (T?.factory) factoryWheel(T, e, host); }, { passive: false });
  host.addEventListener("click", (e) => {
    const T = S();
    if (T?.factory) return factoryClick(T, e, P);
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
        t.steps.push({ id, title: tx("New step"), model: T.model || defaultPawModel(), needs: [], edits: true, prompt: "", state: "waiting" });
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
    else if (el.dataset.field === "model") st.model = el.value;
    else if (el.dataset.field === "prompt") st.prompt = el.value;
    else return;
    saveWorkspaceSoon();
    if (rerender) { el.blur(); taskChanged(T); }
  };
  host.addEventListener("input", (e) => { if (S()?.factory) return factoryInput(S(), e); if (e.target.matches("input[type=text], input:not([type]), textarea")) edit(e, false); });
  host.addEventListener("change", (e) => { const T = S(); if (T?.factory) return factoryChange(T, e, P); edit(e, true); });
  host.addEventListener("focusout", (e) => {
    // Titles show in the graph: redraw when you leave the field.
    if (e.target.dataset?.field === "title") setTimeout(() => { const T = S(); if (T?.task) withPane(P, renderTaskView); }, 0);
  });
  // Below the board: the stream or the timeline, and the timeline's controls.
  const lower = withPane(P, () => $("task-lower"));
  const tl = withPane(P, () => $("task-timeline"));
  lower?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-lower]");
    const T = S();
    if (!b || !(T?.task || T?.factory)) return;
    T.lowerView = b.dataset.lower;
    withPane(P, renderTaskView);
  });
  tl?.addEventListener("click", (e) => {
    const T = S();
    // A factory's timeline: a row selects its node.
    if (T?.factory) {
      const row = e.target.closest(".tl-row[data-step]");
      if (row) { T.factory.selected = T.factory.selected === row.dataset.step ? null : row.dataset.step; withPane(P, renderTaskView); }
      return;
    }
    const t = T?.task;
    if (!t) return;
    if (e.target.closest('[data-act="budget"]')) {
      const el = tl.querySelector(".tl-big");
      if (!el) return;
      editInPlace(el, t.budget > 0 ? fmtCount(t.budget) : "", (text) => {
        if (text === "") delete t.budget;
        else if (text != null && parseTokens(text) > 0) t.budget = parseTokens(text);
        saveWorkspaceSoon();
        withPane(P, renderTaskView);
      });
      const input = tl.querySelector(".inplace-input");
      if (input) input.placeholder = tx("Tokens, e.g. 40k or 1.5M (empty: no budget)");
      return;
    }
    const row = e.target.closest(".tl-row[data-step]");
    if (row) {
      t.selected = t.selected === row.dataset.step ? null : row.dataset.step;
      withPane(P, renderTaskView);
    }
  });
  tl?.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".tl-row[data-step]");
    const st = row && S()?.task?.steps.find((s) => s.id === row.dataset.step);
    if (st?.sid != null && sessions.has(st.sid)) select(st.sid);
  });
  new ResizeObserver(() => {
    const T = S();
    const g = host.querySelector(".tk-graph");
    if (T?.task && g) drawEdges(g, T.task);
    // A factory's diagram: its lines are drawn in the zoomed box; Fit follows the view's size.
    if (T?.factory && g) { drawFactoryEdges(g.querySelector(".fa-zoom") ?? g, T); applyZoom(host, T); }
  }).observe(host);
}

// Running steps' times and states tick on screen.
setInterval(() => {
  for (const P of panes.values()) {
    const T = sessions.get(P.sid);
    // A factory's run going: its times tick too.
    if (T?.factory && runsOf(T.factory.id)[0]?.state === "running") { withPane(P, renderTaskView); continue; }
    if (!T?.task) continue;
    if (T.task.state === "running" || (T.task.state === "planning" && T.lowerView === "timeline")) withPane(P, renderTaskView);
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
  if (!tasks.length) return tx('<span class="dim">No plans yet. Make one with</span> <span class="cmd">/plan &lt;what&gt;</span> <span class="dim">or select text, right-click, Make a plan.</span>');
  const glyph = { running: "●", planning: "●", done: "✓", failed: "✗", stopped: "■", draft: "◇", new: "◇" };
  const cls = { running: "ok", planning: "ok", done: "ok", failed: "err", stopped: "warn", draft: "dim", new: "dim" };
  const rows = tasks.map((T) => {
    const t = T.task;
    const steps = t.steps;
    const count = (v) => steps.filter((st) => stepView(st) === v).length;
    const done = steps.filter((st) => st.state === "done" || st.state === "skipped").length;
    const bits = [];
    if (t.state === "planning") bits.push(tx("planning…"));
    else if (!steps.length) bits.push(tx("no steps yet"));
    else if (t.state === "draft") bits.push(steps.length === 1 ? tx("{n} step planned", { n: 1 }) : tx("{n} steps planned", { n: steps.length }));
    else bits.push(tx("{done}/{n} steps", { done, n: steps.length }));
    if (t.state !== "draft") {
      if (count("running")) bits.push(tx("{n} running", { n: count("running") }));
      if (count("needs")) bits.push(`<span class="warn">${tx("{n} waiting for you", { n: count("needs") })}</span>`);
      if (count("failed")) bits.push(`<span class="err">${tx("{n} failed", { n: count("failed") })}</span>`);
    }
    const time = t.startedAt ? fmtElapsed((t.endedAt ?? Date.now()) - t.startedAt) : "";
    const title = t.title || t.goal?.split("\n")[0] || tx("New task");
    return `<span class="${cls[t.state] ?? "dim"}">${glyph[t.state] ?? "·"}</span> ` +
      `<a href="#" class="task-link" data-open-task="${esc(t.id)}" title="${esc(tx("Open this plan"))}">${esc(title.length > 48 ? title.slice(0, 47) + "…" : title)}</a>` +
      `  <span class="${cls[t.state] ?? "dim"}">${esc(TASK_STATE_TEXT[t.state] ?? t.state)}</span>  ${bits.join(" · ")}` +
      (time ? `  <span class="dim">${esc(time)}</span>` : "") +
      `  <span class="dim">${esc(modelShort(T.model) || T.agent.name)} · ${esc(tildify(T.cwd))}</span>`;
  });
  return `<span class="help-h">${tx("Plans ({n})", { n: tasks.length })}</span>\n${rows.join("\n")}`;
}

// A task's title in /tasks opens its tab (its group unfolds if it's folded).
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-open-task]");
  if (!a) return;
  e.preventDefault();
  const T = [...sessions.values()].find((S) => S.task?.id === a.dataset.openTask);
  if (!T) { const S = curS(); if (S) sys(S, tx("That plan's tab is closed.")); return; }
  const g = T.group ? groups.get(T.group) : null;
  if (g?.collapsed) g.collapsed = false;
  select(T.sid);
});

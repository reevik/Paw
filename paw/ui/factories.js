// Factories: pipelines of agent nodes described in YAML files
// (~/.paw/factories/<id>.yaml), run by Paw's background process, so they keep
// going while the window is closed (src-tauri/src/factories/runner.rs).
//
// A factory tab looks like a task tab: the factory's graph on top (click a
// node for its task, settings and last run beside it), and below, Paw Agent,
// who can change the factory file for you. Run now starts a run in the
// background; every change to a run comes back as a `factory:run` event.
//
// Loaded before app.js; everything here only runs when app.js calls it.

const factoryState = { dir: "", list: [], runs: new Map(), loaded: false, loading: null, triggers: { factories: {} } };

const RUN_STATE_TEXT = { running: "running", done: "done", failed: "failed", stopped: "stopped" };

/** The factory files and their runs, from the background process. */
function loadFactories() {
  factoryState.loading ??= invoke("factory_list")
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
    factoryState.runs.set(run.id, run);
    renderFactoryTabs();
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
const TRIGGER_WORD = { watch: "Watching", every: "Scheduled", at: "Scheduled", webhook: "Webhook", file: "Watching files" };

function factoryStatus(id) {
  const f = factoryById(id);
  const run = runsOf(id)[0];
  const t = triggerOf(id);
  if (f?.error) return "Can't be read · fix the file";
  if (run?.state === "running") return `Running · ${runProgress(run)}`;
  const trig = t ? (t.paused ? "Paused" : TRIGGER_WORD[t.kinds[0]] ?? "Armed") : "";
  const last = run ? `${RUN_STATE_TEXT[run.state] ?? run.state} ${fmtWhen(run.started_at)}` : f ? "never run" : "";
  return [trig, last].filter(Boolean).join(" · ");
}

/** "in 12m", "in 3h 5m". */
function fmtIn(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return m < 1 ? "in under a minute" : m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** The trigger part of a factory's summary: what starts it, and how it's doing. */
function triggerHtml(id, def) {
  const t = def.trigger;
  if (!t) return `<label class="tk-lbl">Trigger</label><div class="tk-dim">Manual: Run now. Add a trigger to the file (every, at, watch, webhook or file) to start runs on their own.</div>`;
  const st = triggerOf(id);
  const rows = [];
  if (t.watch) rows.push(`When <code>${esc(t.watch)}</code> starts succeeding (checked every ${esc(t.every)})`);
  else if (t.every) rows.push(`Every ${esc(t.every)}`);
  if (t.at) rows.push(`At ${esc(t.at)}`);
  if (t.file) rows.push(`When ${esc(st?.watching_file ? tildify(st.watching_file) : t.file)} changes`);
  if (t.webhook !== undefined && t.webhook !== false && t.webhook !== null) rows.push("When its webhook is called");
  const parts = [`<label class="tk-lbl">Trigger${st?.paused ? ` <span class="fa-paused">paused</span>` : ""}</label><div>${rows.join("<br>")}</div>`];
  if (!st) {
    parts.push(`<div class="tk-dim">Paw's background process hasn't picked this up yet.</div>`);
    return parts.join("");
  }
  const bits = [];
  if (st.next && !st.paused && !t.watch) bits.push(`Next run ${fmtIn(st.next)} (${fmtWhen(st.next)})`);
  if (st.last_check) bits.push(`Last check ${fmtWhen(st.last_check.at)}: ${st.last_check.ok ? "succeeded" : "not yet"}`);
  if (st.last_fired) bits.push(`${fmtWhen(st.last_fired)}: ${st.last_note}`);
  if (bits.length) parts.push(`<div class="tk-dim">${bits.map(esc).join("<br>")}</div>`);
  if (st.last_check?.output?.trim() && !st.last_check.ok) parts.push(`<details class="tk-fold"><summary>Check output</summary><div class="tk-pre">${esc(st.last_check.output.trim())}</div></details>`);
  if (st.webhook) {
    const token = st.webhook_secret ? ` -H "X-Paw-Token: <secret>"` : "";
    parts.push(`<div class="fa-hook"><div class="tk-dim">POST to</div><div class="tk-pre">${esc(st.webhook)}</div><div class="tk-dim">for example</div><div class="tk-pre">curl -X POST${esc(token)} -d @alert.json ${esc(st.webhook)}</div><div class="tk-dim">The body goes to the nodes as the trigger's payload.${st.webhook_secret ? " The secret from the file has to come along (X-Paw-Token, or ?token=)." : " Anything on this Mac can call it; give the webhook a secret to require one."}</div></div>`);
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
    body.innerHTML = `<div class="sk-empty">${factoryState.loaded ? "No factories yet. + makes one." : "…"}</div>`;
    return;
  }
  const open = new Set([...sessions.values()].filter((S) => S.factory && S.sid === activeId).map((S) => S.factory.id));
  body.innerHTML = list.map((f) => {
    const run = runsOf(f.id)[0];
    const dot = f.error ? "failed" : run?.state === "running" ? "running" : run?.state === "failed" ? "failed" : "idle";
    const needs = run?.state === "running" ? run.nodes.filter((n) => n.state === "needs").length : 0;
    return `<div class="nav-item${open.has(f.id) ? " active" : ""}" data-factory="${esc(f.id)}" title="${esc(f.factory?.description || tildify(f.path))}">
      <span class="dot ${dot}"></span>
      <span class="nav-text"><span class="nav-name">${esc(f.factory?.name || f.id)}</span><span class="nav-status">${esc(factoryStatus(f.id))}</span></span>
      ${needs ? `<span class="tab-badge">${needs}</span>` : ""}</div>`;
  }).join("");
}

document.addEventListener("click", (e) => {
  const row = e.target.closest?.("#factories-body [data-factory]");
  if (row) openFactory(row.dataset.factory);
});

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

/** The run a factory tab shows: the one picked, else the latest. */
function shownRun(S) {
  const runs = runsOf(S.factory.id);
  return (S.factory.run && runs.find((r) => r.id === S.factory.run)) || runs[0] || null;
}

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
    return openFactory(id);
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
  pushLine(S, { stream: "system", ts: Date.now(), text: `— factory ${S.factory.id}: ask ${S.agent.name} below to change it (nodes, prompts, models, triggers). Run now runs it in the background.` });
}

// ---------- the prompt: Paw Agent changes the factory file ----------
const FACTORY_FORMAT = `A factory file is YAML:
name: …            # required
description: …     # what it's for
folder: ~/path     # where the nodes work (default ~)
model: provider/model   # default model for nodes
approval: auto     # level for nodes that change files: ask, edits, auto, full
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
  - id: settle                 # a wait node: no prompt; holds the run until the command succeeds
    needs: [triage]
    wait: "curl -sf localhost:8080/health"
    every: 30s
    timeout: 10m
Nodes that don't need each other run side by side. A node whose inputs were all skipped is skipped too.`;

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
/** The factory (or a run of it) as the task board draws plans. */
function factoryPlan(S) {
  const f = factoryById(S.factory.id);
  const run = shownRun(S);
  const def = run?.def ?? f?.factory;
  if (!def) return null;
  const steps = def.nodes.map((n) => {
    const r = run?.nodes.find((x) => x.id === n.id);
    return {
      id: n.id,
      title: n.title?.trim() || n.id,
      needs: n.needs ?? [],
      condFrom: n.when?.from ?? null,
      state: r?.state ?? "waiting",
      model: n.wait ? "waits" : (n.model || def.model || ""),
      edits: n.wait ? true : n.edits !== false,
      startedAt: r?.started_at ?? null,
      endedAt: r?.ended_at ?? null,
    };
  });
  return { def, run, steps, selected: S.factory.selected };
}

function renderFactoryView(S, host) {
  host.classList.remove("hidden");
  $("task-split")?.classList.remove("hidden");
  applyBoardSizes(host);
  if (host.dataset.dragging) return;
  if (!factoryState.loaded) {
    if (!factoryState.loading) loadFactories();
    host.innerHTML = `<div class="tk-empty"><span class="spin-ch">${SPIN[spinFrame % SPIN.length]}</span> Reading the factory…</div>`;
    return;
  }
  const f = factoryById(S.factory.id);
  const plan = factoryPlan(S);
  const run = plan?.run;
  const runs = runsOf(S.factory.id);
  const running = runs.some((r) => r.state === "running");
  const state = run ? run.state : f?.error ? "failed" : "draft";
  const stateText = run ? `${RUN_STATE_TEXT[run.state] ?? run.state} · ${runProgress(run)}` : f?.error ? "can't run" : "ready";
  const buttons = [
    f?.factory && !running && `<button class="tk-btn primary" data-fact="run">Run now</button>`,
    running && `<button class="tk-btn" data-fact="stop">Stop</button>`,
    f?.factory?.trigger && triggerOf(S.factory.id) && `<button class="tk-btn" data-fact="pause" title="${triggerOf(S.factory.id).paused ? "Let the trigger start runs again" : "Stop the trigger from starting runs (Run now still works)"}">${triggerOf(S.factory.id).paused ? "Resume trigger" : "Pause trigger"}</button>`,
    f && `<button class="tk-btn" data-fact="edit" title="${esc(tildify(f.path))}">Edit file</button>`,
  ].filter(Boolean).join("");
  const picker = runs.length ? `<select class="tk-in fa-runs" data-fact="pick" title="Show a run">${
    `<option value=""${S.factory.run ? "" : " selected"}>Latest run</option>` +
    runs.map((r) => `<option value="${esc(r.id)}"${S.factory.run === r.id ? " selected" : ""}>${esc(fmtWhen(r.started_at))} · ${esc(RUN_STATE_TEXT[r.state] ?? r.state)}</option>`).join("")}</select>` : "";
  const head = `<div class="tk-head">
      <span class="tk-title fa-title" title="${esc(f?.factory?.description || "")}"><span class="fa-ico" aria-hidden="true"></span>${esc(f?.factory?.name || S.factory.id)}</span>
      <span class="tk-state st-${esc(state)}">${esc(stateText)}</span>
      ${picker}<span class="grow"></span>${buttons}
    </div>${run?.note ? `<div class="tk-note">${esc(run.note)}</div>` : ""}`;
  let body;
  if (!f && !run) {
    body = `<div class="tk-empty">There's no factory “${esc(S.factory.id)}” in ${esc(tildify(factoryState.dir))} any more.</div>`;
  } else if (!plan) {
    body = `<div class="tk-empty fa-broken"><b>${esc(f.id)}.yaml can't be read.</b><div class="tk-err">${esc(f.error ?? "")}</div><div class="tk-dim">Fix the file (Edit file), or ask ${esc(S.agent.name)} below to fix it.</div></div>`;
  } else {
    const vsplit = `<div class="tk-vsplit" title="Drag to resize · double-click to reset"></div>`;
    body = `<div class="tk-body"><div class="tk-graph">${graphHtml(plan)}</div>${vsplit}<aside class="tk-side">${factorySideHtml(S, plan, f)}</aside></div>`;
  }
  // Not under the user's typing; keep where the graph was scrolled.
  if (host.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
  const scroll = host.querySelector(".tk-graph")?.scrollLeft ?? 0;
  const sideScroll = host.querySelector(".tk-side")?.scrollTop ?? 0;
  host.innerHTML = head + body;
  const g = host.querySelector(".tk-graph");
  if (g) {
    g.scrollLeft = scroll;
    requestAnimationFrame(() => drawEdges(g, plan));
  }
  const side = host.querySelector(".tk-side");
  if (side) side.scrollTop = sideScroll;
}

function runProgress(run) {
  const done = run.nodes.filter((n) => n.state === "done" || n.state === "skipped").length;
  const needs = run.nodes.filter((n) => n.state === "needs").length;
  return `${done}/${run.nodes.length} nodes${needs ? ` · ${needs} waiting for you` : ""}`;
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
  parts.push(`<div class="tk-dim"><span class="tk-dot v-${esc(v)}"></span>${node.wait ? "wait node" : esc(stepModelName(st))} · ${esc(STEP_STATE_TEXT[v] ?? v)}${time && v !== "waiting" ? ` · ${esc(time)}` : ""}${!node.wait && node.edits === false ? " · reads only" : ""}</div>`);
  if (node.description?.trim()) parts.push(`<div class="fa-desc">${esc(node.description.trim())}</div>`);
  // How it's wired.
  const title = (id) => def.nodes.find((n) => n.id === id)?.title?.trim() || id;
  if (node.needs?.length) {
    parts.push(`<label class="tk-lbl">${node.join === "any" ? "Goes on when the first of these is done" : "Gets the results of"}</label><div>${node.needs.map((n) => esc(title(n))).join(", ")}</div>`);
  }
  if (node.when) {
    const w = node.when;
    parts.push(`<label class="tk-lbl">Runs only when</label><div>${esc(title(w.from))}'s answer ${[w.matches && `matches <code>${esc(w.matches)}</code>`, w.not_matches && `doesn't match <code>${esc(w.not_matches)}</code>`].filter(Boolean).join(" and ")}</div>`);
  }
  if (node.wait) {
    parts.push(`<label class="tk-lbl">Waits until this succeeds</label><div class="tk-pre">${esc(node.wait)}</div><div class="tk-dim">Checks every ${esc(node.every || "30s")}${node.timeout ? `, gives up after ${esc(node.timeout)}` : ""}${r?.checks ? ` · checked ${r.checks} time${r.checks === 1 ? "" : "s"}` : ""}</div>`);
  } else {
    const what = [
      node.skills && `<label class="tk-lbl">Skills</label><div>${node.skills.length ? chips(node.skills) : `<span class="tk-dim">none</span>`}</div>`,
      node.tools && `<label class="tk-lbl">Tools</label><div>${node.tools.length ? chips(node.tools) : `<span class="tk-dim">no built-in tools</span>`}</div>`,
      node.mcp && `<label class="tk-lbl">MCP servers</label><div>${node.mcp.length ? chips(node.mcp) : `<span class="tk-dim">none</span>`}</div>`,
    ].filter(Boolean);
    parts.push(what.length ? what.join("") : `<div class="tk-dim">All your skills, tools and MCP servers.</div>`);
    if (node.timeout) parts.push(`<div class="tk-dim">Gives up after ${esc(node.timeout)}</div>`);
  }
  // The run's side of it.
  if (r?.state === "needs" && r.approval) {
    const a = r.approval;
    parts.push(`<div class="fa-ask"><div><b>Waiting for your approval</b></div><div>${esc(a.label || a.tool || "A tool call")}</div>${a.detail ? `<div class="tk-pre">${esc(String(a.detail).slice(0, 1200))}</div>` : ""}${a.why ? `<div class="tk-dim">${esc(a.why)}</div>` : ""}
      <div class="tk-row"><button class="tk-btn primary" data-fact="approve" data-decision="once">Allow</button>${a.rule && !a.broad ? `<button class="tk-btn" data-fact="approve" data-decision="always" title="${esc(a.rule)}">Always allow</button>` : ""}<button class="tk-btn danger" data-fact="approve" data-decision="deny">Deny</button></div></div>`);
  }
  const btns = [
    run && ["failed", "stopped"].includes(v) && `<button class="tk-btn primary" data-fact="retry">Retry</button>`,
    run && ["failed", "stopped", "waiting"].includes(v) && run.state !== "done" && `<button class="tk-btn" data-fact="skip">Skip</button>`,
  ].filter(Boolean);
  if (btns.length) parts.push(`<div class="tk-row">${btns.join("")}</div>`);
  if (r?.note) parts.push(`<div class="tk-dim">${esc(r.note)}</div>`);
  if (r?.error) parts.push(`<label class="tk-lbl">What went wrong</label><div class="tk-err">${esc(r.error)}</div>`);
  if (r?.result && r.state === "done") parts.push(`<label class="tk-lbl">${node.wait ? "Output" : "Result"}</label><div class="tk-md">${renderMarkdown(clipEnd(r.result, 6000))}</div>`);
  if (r?.log?.length && r.state !== "done") {
    parts.push(`<label class="tk-lbl">Activity</label><div class="fa-log">${r.log.slice(-40).map((l) =>
      `<div class="fa-log-${esc(l.kind)}">${l.kind === "tool" ? "→ " : l.kind === "ask" ? "? " : ""}${esc(l.text)}</div>`).join("")}</div>`);
  }
  if (r?.input_tokens || r?.output_tokens) parts.push(`<div class="tk-dim">↑ ${esc(fmtTokens(r.input_tokens ?? 0))} ↓ ${esc(fmtTokens(r.output_tokens ?? 0))} tokens</div>`);
  if (!node.wait) parts.push(`<details class="tk-fold"${run ? "" : " open"}><summary>Prompt</summary><div class="tk-pre">${esc(node.prompt ?? "")}</div></details>`);
  return parts.join("");
}

function factorySummaryHtml(S, plan, f) {
  const { def, run } = plan;
  const parts = [`<div class="tk-side-title">${esc(def.name)}</div>`];
  if (def.description?.trim()) parts.push(`<div class="tk-goal">${esc(def.description.trim())}</div>`);
  parts.push(`<div class="tk-dim">${def.nodes.length} node${def.nodes.length === 1 ? "" : "s"} · works in ${esc(def.folder?.trim() || "~")}${def.model ? ` · ${esc(modelShort(def.model))}` : ""}</div>`);
  // The trigger as the file has it now (the run may be of an older version).
  parts.push(triggerHtml(S.factory.id, f?.factory ?? def));
  if (f && f.factory && f.factory !== def && JSON.stringify(f.factory) !== JSON.stringify(def)) {
    parts.push(`<div class="tk-hint">The file changed since this run started; the graph shows the run's version.</div>`);
  }
  if (f?.error && run) parts.push(`<div class="tk-warn">The file has a problem now: ${esc(f.error)}</div>`);
  if (run) {
    parts.push(`<label class="tk-lbl">This run</label><div class="tk-dim">Started ${esc(fmtWhen(run.started_at))} (${esc(run.trigger)})${run.ended_at ? ` · took ${esc(fmtElapsed(run.ended_at - run.started_at))}` : ""}</div>`);
    if (run.state === "done") {
      // The nodes nobody else needed: their answers are the run's outcome.
      const needed = new Set(def.nodes.flatMap((n) => n.needs ?? []));
      const ends = run.nodes.filter((n) => !needed.has(n.id) && n.state === "done");
      parts.push(`<label class="tk-lbl">Outcome</label>${ends.map((n) =>
        `<div class="tk-out"><div class="tk-dim">${esc(def.nodes.find((d) => d.id === n.id)?.title || n.id)}</div><div class="tk-md">${renderMarkdown(clipEnd(String(n.result ?? ""), 4000))}</div></div>`).join("")}`);
    }
  } else {
    parts.push(`<div class="tk-hint">Click a node to see its task. Run now runs the factory in the background: it keeps going if you close the window. Nodes that don't need each other run side by side, as many as Settings › General › Agents at once allows; nodes that change files run one at a time.</div>`);
  }
  parts.push(`<div class="tk-dim fa-path">${esc(tildify(f?.path ?? ""))}</div>`);
  return parts.join("");
}

/** Clicks on a factory board (bindTaskView passes them here). */
async function factoryClick(S, e, P) {
  const node = e.target.closest(".tk-node");
  if (node) {
    S.factory.selected = S.factory.selected === node.dataset.step ? null : node.dataset.step;
    saveWorkspaceSoon();
    withPane(P, renderTaskView);
    return;
  }
  const b = e.target.closest("[data-fact]");
  if (!b || b.tagName === "SELECT") return;
  const run = shownRun(S);
  const fail = (err) => sys(S, `✗ ${err}`);
  try {
    switch (b.dataset.fact) {
      case "run": {
        const id = await invoke("factory_run", { factory: S.factory.id, payload: null });
        S.factory.run = null; // follow it (the latest)
        await loadFactories();
        if (!factoryState.runs.has(id)) {
          const r = await invoke("factory_get", { run: id });
          if (r) factoryState.runs.set(id, r);
        }
        break;
      }
      case "stop": if (run) await invoke("factory_stop", { run: run.id }); break;
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
        break;
      }
    }
  } catch (err) {
    fail(err);
  }
  withPane(P, renderTaskView);
}

/** The run picker. */
function factoryChange(S, e, P) {
  if (!e.target.matches?.("select[data-fact=pick]")) return false;
  S.factory.run = e.target.value || null;
  saveWorkspaceSoon();
  withPane(P, renderTaskView);
  return true;
}

// ---------- /factories ----------
async function factoriesListHtml() {
  await loadFactories();
  const list = factoryState.list;
  const dir = tildify(factoryState.dir);
  if (!list.length) return `<span class="dim">No factories yet. Make one with</span> <span class="cmd">/factory new &lt;name&gt;</span> <span class="dim">(they live in ${esc(dir)}).</span>`;
  const glyph = { running: "●", done: "✓", failed: "✗", stopped: "■" };
  const cls = { running: "ok", done: "ok", failed: "err", stopped: "warn" };
  const rows = list.map((f) => {
    const run = runsOf(f.id)[0];
    const name = f.factory?.name || f.id;
    const what = f.error ? `<span class="err">can't be read: ${esc(f.error.length > 80 ? f.error.slice(0, 79) + "…" : f.error)}</span>`
      : `${f.factory.nodes.length} nodes` + (run ? ` · last run ${esc(fmtWhen(run.started_at))} <span class="${cls[run.state] ?? "dim"}">${esc(run.state)}</span>` : " · never run");
    return `<span class="${run ? cls[run.state] ?? "dim" : "dim"}">${run ? glyph[run.state] ?? "·" : "◇"}</span> ` +
      `<a href="#" class="task-link" data-open-factory="${esc(f.id)}" title="Open this factory">${esc(name)}</a>  ${what}`;
  });
  return `<span class="help-h">Factories (${list.length})</span> <span class="dim">${esc(dir)}</span>\n${rows.join("\n")}`;
}

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-open-factory]");
  if (!a) return;
  e.preventDefault();
  openFactory(a.dataset.openFactory);
});

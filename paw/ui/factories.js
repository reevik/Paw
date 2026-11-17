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
const TRIGGER_WORD = { watch: "Watching", every: "Scheduled", at: "Scheduled", webhook: "Webhook", file: "Watching files", repeat: "Repeating" };

function factoryStatus(id) {
  const f = factoryById(id);
  const run = runsOf(id)[0];
  const t = triggerOf(id);
  const going = runsOf(id).filter((r) => r.state === "running");
  if (f?.error) return "Can't be read · fix the file";
  if (going.length > 1) return `${going.length} runs going`;
  if (going.length) return `Running · ${runProgress(going[0])}`;
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
function repeatText(r) {
  if (!r) return "";
  const o = typeof r === "object" ? r : {};
  return `Starts again ${o.after ? `${esc(o.after)} after` : "when"} a run finishes${o.on_failure === "continue" ? ", even a failed one" : "; a failed run stops the loop"}`;
}

function triggerHtml(id, def) {
  const t = def.trigger ?? {};
  const rep = def.repeat && def.repeat !== false ? repeatText(def.repeat) : "";
  if (!def.trigger && !rep) return `<label class="tk-lbl">Trigger</label><div class="tk-dim">Manual: Run now. Add a trigger to the file (every, at, watch, webhook or file) to start runs on their own, or repeat: true to loop.</div>`;
  const st = triggerOf(id);
  const rows = [];
  if (t.watch) rows.push(`When <code>${esc(t.watch)}</code> starts succeeding (checked every ${esc(t.every)})`);
  else if (t.every) rows.push(`Every ${esc(t.every)}`);
  if (t.at) rows.push(`At ${esc(t.at)}`);
  if (t.file) rows.push(`When ${esc(st?.watching_file ? tildify(st.watching_file) : t.file)} changes`);
  if (t.webhook !== undefined && t.webhook !== false && t.webhook !== null) rows.push("When its webhook is called");
  if (rep) rows.push(rep);
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
  // The filter, and pinned ones first.
  const q = navFilter("factories");
  const shown = list.filter((f) => navMatches(q, f.factory?.name, f.id, f.factory?.description, factoryStatus(f.id)));
  if (!shown.length) { body.innerHTML = `<div class="sk-empty">No factories match.</div>`; return; }
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
trigger:           # optional: what starts runs on its own (any of these; Paw's background process watches them)
  every: 15m       # a run every so often
  at: "09:00, 17:30"   # a run at these times of day
  watch: "./check.sh"  # a run each time this command STARTS succeeding (it must fail in between); with watch, every is how often it's checked
  webhook: s3cret  # a run when something POSTs to http://127.0.0.1:4747/factories/<file name>; the body reaches the nodes (true: no secret); ?folder=~/path runs it in that project folder
  file: ./inbox    # a run when this file or folder changes
parallel: 1        # optional: how many runs triggers and repeat may have going at once (default 1); Run now always starts one. Each run has its own execution id (a UUID) and can work in its own project folder
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
Files: each run has its own folder for files nodes share (each node is told where); keep plans and state there, not in a fixed folder, since runs can go in parallel. For the project folder, the user picks it with Run in… (or a webhook's ?folder=); don't ask for it with files.
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
  const steps = def.nodes.map((n) => {
    const r = run?.nodes.find((x) => x.id === n.id);
    const lp = loopOf.get(n.id);
    const max = lp ? Math.min(Math.max(lp.loop.max ?? 3, 1), 20) : 0;
    return {
      badge: [lp && run && `round ${Math.max(r?.round ?? 1, 1)}/${max}`, r?.question && "asks you", r?.gate && "approve?"].filter(Boolean).join(" · "),
      id: n.id,
      title: n.title?.trim() || n.id,
      needs: n.needs ?? [],
      condFrom: n.when?.from ?? null,
      // A wait node at work is waiting on its check, not running an agent.
      state: n.wait && r?.state === "running" ? "checking" : r?.state ?? "waiting",
      model: n.wait ? "waits" : (n.model || def.model || ""),
      edits: n.wait ? true : n.edits !== false,
      startedAt: r?.started_at ?? null,
      endedAt: r?.ended_at ?? null,
    };
  });
  return { def, run, latest, steps, selected: S.factory.selected };
}

function renderFactoryView(S, host) {
  host.classList.remove("hidden");
  $("task-split")?.classList.remove("hidden");
  applyBoardSizes(host);
  if (host.dataset.dragging) return;
  // Typing in a form (Run in…, an answer, an approval): don't redraw it under the cursor.
  if (host.querySelector("[data-fact-in]:focus")) return;
  if (!factoryState.loaded) {
    if (!factoryState.loading) loadFactories();
    host.innerHTML = `<div class="tk-empty"><span class="spin-ch">${SPIN[spinFrame % SPIN.length]}</span> Reading the factory…</div>`;
    return;
  }
  const f = factoryById(S.factory.id);
  const plan = factoryPlan(S);
  const run = plan?.run ?? (S.factory.run ? null : plan?.latest);
  const runs = runsOf(S.factory.id);
  const going = runs.filter((r) => r.state === "running").length;
  const state = run ? run.state : f?.error ? "failed" : "draft";
  const stateText = (run ? `${RUN_STATE_TEXT[run.state] ?? run.state} · ${runProgress(run)}` : f?.error ? "can't run" : "ready") +
    (going > 1 ? ` · ${going} runs going` : "");
  const buttons = [
    f?.factory && `<button class="tk-btn primary" data-fact="run" title="Start a run in ${esc(f.factory.folder?.trim() || "~")}${going ? " (alongside the runs going)" : ""}">Run now</button>`,
    f?.factory && `<button class="tk-btn${S.factory.form ? " on" : ""}" data-fact="runin" title="Start a run in another project folder, or with a task">Run in…</button>`,
    run?.state === "running" && `<button class="tk-btn" data-fact="stop" title="Stop this run (${esc(shortRunId(run.id))})">Stop</button>`,
    triggerOf(S.factory.id) && `<button class="tk-btn" data-fact="pause" title="${triggerOf(S.factory.id).paused ? "Let the trigger start runs again" : "Stop the trigger from starting runs (Run now still works)"}">${triggerOf(S.factory.id).paused ? "Resume trigger" : "Pause trigger"}</button>`,
    f && `<button class="tk-btn" data-fact="edit" title="${esc(tildify(f.path))}">Edit file</button>`,
  ].filter(Boolean).join("");
  const picker = runs.length ? `<select class="tk-in fa-runs" data-fact="pick" title="Show a run">${
    `<option value=""${S.factory.run ? "" : " selected"}>Latest run</option>` +
    runs.map((r) => `<option value="${esc(r.id)}"${S.factory.run === r.id ? " selected" : ""}>${esc(fmtWhen(r.started_at))} · ${esc(RUN_STATE_TEXT[r.state] ?? r.state)} · ${esc(lastPart(runFolder(r)))} · ${esc(shortRunId(r.id))}</option>`).join("")}</select>` : "";
  const head = `<div class="tk-head">
      <span class="tk-title fa-title" title="${esc([`id: ${S.factory.id}`, f?.factory?.description].filter(Boolean).join("\n"))}"><span class="fa-ico" aria-hidden="true"></span>${esc(f?.factory?.name || S.factory.id)}</span>
      <span class="tk-state st-${esc(state)}">${esc(stateText)}</span>
      ${picker}<span class="grow"></span>${buttons}
    </div>${S.factory.form && f?.factory ? runFormHtml(S, f.factory) : ""}${run?.note ? `<div class="tk-note">${esc(run.note)}</div>` : ""}`;
  let body;
  if (!f && !run) {
    body = `<div class="tk-empty">There's no factory “${esc(S.factory.id)}” in ${esc(tildify(factoryState.dir))} any more.</div>`;
  } else if (!plan) {
    body = `<div class="tk-empty fa-broken"><b>${esc(f.id)}.yaml can't be read.</b><div class="tk-err">${esc(f.error ?? "")}</div><div class="tk-dim">Fix the file (Edit file), or ask ${esc(S.agent.name)} below to fix it.</div></div>`;
  } else {
    const vsplit = `<div class="tk-vsplit" title="Drag to resize · double-click to reset"></div>`;
    const loop = repeats(plan.def) ? " fa-loop" : "";
    // The diagram scales inside a box of its zoomed size (so the scrollbars fit it), with the zoom bar over it.
    const z = typeof S.factory.zoom === "number" ? S.factory.zoom : 1;
    const graph = `<div class="fa-graph-wrap"><div class="tk-graph fa-graph"><div class="fa-sizer"><div class="fa-zoom${loop}" data-zoom="${z}" style="transform: scale(${z})">${graphHtml(plan)}</div></div></div>${zoomBarHtml(S)}</div>`;
    body = `<div class="tk-body">${graph}${vsplit}<aside class="tk-side">${factorySideHtml(S, plan, f)}</aside></div>`;
  }
  // Not under the user's typing; keep where the graph was scrolled.
  if (host.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
  const old = host.querySelector(".fa-graph");
  const scroll = old ? [old.scrollLeft, old.scrollTop] : null;
  const sideScroll = host.querySelector(".tk-side")?.scrollTop ?? 0;
  host.innerHTML = head + body;
  const g = host.querySelector(".fa-graph");
  if (g) {
    requestAnimationFrame(() => {
      drawFactoryEdges(g.querySelector(".fa-zoom"), S, plan);
      applyZoom(host, S);
      if (scroll) [g.scrollLeft, g.scrollTop] = scroll;
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

function zoomBarHtml(S) {
  const fit = S.factory.zoom === "fit";
  return `<div class="fa-zoombar" role="toolbar" aria-label="Zoom">
    <button class="fa-zb" data-fact="zoom-out" title="Zoom out (⌘− over the diagram)">−</button>
    <button class="fa-zb fa-zpct" data-fact="zoom-100" title="Actual size (⌘0 over the diagram)">100%</button>
    <button class="fa-zb" data-fact="zoom-in" title="Zoom in (⌘+ over the diagram)">+</button>
    <button class="fa-zb${fit ? " on" : ""}" data-fact="zoom-fit" title="Fit the diagram to the view">Fit</button>
  </div>`;
}

/** The scale that shows the whole diagram in the view. */
function fitScale(g, inner) {
  const W = inner.offsetWidth, H = inner.offsetHeight;
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
  sizer.style.width = `${Math.ceil(inner.offsetWidth * z)}px`;
  sizer.style.height = `${Math.ceil(inner.offsetHeight * z)}px`;
  const pct = host.querySelector(".fa-zpct");
  if (pct) pct.textContent = `${Math.round(z * 100)}%`;
  host.querySelector('[data-fact="zoom-fit"]')?.classList.toggle("on", S.factory.zoom === "fit");
  if (anchor) {
    g.scrollLeft = sizer.offsetLeft + anchor.px * z - anchor.x;
    g.scrollTop = sizer.offsetTop + anchor.py * z - anchor.y;
  }
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

const untilText = (u) => [u?.matches && `matches “${u.matches}”`, u?.not_matches && `doesn't match “${u.not_matches}”`].filter(Boolean).join(" and ");

/** The lines between nodes, and for a factory that repeats, a line from its
 *  last nodes back under the graph to its first ones. */
function drawFactoryEdges(g, S, plan = factoryPlan(S)) {
  if (!plan) return;
  const loops = plan.def.nodes.filter((n) => n.loop);
  // Room under the graph for the loop lines (before the lines' canvas takes its size).
  g.style.paddingBottom = loops.length || repeats(plan.def) ? `${40 + loops.length * 22}px` : "";
  drawEdges(g, plan);
  if (!loops.length && !repeats(plan.def)) return;
  const svg = g.querySelector(".tk-edges");
  const box = g.getBoundingClientRect();
  const z = Number(g.dataset.zoom) || 1; // measured on screen, drawn unscaled
  const at = (id) => g.querySelector(`.tk-node[data-step="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const cx = (r) => (r.left + r.width / 2 - box.left) / z + g.scrollLeft;
  const bot = (r) => (r.bottom - box.top) / z + g.scrollTop;
  const lowest = Math.max(...plan.def.nodes.map((n) => at(n.id)).filter(Boolean).map(bot));
  // Each loop: from the looping node down, back under the graph, up into back_to (one lane each).
  let lane = 0;
  for (const n of loops) {
    const from = at(n.id), to = at(n.loop.back_to);
    if (!from || !to) continue;
    const y = lowest + 20 + lane++ * 22, r = 8;
    const x1 = cx(from), x2 = n.loop.back_to === n.id ? cx(to) - 26 : cx(to);
    const xa = n.loop.back_to === n.id ? cx(from) + 26 : x1;
    const d = `M${xa},${bot(from)} V${y - r} Q${xa},${y} ${xa - r},${y} H${x2 + r} Q${x2},${y} ${x2},${y - r} V${bot(to) + 6}`;
    const st = plan.run?.nodes.find((x) => x.id === n.id);
    const max = Math.min(Math.max(n.loop.max ?? 3, 1), 20);
    const live = (st?.round ?? 1) > 1 && plan.run?.state === "running" ? " live" : "";
    const label = `${n.loop.until ? `until ${n.loop.until.matches ?? `not ${n.loop.until.not_matches ?? ""}`}` : "until you approve"} · max ${max}${plan.run ? ` · round ${Math.max(st?.round ?? 1, 1)}` : ""}`;
    svg.insertAdjacentHTML("beforeend", `<path class="fa-loop-line fa-back${live}" d="${d}"/><path class="fa-loop-head fa-back" d="M${x2 - 4},${bot(to) + 11} L${x2},${bot(to) + 4} L${x2 + 4},${bot(to) + 11}"/><text class="fa-loop-label" x="${(Math.min(xa, x2) + Math.max(xa, x2)) / 2}" y="${y - 4}" text-anchor="middle">${esc(label.length > 60 ? label.slice(0, 59) + "…" : label)}</text>`);
  }
  if (!repeats(plan.def)) return;
  const needed = new Set(plan.steps.flatMap((s) => s.needs));
  const ends = plan.steps.filter((s) => !needed.has(s.id)).map((s) => at(s.id)).filter(Boolean);
  const starts = plan.steps.filter((s) => !s.needs.length).map((s) => at(s.id)).filter(Boolean);
  if (!ends.length || !starts.length) return;
  const x = (r) => (r.left + r.width / 2 - box.left) / z + g.scrollLeft;
  const bottom = (r) => (r.bottom - box.top) / z + g.scrollTop;
  const y = Math.max(...[...ends, ...starts].map(bottom)) + 22 + lane * 22; // below every node and loop
  const r = 10;
  let d = "";
  // Down from each last node, along the bottom, up into each first node.
  for (const e of ends) d += `M${x(e)},${bottom(e)} V${y - r} Q${x(e)},${y} ${x(e) - r},${y} `;
  const left = Math.min(...starts.map(x)), right = Math.max(...ends.map(x));
  d += `M${right - r},${y} H${left + r} `;
  for (const st of starts) d += `M${x(st) + r},${y} Q${x(st)},${y} ${x(st)},${y - r} V${bottom(st) + 6} `;
  const arrows = starts.map((st) => `<path class="fa-loop-head" d="M${x(st) - 4},${bottom(st) + 11} L${x(st)},${bottom(st) + 4} L${x(st) + 4},${bottom(st) + 11}"/>`).join("");
  const o = typeof plan.def.repeat === "object" ? plan.def.repeat : {};
  const label = `repeat${o.after ? ` after ${o.after}` : ""}`;
  const live = plan.run?.state === "running" ? " live" : "";
  svg.insertAdjacentHTML("beforeend", `<path class="fa-loop-line${live}" d="${d}"/>${arrows}<text class="fa-loop-label" x="${(left + right) / 2}" y="${y - 5}" text-anchor="middle">${esc(label)}</text>`);
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
      <div class="tl-k">Tokens</div>
      <div class="tl-big">${fmtCount(tokIn + tokOut)} <span class="tl-of">tokens</span></div>
      <div class="tl-sub">${tokIn || tokOut ? `${fmtCount(tokIn)} in · ${fmtCount(tokOut)} out` : "No tokens yet."}</div>
      <div class="tl-grid2">
        <div><div class="tl-k">Elapsed</div><div class="tl-v">${elapsed ? esc(fmtElapsed(elapsed)) : "–"}</div></div>
        <div><div class="tl-k">Nodes</div><div class="tl-v">${done} of ${rows.length}</div></div>
        <div><div class="tl-k">Started by</div><div class="tl-v">${esc(run?.trigger ?? "–")}</div></div>
        <div><div class="tl-k">Started</div><div class="tl-v">${run ? esc(fmtWhen(run.started_at)) : "–"}</div></div>
      </div>
      <div class="tl-k">Outcome</div>
      <div class="tk-state st-${esc(run?.state ?? "draft")}">${esc(run ? RUN_STATE_TEXT[run.state] ?? run.state : "not run yet")}</div>
    </aside>`;
  return timelineCore({
    rows, selected: S.factory.selected, side, label: "node", legend: [["checking", "checking"]], again: "rounds",
    empty: run ? "This run hasn't started any node yet." : "Nothing has run yet. Each node shows here as it runs, on one time line.",
    foot: (total) => {
      const failed = run?.nodes.filter((n) => n.state === "failed").length ?? 0;
      const head = run?.state === "done" ? `Done in ${fmtElapsed(total)}` : `${RUN_STATE_TEXT[run?.state] ?? "Not run"} · ${fmtElapsed(total)}`;
      return `${head}: ${done} of ${rows.length} nodes${failed ? `, ${failed} failed` : ""}.`;
    },
  });
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
  // What it waits for from you comes first.
  if (r?.question) parts.push(questionHtml(S, run, r));
  if (r?.gate) parts.push(gateHtml(S, run, r, node));
  // How it's wired.
  const title = (id) => def.nodes.find((n) => n.id === id)?.title?.trim() || id;
  if (node.needs?.length) {
    parts.push(`<label class="tk-lbl">${node.join === "any" ? "Goes on when the first of these is done" : "Gets the results of"}</label><div>${node.needs.map((n) => esc(title(n))).join(", ")}</div>`);
  }
  if (node.when) {
    const w = node.when;
    parts.push(`<label class="tk-lbl">Runs only when</label><div>${esc(title(w.from))}'s answer ${[w.matches && `matches <code>${esc(w.matches)}</code>`, w.not_matches && `doesn't match <code>${esc(w.not_matches)}</code>`].filter(Boolean).join(" and ")}</div>`);
  }
  if (node.loop) {
    const max = Math.min(Math.max(node.loop.max ?? 3, 1), 20);
    const until = node.loop.until ? `until its answer ${esc(untilText(node.loop.until))}` : "each time you reject its answer";
    parts.push(`<label class="tk-lbl">Loops</label><div>Back to ${esc(title(node.loop.back_to))} ${until}, at most ${max} round${max === 1 ? "" : "s"}${node.loop.on_max === "continue" ? "; then it goes on anyway" : "; then it fails"}.${r ? ` <span class="tk-dim">Round ${Math.max(r.round ?? 1, 1)} of ${max}.</span>` : ""}</div>`);
  }
  if (node.approve) parts.push(`<label class="tk-lbl">Approval</label><div>When it's done, its answer waits for you: approve it (you can edit it first) or reject it${node.loop ? " for another round" : ", which stops the run"}.</div>`);
  if (r?.feedback) {
    parts.push(`<details class="tk-fold" open><summary>Sent back by ${esc(r.feedback.text.startsWith("Rejected by you") ? "you" : title(r.feedback.from))} in round ${r.feedback.round}</summary><div class="tk-md">${renderMarkdown(clipEnd(r.feedback.text, 4000))}</div></details>`);
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
    run && !node.wait && r?.started_at && `<button class="tk-btn" data-fact="session" title="Its conversation in a tab${r.state === "running" || r.state === "needs" ? ": live, and you can answer it there" : ""}">Open session</button>`,
    run && ["failed", "stopped", "waiting"].includes(v) && run.state !== "done" && `<button class="tk-btn" data-fact="skip">Skip</button>`,
  ].filter(Boolean);
  if (btns.length) parts.push(`<div class="tk-row">${btns.join("")}</div>`);
  if (r?.note) parts.push(`<div class="tk-dim">${esc(r.note)}</div>`);
  if (r?.error) parts.push(`<label class="tk-lbl">What went wrong</label><div class="tk-err">${esc(r.error)}</div>`);
  if (r?.result && r.state === "done" && !r.gate) parts.push(`<label class="tk-lbl">${node.wait ? "Output" : "Result"}</label><div class="tk-md">${renderMarkdown(clipEnd(r.result, 6000))}</div>`);
  if (r?.log?.length && (r.state !== "done" || r.gate)) {
    parts.push(`<label class="tk-lbl">Activity</label><div class="fa-log">${r.log.slice(-40).map((l) =>
      `<div class="fa-log-${esc(l.kind)}">${l.kind === "tool" ? "→ " : l.kind === "ask" ? "? " : l.kind === "you" ? "you: " : ""}${esc(l.text)}</div>`).join("")}</div>`);
  }
  if (r?.input_tokens || r?.output_tokens) parts.push(`<div class="tk-dim">↑ ${esc(fmtTokens(r.input_tokens ?? 0))} ↓ ${esc(fmtTokens(r.output_tokens ?? 0))} tokens</div>`);
  if (!node.wait) parts.push(`<details class="tk-fold"${run ? "" : " open"}><summary>Prompt</summary><div class="tk-pre">${esc(node.prompt ?? "")}</div></details>`);
  return parts.join("");
}

/** A draft you're typing for a node (an answer, an edit), kept across redraws. */
const draftKey = (run, r, k) => `${run.id}/${r.id}/${k}`;
const draftOf = (S, key, dflt = "") => (S.factory.drafts ??= {})[key] ?? dflt;

/** A node's agent asks you something (ask_user). */
function questionHtml(S, run, r) {
  const q = r.question;
  const choices = (q.choices ?? []).map((c, i) => `<button class="tk-btn" data-fact="answer" data-choice="${i}">${esc(c)}</button>`).join("");
  return `<div class="fa-ask"><div><b>${esc(r.id)} asks you</b></div><div class="tk-md">${renderMarkdown(String(q.question ?? ""))}</div>
    ${choices ? `<div class="tk-row fa-choices">${choices}</div>` : ""}
    <textarea class="tk-in" rows="3" data-fact-in="${esc(draftKey(run, r, "answer"))}" placeholder="${choices ? "Or write your answer…" : "Your answer…"}">${esc(draftOf(S, draftKey(run, r, "answer")))}</textarea>
    <div class="tk-row"><button class="tk-btn primary" data-fact="answer">Send answer</button><span class="tk-dim">or answer in its session</span></div></div>`;
}

/** A node's answer waiting for your approval (approve: true). */
function gateHtml(S, run, r, node) {
  return `<div class="fa-ask fa-gate"><div><b>Its answer waits for your approval</b></div>
    <div class="tk-dim">Edit it if you like: the next nodes get it as you approve it.</div>
    <textarea class="tk-in fa-gate-text" rows="10" data-fact-in="${esc(draftKey(run, r, "gate"))}">${esc(draftOf(S, draftKey(run, r, "gate"), r.result ?? ""))}</textarea>
    <input class="tk-in" data-fact-in="${esc(draftKey(run, r, "why"))}" value="${esc(draftOf(S, draftKey(run, r, "why")))}" placeholder="Why you reject it (${node.loop ? "goes back as feedback" : "the run stops"})">
    <div class="tk-row"><button class="tk-btn primary" data-fact="gate-approve">Approve</button><button class="tk-btn danger" data-fact="gate-reject">Reject${node.loop ? "" : " and stop"}</button></div></div>`;
}

function factorySummaryHtml(S, plan, f) {
  const { def, run } = plan;
  const parts = [`<div class="tk-side-title">${esc(def.name)}</div>`];
  if (def.description?.trim()) parts.push(`<div class="tk-goal">${esc(def.description.trim())}</div>`);
  parts.push(`<div class="tk-dim"><code class="fa-id" title="The factory's id (its file name)">${esc(S.factory.id)}</code> · ${def.nodes.length} node${def.nodes.length === 1 ? "" : "s"} · works in ${esc(def.folder?.trim() || "~")}${def.model ? ` · ${esc(modelShort(def.model))}` : ""}</div>`);
  // The trigger as the file has it now (the run may be of an older version).
  parts.push(triggerHtml(S.factory.id, f?.factory ?? def));
  if (run && f?.factory && JSON.stringify(f.factory) !== JSON.stringify(def)) {
    parts.push(`<div class="tk-hint">The graph shows this run as it was when it started; the file has changed since.</div>`);
  } else if (!run && plan.latest) {
    parts.push(`<div class="tk-hint">The last run (${esc(fmtWhen(plan.latest.started_at))}, ${esc(plan.latest.state)}) used an earlier version of the file; pick it in the run list to see it.</div>`);
  }
  if (f?.error && run) parts.push(`<div class="tk-warn">The file has a problem now: ${esc(f.error)}</div>`);
  if (run) {
    parts.push(`<label class="tk-lbl">This run</label><div class="tk-dim">Started ${esc(fmtWhen(run.started_at))} (${esc(run.trigger)})${run.ended_at ? ` · took ${esc(fmtElapsed(run.ended_at - run.started_at))}` : ""} · works in ${esc(runFolder(run))}</div>
      <div class="fa-exec"><span class="tk-dim">Execution</span><code title="The run's execution id">${esc(run.id)}</code><button class="tk-btn" data-fact="rundir" title="${esc(tildify(runDir(run)))}">Open its folder</button></div>`);
    if ((run.trigger === "manual" || run.trigger === "chat") && run.payload?.trim()) parts.push(`<label class="tk-lbl">Task</label><div class="tk-md">${renderMarkdown(clipEnd(run.payload.trim(), 2000))}</div>`);
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
  // Stop, Retry, Skip and approvals act on the run shown.
  const run = factoryPlan(S)?.run;
  const fail = (err) => sys(S, `✗ ${err}`);
  try {
    switch (b.dataset.fact) {
      case "run": await startFactoryRun(S, P, null, null); break;
      case "runin": S.factory.form = !S.factory.form; withPane(P, renderTaskView); break;
      case "formcancel": S.factory.form = false; withPane(P, renderTaskView); break;
      case "choose": {
        const dir = await invoke("skills_pick_folder", { title: "Run the factory in" });
        if (dir) { S.factory.formFolder = tildify(dir); withPane(P, renderTaskView); }
        break;
      }
      case "runstart": {
        const folder = (S.factory.formFolder ?? "").trim();
        const task = (S.factory.formTask ?? "").trim();
        await startFactoryRun(S, P, folder || null, task || null);
        S.factory.form = false;
        S.factory.formTask = "";
        withPane(P, renderTaskView);
        break;
      }
      case "rundir": if (run) await invoke("open_folder", { path: runDir(run) }); break;
      case "zoom-in": case "zoom-out": setZoom(S, withPane(P, () => $("task-view")), b.dataset.fact.slice(5)); break;
      case "zoom-100": setZoom(S, withPane(P, () => $("task-view")), 1); break;
      case "zoom-fit": setZoom(S, withPane(P, () => $("task-view")), "fit"); break;
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
        break;
      }
    }
  } catch (err) {
    fail(err);
  }
  withPane(P, renderTaskView);
}

/** The run picker. */
/** Start a run (in a project folder, with a task, or neither) and show it. */
async function startFactoryRun(S, P, folder, task) {
  const id = await invoke("factory_run", { factory: S.factory.id, payload: task, folder, model: defaultPawModel() || null });
  S.factory.run = id; // show this run, even with others going
  saveWorkspaceSoon();
  await loadFactories();
  if (!factoryState.runs.has(id)) {
    const r = await invoke("factory_get", { run: id });
    if (r) factoryState.runs.set(id, r);
  }
  withPane(P, renderTaskView);
}

/** Run in…: a project folder and a task for one run. */
function runFormHtml(S, def) {
  const folder = S.factory.formFolder ?? (def.folder?.trim() || "~");
  return `<div class="fa-runform">
    <label class="tk-lbl">Project folder</label>
    <div class="fa-row"><input class="tk-in" data-fact-in="folder" value="${esc(folder)}" placeholder="~/Developer/my-app" spellcheck="false"><button class="tk-btn" data-fact="choose">Choose…</button></div>
    <label class="tk-lbl">Task <span class="tk-dim">optional: every node gets it</span></label>
    <textarea class="tk-in" data-fact-in="task" rows="2" placeholder="What this run is for, e.g. “Release 1.4 with the new importer”">${esc(S.factory.formTask ?? "")}</textarea>
    <div class="fa-row"><span class="tk-dim">Runs of this factory go side by side, each with its own execution id.</span><span class="grow"></span><button class="tk-btn" data-fact="formcancel">Cancel</button><button class="tk-btn primary" data-fact="runstart">Start run</button></div>
  </div>`;
}

/** Typing in the Run in… form (kept across redraws). */
function factoryInput(S, e) {
  const k = e.target.dataset?.factIn;
  if (k === "folder") S.factory.formFolder = e.target.value;
  else if (k === "task") S.factory.formTask = e.target.value;
  else if (k) (S.factory.drafts ??= {})[k] = e.target.value;
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
      sys(T, `— ${nodeId} in run ${shortRunId(runId)}: live. When it asks you something, type your answer here. —`);
      replayEvents(att.events ?? []);
      if (r.question) sys(T, `? ${r.question.question}`);
      refresh(T);
      return;
    }
  }
  const convs = await invoke("factory_conversation", { run: runId, node: nodeId }).catch((e) => { sys(T, `✗ ${e}`); return []; });
  sys(T, `— ${nodeId} in run ${shortRunId(runId)}${r ? ` (${r.state === "needs" && r.gate ? "waiting for your approval" : r.state})` : ""}: its saved conversation; read only. —`);
  convs.forEach((lines, i) => {
    if (convs.length > 1) sys(T, `— round ${i + 1} —`);
    for (const text of lines) {
      // The prompts it got show as yours do; the rest as the agent's events.
      const prompt = text.startsWith('{"type":"user"') && !text.includes('"tool_result"');
      pushLine(T, { stream: prompt ? "stdin" : "stdout", text, ts: Date.now() });
    }
  });
  if (!convs.length) sys(T, "Nothing saved for it yet.");
  refresh(T);
}

/** The run's state of the node a tab shows. */
const nodeRunOf = (T) => factoryState.runs.get(T.nodeOf.run)?.nodes.find((n) => n.id === T.nodeOf.node) ?? null;

function nodePlaceholder(T) {
  const r = nodeRunOf(T);
  if (r?.question) return "Answer its question… (⏎ sends it to the node)";
  if (r?.gate) return "Its answer waits for your approval in the factory's view";
  if (r?.state === "running" || r?.state === "needs") return "It's working: when it asks you something, answer here";
  return "Read only: this node has finished";
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
    ? "It's working: you can write here when it asks you something (it shows in the factory's view too)."
    : "This node has finished: its session is read only. Retry it in the factory's view to run it again.");
}

// ---------- starting runs from a tab ----------
/** A note in a tab that a run started, with a link to it. */
function factoryRunNote(S, ev) {
  info(S, `<span class="fa-ico" aria-hidden="true"></span> Started <b>${esc(ev.name ?? ev.factory)}</b> in ${esc(tildify(ev.folder ?? ""))} · run <code>${esc(shortRunId(ev.run))}</code> · <a href="#" class="fa-open-run" data-factory="${esc(ev.factory)}" data-run="${esc(ev.run)}">Open run</a>`);
}

/** /factory run <name> [task]: a run in the tab's folder (or the factory's, from a home-folder tab). */
async function runFactoryFromTab(S, which, task) {
  await loadFactories();
  const want = which.toLowerCase();
  const f = factoryState.list.find((x) => x.id === which || x.id.toLowerCase() === want || x.factory?.name?.toLowerCase() === want);
  if (!f) { sys(S, `No factory “${which}”. /factories lists them.`); return; }
  if (!f.factory) { sys(S, `✗ ${f.id}.yaml can't be read: ${f.error}`); return; }
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

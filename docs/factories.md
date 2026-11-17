# Factories

A factory is a pipeline of agents that you describe once in a YAML file. Paw runs it in the background, so a run keeps going when the window is closed. Each **node** is one agent with its own task, model, skills, tools and MCP servers, or a **wait** that holds the run until a command succeeds.

Factory files live in `~/.paw/factories/<id>.yaml`: the file name is the factory's **id** (`error-spike`), which webhooks, run folders and `/factory` use; `name` is what you see. The sidebar's **Factories** section lists them. Click one to open it, or press **+** to make a new one. In a tab, `/factories` lists them and `/factory new <name>` makes one.

## The factory view

A factory opens in a tab that looks like a task:

- **The graph:** nodes in the order they run. A dashed line is a branch: the node after it runs only if the condition holds.
- **Click a node** to see its description, prompt, model, skills, tools, MCP servers and condition. During a run you also see its activity and result. What a node needs from you shows at the top of its side panel: a tool call to allow, a question to answer, or its answer to approve (see [Talking to the nodes](#talking-to-the-nodes)).
- **Open session** opens a node's conversation in a tab: live while it works, and saved once it's done.
- **Run now** starts a run in the background, in the factory's folder. **Run in…** starts one in another project folder, optionally with a task that every node gets. Runs go side by side, so you can start several. **Stop** stops the run you're looking at. **Retry** and **Skip** work on a failed node. The run picker lists the runs, going and earlier ones, with their folder and execution id.
- **Edit file** opens the YAML file in your editor. You can also ask Paw Agent in the prompt box below to change the factory, for example "add a node that posts the note to Slack".

## The file

```yaml
name: Error spike responder          # required
description: Triage error spikes, fix critical ones, write a note.
folder: ~/Developer/my-service       # where the nodes work (default ~)
model: anthropic/claude-sonnet-5-5   # default model for nodes (else Settings' default)
approval: auto                       # for nodes that change files: ask, edits, auto, full
parallel: 2                          # runs triggers may have going at once (default 1)

nodes:
  - id: triage                       # letters, digits, - and _
    title: Classify the spike
    description: Reads the last hour of logs and rates the severity.
    prompt: >
      Read ./logs and classify the spike. End with "severity: critical",
      "severity: high" or "severity: low".
    edits: false                     # only reads
    skills: [log-reading]            # only these skills (default: all)
    mcp: [grafana]                   # only these MCP servers (default: all that are on)

  - id: hotfix
    needs: [triage]                  # runs after triage; gets its answer
    when: { from: triage, matches: "severity: (high|critical)" }   # a branch
    tools: [read, edit, search, shell]   # only these built-in tools
    prompt: Fix the cause triage found.
    timeout: 20m

  - id: settle                       # a wait node
    needs: [hotfix]
    wait: "curl -sf localhost:8080/health"
    every: 30s
    timeout: 10m

  - id: report
    needs: [triage, settle]
    prompt: Write an incident note in docs/incidents/.

  - id: page
    needs: [hotfix, report]
    join: any                        # goes on when the first of them is done
    edits: false
    prompt: Summarize what happened for on-call, in five lines.
```

### Shapes

- **Linear, tree or graph:** a node runs after the nodes in its `needs`, and their answers are its inputs. Nodes that don't need each other run side by side, as many as **Settings › General › Agents at once** allows. Nodes that change files run one at a time in a folder, across all runs.
- **Joins:** `join: all` (the default) waits for every input. `join: any` goes on as soon as the first input is done.
- **Branches:** `when` runs a node only if an earlier node's answer matches `matches`, or doesn't match `not_matches`. Both are regular expressions and ignore case. The node in `from` has to come before it. A node whose condition doesn't hold is skipped, and so is a node whose inputs were all skipped.
- **Waits:** a node with `wait` runs its command every `every` (30s by default) until it succeeds. Its output is passed on like an answer. A `timeout` makes it fail when the time runs out. The command runs in the run's project folder, with `$PAW_RUN_FILES` set to the run's shared files folder (and `$PAW_RUN_DIR` to the run's folder).
- **Loops:** a node with `loop` sends the run back to an earlier node (or itself) until its answer meets a condition, for at most `max` rounds. See below.

### A node's settings

| Key | What it does |
|---|---|
| `prompt` | The instructions. The agent sees only this, the factory's name and description, and its inputs. |
| `model` | `provider/model`. Defaults to the factory's model, then to Settings' default. |
| `edits` | `false`: the node only reads (Paw Agent's read-only level). |
| `approval` | `ask`, `edits`, `auto`, `plan` or `full`. Overrides the factory's level. |
| `skills` | Only these skills, by name. |
| `tools` | Only these built-in tools: `read`, `edit`, `write`, `search`, `list`, `shell`. `[]` gives none. |
| `mcp` | Only these MCP servers, by name. |
| `timeout` | Give up after this long (`30s`, `20m`, `1h`). |
| `loop` | Send the run back to an earlier node until this node's answer meets `until`, for at most `max` rounds. |
| `approve` | `true`: when it's done, the run waits for you to approve its answer (you can edit it) or reject it. |

### Loops

A run goes forward through the nodes, but a node can send it back for another round, like a review that returns the work until it's right:

```yaml
  - id: fix
    needs: [plan]
    prompt: Make the change the plan describes.

  - id: review
    needs: [fix]
    edits: false
    prompt: Review the change. End with "verdict: approved" or "verdict: changes needed".
    loop:
      back_to: fix                              # the node the run goes back to (this node, or one it needs)
      until: { matches: "verdict: approved" }   # done when this node's answer matches (or not_matches)
      max: 3                                    # at most 3 rounds, the first one included (default 3)
      on_max: fail                              # after the last round: fail (default) or continue
```

When the answer doesn't meet `until`, `back_to`, the looping node and every node on the way between them run again; nodes before `back_to` don't. `back_to` gets the looping node's answer as feedback, together with its own answer from the round before. Nodes after the looping node wait until the loop is through. The board draws the loop as a line back to `back_to` with its round, and the timeline shows every round.

### Approvals

Nodes run without a window, so pick approval levels that let them work on their own. `auto` (the default for nodes that change files) allows edits inside the folder and safe commands. When a node does need you, it shows **needs you** and a badge in the sidebar. Its approval waits in the factory view until you answer it.

## Starting runs from a chat

Paw Agent in any tab can start factories for you. Say what you want, and it starts the run in the tab's folder (or one you name) with your words as the task:

> Run the SDLC factory on this repo: add a --verbose flag to the CLI.

You confirm before the run starts. **Always** allows that factory from then on, and the `full` level doesn't ask. The tab shows a link to the run. Ask Paw Agent how a run is going and it tells you the state, the node at work, and anything waiting for you. When a node asks you something or waits for your approval, you can answer in the chat too; Paw Agent passes on only what you say.

Without a model: `/factory run <name> [task]` starts a run in the tab's folder.

## Talking to the nodes

A node can need you in three ways. Each time it glows amber, shows **needs you** and a badge in the sidebar, and you get a notification, even with the window closed.

- **A question.** Every agent node has an `ask_user` tool: when it needs a decision or a detail only you have, it asks, with choices when there are a few. The question shows in the node's side panel with a box for your answer (or click a choice). Its agent waits for it, then goes on in the same conversation.
- **Its answer, to approve.** A node with `approve: true` holds the run when it's done. Its answer shows in an editable box: **Approve** passes it on as you left it, **Reject** (with a reason) stops the run, or with a loop sends the node back for another round with your reason as feedback.
- **A tool call, to allow,** when its approval level asks (above).

```yaml
  - id: plan
    prompt: Write an implementation plan for the task.
    edits: false
    approve: true                      # you approve the plan, or reject it with your reasons
    loop: { back_to: plan, max: 3 }    # a rejection sends it back (no until: you decide each round)
```

**Open session** on a node opens its conversation in a tab. While the node works you see it live, and when it asks you something you can answer there too. Once it's done the tab shows its saved conversation (every round). Closing the tab doesn't stop the node.

Nodes are told to ask rather than wait for files. Each run also has its own `files/` folder for the plans and notes its nodes share (below), and for the project folder there's **Run in…**.

## Triggers

A `trigger` starts runs on its own. Paw's background process watches it, so it works while the window is closed. Combine kinds as you like:

```yaml
trigger:
  every: 15m                     # a run every 15 minutes (the first one 15m after Paw starts)
  at: "09:00, 17:30"             # and at these times of day
  webhook: s3cret                # and when something POSTs here (true: no secret)
  file: ./inbox                  # and when this file or folder changes
```

```yaml
trigger:
  watch: "./check-errors.sh"     # a run when this command starts succeeding…
  every: 2m                      # …checked this often (with watch, every is the check interval)
```

| Kind | Starts a run |
|---|---|
| `every` | every so often |
| `at` | at these times of day (local time) |
| `watch` + `every` | when the command **starts** succeeding: it has to fail before it fires again, so a long error spike starts one run, not one per check. With `fires: each`, every successful check starts a run instead, for a check that succeeds once per new event (a new commit, a new file). The command's output goes to the nodes as the trigger's payload. |
| `webhook` | when something posts to `http://127.0.0.1:4747/factories/<id>`. The request's body goes to the nodes as the trigger's payload, so an alert's JSON reaches them. With a secret, the caller sends it as an `X-Paw-Token` header or `?token=`. `?folder=~/Developer/app` (or an `X-Paw-Folder` header) runs it in that project folder. The reply has the run's execution id: `{"run": "…"}`, or `{"queued": true}`. |
| `file` | when the file, or anything in the folder, changes and then stays quiet for 2 seconds |

For example, Alertmanager or Grafana can post their alerts straight to a factory:

```bash
curl -X POST -H "X-Paw-Token: s3cret" -d @alert.json http://127.0.0.1:4747/factories/error-spike
```

A trigger has at most `parallel` runs of a factory going at once (1 unless the file says otherwise). When it fires with no room, the run waits its turn and starts when a run ends, so an event that arrives mid-run isn't lost. One run waits per project folder: a later event for the same folder replaces the earlier one. **Pause trigger** in the factory view stops it from starting runs (Run now still works), and **Resume trigger** turns it back on. The view shows the next scheduled run, the last check and what the trigger did last.

The webhook listens only on this Mac (127.0.0.1). Port 4747 can be changed in `~/.paw/settings.json`: `"factories": { "webhook_port": 4800 }`.

## Repeat

A run goes once through the nodes. For a pipeline that should start over when it's done, add `repeat`:

```yaml
repeat: true                                  # start again 5s after a run finishes
repeat: { after: 2m, on_failure: continue }   # or wait 2m, and go on even after a failed run
```

A failed run stops the loop unless `on_failure: continue`. **Pause trigger** stops the loop too.

To react to events, a trigger is usually better than a loop with a long wait node: the factory below starts one run per new commit, and nothing sits waiting in between.

```yaml
trigger:
  watch: ./new-commit.sh   # succeeds once for each commit it hasn't seen
  every: 30s
  fires: each
```

## Runs

Every run (an execution) gets an **execution id**, a UUID, and a folder of its own:

```
~/.paw/factories/<factory-id>/<execution-id>/
  run.json              # the run: its copy of the factory, each node's state, answers and activity
  files/                # files the run's nodes share: plans, notes, state (each node is told where)
  nodes/<node-id>/      # each agent node's conversations, scripts and files
```

`run.json` is written while the run goes, so a restart doesn't lose it. The factory view's side panel shows a run's execution id, and **Open its folder** opens it. The last 30 runs of each factory are kept.

A factory can run several times at once, for different projects or tasks: each run works in its own folder (**Run in…**, or a webhook's `?folder=`) and gets its own task. Runs in different folders change files at the same time; in the same folder they take turns. Run now always starts a run. Triggers and `repeat` start at most `parallel` at once, and a repeating run starts again in its own folder.

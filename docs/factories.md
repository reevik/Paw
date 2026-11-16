# Factories

A factory is a pipeline of agents that you describe once in a YAML file. Paw runs it in the background, so a run keeps going when the window is closed. Each **node** is one agent with its own task, model, skills, tools and MCP servers, or a **wait** that holds the run until a command succeeds.

Factory files live in `~/.paw/factories/<name>.yaml`. The sidebar's **Factories** section lists them. Click one to open it, or press **+** to make a new one. In a tab, `/factories` lists them and `/factory new <name>` makes one.

## The factory view

A factory opens in a tab that looks like a task:

- **The graph:** nodes in the order they run. A dashed line is a branch: the node after it runs only if the condition holds.
- **Click a node** to see its description, prompt, model, skills, tools, MCP servers and condition. During a run you also see its activity and result. When the node waits for your approval, the side panel shows **Allow**, **Always allow** and **Deny**.
- **Run now** starts a run in the background. **Stop** stops it. **Retry** and **Skip** work on a failed node. The run picker shows earlier runs.
- **Edit file** opens the YAML file in your editor. You can also ask Paw Agent in the prompt box below to change the factory, for example "add a node that posts the note to Slack".

## The file

```yaml
name: Error spike responder          # required
description: Triage error spikes, fix critical ones, write a note.
folder: ~/Developer/my-service       # where the nodes work (default ~)
model: anthropic/claude-sonnet-5-5   # default model for nodes (else Settings' default)
approval: auto                       # for nodes that change files: ask, edits, auto, full

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

- **Linear, tree or graph:** a node runs after the nodes in its `needs`, and their answers are its inputs. Nodes that don't need each other run side by side, as many as **Settings › General › Agents at once** allows. Nodes that change files run one at a time.
- **Joins:** `join: all` (the default) waits for every input. `join: any` goes on as soon as the first input is done.
- **Branches:** `when` runs a node only if an earlier node's answer matches `matches`, or doesn't match `not_matches`. Both are regular expressions and ignore case. The node in `from` has to come before it. A node whose condition doesn't hold is skipped, and so is a node whose inputs were all skipped.
- **Waits:** a node with `wait` runs its command every `every` (30s by default) until it succeeds. Its output is passed on like an answer. A `timeout` makes it fail when the time runs out.

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

### Approvals

Nodes run without a window, so pick approval levels that let them work on their own. `auto` (the default for nodes that change files) allows edits inside the folder and safe commands. When a node does need you, it shows **needs you** and a badge in the sidebar. Its approval waits in the factory view until you answer it.

## Triggers

A factory's `trigger` (a schedule, a watched command, a webhook or a file change) is read and shown, but doesn't start runs yet; that comes next. For now, use **Run now**.

```yaml
trigger:
  watch: "./check-errors.sh"   # starts a run when this succeeds…
  every: 2m                    # …checked this often
```

## Runs

Runs are kept in `~/.paw/factories/.runs/`, the last 30 per factory. Each agent node's conversation is kept in its own session folder in `~/.paw/session/`.

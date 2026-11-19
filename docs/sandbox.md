# Sandbox

Paw Agent can work in a sandbox: its commands and file changes stay inside the folder it works in, run only the programs you allow, and reach the network only if you let them. It uses macOS's own sandbox, so the agent keeps your real tools (git, npm, cargo, Homebrew…) and starts no slower.

The sandbox limits what an action can do once it runs; the approval level (ask, edits, auto…) still decides whether it runs at all. In a sandbox you can usually let the agent ask less, since a command can't reach beyond the project.

## Settings › Sandbox

- **Sandbox:** on or off for new tabs, and for factory runs unless their file says otherwise. Open tabs keep the sandbox they started with; their button changes it for one tab.
- **Where it may write:** always the folder it works in, its session's scripts, a factory run's shared files and temp. Add folders it may also change, such as `~/.cargo` or `~/.npm` for their caches.
- **Programs:** any program, or only the ones listed (a starter list of common tools comes with it). A program's helpers come along: `git` brings `git-remote-https`.
- **Network:** on, off, or only for the listed programs (say `git`, `gh`, `npm`). Off still lets commands reach this Mac (localhost), so local servers and tests work.

## In a tab

The button under the prompt shows the tab's sandbox (a shield and **Sandbox**, or a crossed-out shield and **No sandbox**); its tooltip says what it allows. Click it to turn the sandbox on or off for that tab; the conversation goes on.

When the sandbox stops something, the tab says what and why:

> Blocked by the sandbox: `curl` isn't on the list of programs this tab may run. **Allow in this tab** · **Add to the list**

**Allow in this tab** lets that program run in this tab from now on; **Add to the list** adds it to Settings › Sandbox. Then ask Paw Agent to try again. Paw Agent is told about its sandbox, and when something is blocked it says what it needs instead of trying to get around it.

When you change the tab's folder (`cd`, `/cd`), the sandbox goes with you: the same rules, now for the new folder, and the conversation continues.

## In a factory

A factory's file can give its nodes their own sandbox:

```yaml
sandbox:
  write: ["~/.cargo"]       # folders it may also change, besides the one it works in
  run: [git, gh, npm]       # only these programs may run
  network: [git, gh]        # only these may use the network (true / false for all)
```

The section turns the sandbox on for the factory's nodes (`enabled: false` turns it off), over Settings' policy. Without it, Settings › Sandbox decides. The factory view says which sandbox its runs use, and each box on its diagram shows a shield when that node runs in the sandbox, or a crossed-out one when it doesn't. A `wait` node's check and a `watch` trigger's command are plain commands and run without the sandbox; the factory view says so. (The sandbox button under a factory's prompt is for the Paw Agent of that tab, which changes the factory's file.)

## In a project

A project can make the sandbox stricter for any session that works in it, with `.paw/sandbox.yaml` in the project folder, in the same form as a factory's section:

```yaml
run: [git, npm, node]
network: false
```

It turns the sandbox on there and can only take things away: fewer programs, less network, fewer extra folders. Whichever is stricter wins.

## What it covers

Paw Agent's commands (its shell tool) run under the sandbox, and its file tools (edit, write) are held to the same folders. Reading isn't limited. MCP servers run as their own programs and aren't sandboxed. Your own commands in a tab's shell are yours, never sandboxed.

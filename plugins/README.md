# Paw plugins

Plugins extend Paw's terminal: slash commands, items in the status bar, and
reactions to what happens in a tab. This folder is the **official catalog**.
**Settings › Plugins** reads `index.json` from here and installs plugins into
`~/.paw/plugins/<id>/`.

| Plugin | What it does | Permissions |
|---|---|---|
| [Pomodoro](pomodoro) | A focus timer in the status bar (`/pomodoro 25`) | commands, statusbar |
| [Usage Meter](usage-meter) | Today's prompts and tokens in the status bar | commands, statusbar, events |
| [Snippets](snippets) | Saved prompts, back in the prompt with `/snip <name>` | commands, prompt |

## The catalog

`index.json` lists the plugins:

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "pomodoro",
      "name": "Pomodoro",
      "version": "1.0.0",
      "description": "A focus timer in the status bar.",
      "author": "Your Name",
      "license": "MIT",
      "homepage": "https://github.com/reevik/Paw/tree/main/plugins/pomodoro",
      "min_paw": "0.5.0",
      "permissions": ["commands", "statusbar"],
      "path": "pomodoro"
    }
  ]
}
```

- `id`: lowercase letters, digits and dashes; also the folder's name in `~/.paw/plugins`.
- `version`: raise it to ship an update. Settings offers **Update** when the catalog's version is newer.
- `min_paw` (optional): the oldest Paw it works with.
- `path`: the plugin's folder in the catalog.

Each plugin folder has a `plugin.json` with the same fields (and the same `id`)
plus `main` (the script, `main.js` by default) and `files` (every file to
download; names only, no folders).

## Permissions

A plugin declares what it needs. Settings shows the list before installing,
and Paw refuses anything else.

| Permission | Lets the plugin |
|---|---|
| `commands` | add slash commands and print in tabs |
| `statusbar` | show a short text in the status bar |
| `events` | hear about prompts sent, agent turns ending (time, tokens) and shell commands |
| `prompt` | put text in a tab's prompt, or send it to the tab's agent |
| `shell` | run commands in a tab's shell (they show in the tab, like typed) |
| `network` | use `fetch` and friends (without it they're removed) |

## Writing one

A plugin runs in its own **web worker**. It never sees Paw's window or files,
only a global `paw` object:

```js
// A slash command. The handler gets the text after the command and the tab;
// what it returns (Markdown) is shown in the tab.
paw.command("hello", { description: "say hello", usage: "[name]" }, (args, tab) => {
  return `Hello, **${args || "you"}**! This tab runs ${tab.agent} in \`${tab.cwd}\`.`;
});

// Status bar text ("" removes it).
paw.status("🐾 ready", { title: "shown on hover" });

// Events (needs "events").
paw.on("prompt", ({ tab, text }) => {});
paw.on("turn", ({ tab, ok, ms, input, output, model, agent }) => {});
paw.on("command", ({ tab, command, code }) => {});

// Print in a tab (needs "commands").
paw.print(tab, "Markdown *here*");

// The prompt (needs "prompt"): put text in it, or send it to the agent.
await paw.prompt(tab, "Review this change", { send: false });

// The shell (needs "shell"): runs in the tab, resolves when it's done.
const { code, output } = await paw.run(tab, "git status --short");

// The open tabs: [{ id, title, agent, model, cwd, active }].
const tabs = await paw.tabs();

// Storage kept between launches (up to 1 MB per plugin).
await paw.storage.set("count", 3);
const count = await paw.storage.get("count");
```

A tab is `{ id, title, agent, model, cwd, active }`; pass it (or its `id`) to
`print`, `prompt` and `run`. Commands can't reuse Paw's own names (`/help`,
`/task`, …) or another plugin's.

## Trying a plugin while writing it

In **Settings › Plugins**, set the catalog to this folder in your checkout
(for example `~/Developer/Paw/plugins`). Paw then reads `index.json` and the
plugins from disk: install yours from there, edit it, and click **Update** (or
reinstall) to load the new version. `/plugins` in a tab lists what's running,
and errors go to the window's web inspector.

## Adding one to the official catalog

Add its folder and an entry in `index.json`, and open a pull request. Keep the
permissions to what the plugin needs. Paw's tests check that every entry has a
valid `plugin.json` and that its files are there.

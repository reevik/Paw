// Paw's key bindings: what each shortcut does, its default keys, and the
// keys you set in Settings › Keys (settings.keys: { action: ["Shift+Cmd+D"] }).
// Loaded by the main window and by Settings, after i18n.js.
//
// A key is written "Ctrl+Alt+Shift+Cmd+K" (modifiers in that order), with the
// key by its place on the keyboard: A–Z, 0–9, [ ] , . - = / ; ' ` \, Up, Down,
// Left, Right, Tab, Enter, Escape, Space, Backspace, Delete, F1–F12.

/* exported KEY_ACTIONS, KEY_FIXED, KEY_MACOS, keyNorm, keyCombo, keysOf, keyIs, keyActionFor, keyConflict, keyProblem, keyLabel */

// where: "window" (Paw handles it), "menu" (the native menu's, so it works
// wherever the focus is; handled by the window only without a native menu),
// "prompt" (while typing in the prompt).
const KEY_ACTIONS = [
  { id: "new-tab", group: "Tabs", label: () => tx("New tab"), keys: ["Cmd+T", "Cmd+N"], where: "menu" },
  { id: "new-tab-with", group: "Tabs", label: () => tx("New tab with another model…"), keys: ["Shift+Cmd+T", "Shift+Cmd+N"], where: "menu" },
  { id: "close-tab", group: "Tabs", label: () => tx("Close tab"), keys: ["Cmd+W"], where: "menu" },
  { id: "next-tab", group: "Tabs", label: () => tx("Next tab"), keys: ["Shift+Cmd+]"], where: "menu" },
  { id: "prev-tab", group: "Tabs", label: () => tx("Previous tab"), keys: ["Shift+Cmd+["], where: "menu" },
  { id: "clear", group: "Tabs", label: () => tx("Clear the screen"), keys: ["Cmd+K"], where: "menu" },
  { id: "interrupt", group: "Tabs", label: () => tx("Stop the agent or command"), keys: ["Cmd+."], where: "menu" },
  { id: "split-row", group: "Panes and panels", label: () => tx("Split side by side"), keys: ["Cmd+D"], where: "menu" },
  { id: "split-column", group: "Panes and panels", label: () => tx("Split stacked"), keys: ["Shift+Cmd+D"], where: "menu" },
  { id: "toggle-sidebar", group: "Panes and panels", label: () => tx("Show or hide the sidebar"), keys: ["Ctrl+Cmd+S"], where: "menu" },
  { id: "toggle-panel", group: "Panes and panels", label: () => tx("Show or hide the right panel"), keys: ["Ctrl+Cmd+M"], where: "menu" },
  { id: "settings", group: "Panes and panels", label: () => tx("Settings"), keys: ["Cmd+,"], where: "menu" },
  { id: "font-bigger", group: "Text size", label: () => tx("Bigger text (or zoom in a diagram)"), keys: ["Cmd+=", "Shift+Cmd+="], where: "menu" },
  { id: "font-smaller", group: "Text size", label: () => tx("Smaller text (or zoom out a diagram)"), keys: ["Cmd+-", "Shift+Cmd+-"], where: "menu" },
  { id: "font-reset", group: "Text size", label: () => tx("Actual size"), keys: ["Cmd+0"], where: "menu" },
  { id: "history-search", group: "Prompt", label: () => tx("Search earlier prompts"), keys: ["Ctrl+R"], where: "prompt" },
  { id: "input-mode", group: "Prompt", label: () => tx("Switch input mode (Auto, Shell, Agent)"), keys: ["Shift+Tab"], where: "prompt" },
  { id: "delete-line", group: "Prompt", label: () => tx("Delete to the start of the line"), keys: ["Ctrl+U"], where: "prompt" },
  { id: "delete-word", group: "Prompt", label: () => tx("Delete the word before the cursor"), keys: ["Ctrl+W"], where: "prompt" },
  { id: "prompt-interrupt", group: "Prompt", label: () => tx("Stop (with nothing selected)"), keys: ["Ctrl+C"], where: "prompt" },
];
const KEY_GROUPS = ["Tabs", "Panes and panels", "Text size", "Prompt"];
const keyGroupLabel = (g) => ({ Tabs: tx("Tabs"), "Panes and panels": tx("Panes and panels"), "Text size": tx("Text size"), Prompt: tx("Prompt") })[g] ?? g;

// Shown in Settings but not changeable, and never given to another action.
const KEY_FIXED = [
  { label: () => tx("Go to tab 1–9"), keys: ["Cmd+1", "Cmd+2", "Cmd+3", "Cmd+4", "Cmd+5", "Cmd+6", "Cmd+7", "Cmd+8", "Cmd+9"], show: "⌘1 … ⌘9" },
  { label: () => tx("Move between panes"), keys: ["Alt+Cmd+Up", "Alt+Cmd+Down", "Alt+Cmd+Left", "Alt+Cmd+Right"], show: "⌥⌘ ← ↑ → ↓" },
  { label: () => tx("Send the prompt"), keys: ["Enter"] },
  { label: () => tx("New line in the prompt"), keys: ["Shift+Enter"] },
  { label: () => tx("Complete (commands, files)"), keys: ["Tab"] },
  { label: () => tx("Quit Paw"), keys: ["Cmd+Q"] },
];
// macOS's own (editing, hiding, minimizing): never taken.
const KEY_SYSTEM = ["Cmd+C", "Cmd+V", "Cmd+X", "Cmd+A", "Cmd+Z", "Shift+Cmd+Z", "Cmd+H", "Alt+Cmd+H", "Cmd+M", "Cmd+`", "Cmd+Space", "Cmd+Tab", "Escape"];

const CODE_KEYS = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Minus: "-", Equal: "=", Slash: "/", Semicolon: ";",
  Quote: "'", Backquote: "`", Backslash: "\\", IntlBackslash: "`", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Tab: "Tab", Enter: "Enter", NumpadEnter: "Enter", Escape: "Escape", Space: "Space", Backspace: "Backspace", Delete: "Delete",
};

/** The key pressed, as "Ctrl+Alt+Shift+Cmd+K"; null for a modifier alone. */
function keyCombo(e) {
  const c = e.code || "";
  let k = c.startsWith("Key") ? c.slice(3) : c.startsWith("Digit") ? c.slice(5) : CODE_KEYS[c] ?? (/^F\d{1,2}$/.test(c) ? c : null);
  if (!k) {
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"].includes(e.key)) return null;
    k = e.key?.length === 1 ? e.key.toUpperCase() : e.key;
  }
  if (!k) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd", k].filter(Boolean).join("+");
}

/** A key with its modifiers in the one order ("Cmd+Shift+D" -> "Shift+Cmd+D"). */
function keyNorm(combo) {
  const parts = String(combo).split("+");
  const key = parts.pop();
  const order = ["Ctrl", "Alt", "Shift", "Cmd"];
  return [...order.filter((m) => parts.includes(m)), key].join("+");
}

/** An action's keys: yours from Settings, else its defaults. */
function keysOf(settings, id) {
  const mine = settings?.keys?.[id];
  if (Array.isArray(mine)) return mine.map(keyNorm);
  return KEY_ACTIONS.find((a) => a.id === id)?.keys ?? [];
}

/** Does the event press one of the action's keys? */
function keyIs(settings, e, id) {
  const combo = keyCombo(e);
  return !!combo && keysOf(settings, id).includes(combo);
}

/** The action (of those `where` lists) the event's keys are bound to. */
function keyActionFor(settings, e, where) {
  const combo = keyCombo(e);
  if (!combo) return null;
  return KEY_ACTIONS.find((a) => where.includes(a.where) && keysOf(settings, a.id).includes(combo))?.id ?? null;
}

/** What already uses this key (another action, a fixed key, macOS), else null. */
const KEY_MACOS = "macOS"; // keyConflict's answer for macOS's own keys
function keyConflict(settings, combo, forId) {
  combo = keyNorm(combo);
  const other = KEY_ACTIONS.find((a) => a.id !== forId && keysOf(settings, a.id).includes(combo));
  if (other) return other.label();
  const fixed = KEY_FIXED.find((f) => f.keys.includes(combo));
  if (fixed) return fixed.label();
  if (KEY_SYSTEM.includes(combo)) return KEY_MACOS;
  return null;
}

/** Why a key can't be a shortcut (null: it can). */
function keyProblem(combo) {
  const parts = combo.split("+");
  const key = parts.pop();
  const strong = parts.some((m) => m === "Cmd" || m === "Ctrl" || m === "Alt");
  // Plain keys (and ⇧ with a letter) are for typing.
  if (!strong && !/^F\d{1,2}$/.test(key) && !(parts.includes("Shift") && key === "Tab")) return tx("Use ⌘, ⌃ or ⌥ with it: plain keys are for typing.");
  return null;
}

const KEY_GLYPHS = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };
const KEY_NAMES = { Up: "↑", Down: "↓", Left: "←", Right: "→", Tab: "⇥", Enter: "↩", Escape: "⎋", Backspace: "⌫", Delete: "⌦", Space: "Space" };
/** "Shift+Cmd+D" as macOS shows it: ⇧⌘D (⌃⌥⇧⌘ order). */
function keyLabel(combo) {
  const parts = combo.split("+");
  const key = parts.pop();
  const order = ["Ctrl", "Alt", "Shift", "Cmd"];
  return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => KEY_GLYPHS[m] ?? m).join("") + (KEY_NAMES[key] ?? key);
}

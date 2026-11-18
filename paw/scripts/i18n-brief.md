# Translating Paw's UI (English → German, Turkish)

Paw is a macOS app (Tauri; vanilla JS UI in `paw/ui/`). It now has a language
setting: English (default), Deutsch, Türkçe. The machinery is in place:

- `paw/ui/i18n.js` defines `tx(text, vars)`: returns the text in the user's
  language with `{name}` placeholders filled from `vars`. The English text is
  the key; a missing translation falls back to English. It's a global loaded
  before every other script, so `tx` works anywhere, including in top-level
  constants (the language is known when scripts load).
- Static HTML (`index.html`, `prefs.html`, `about.html`) is translated
  automatically after load: any text node, `title`, `placeholder` or
  `aria-label` whose whole (trimmed) text is a key. So for HTML you mostly
  don't edit the markup: you add dictionary entries for its texts. Text with
  inline markup (`Switch any tab with <code>⇧Tab</code> or …`) is split into
  several text nodes, so add a `data-i18n` attribute to its element (e.g.
  `<p class="hint" data-i18n>`): that element is translated whole, and its key
  is its innerHTML, trimmed, with runs of whitespace collapsed to one space.
  Its translation is HTML too (keep the same tags).
- Dictionaries: `paw/ui/i18n/de/<part>.js` and `paw/ui/i18n/tr/<part>.js`, each
  `I18N.add("de", { "English": "Deutsch", ... });`. You own exactly the two
  files named in your task; never edit anyone else's.
- Checker: `node paw/scripts/i18n-check.js <file.js>` lists tx() keys without a
  German or Turkish entry, keys built at run time, and placeholder mismatches.
  It must report 0 problems for your files when you're done.

## What to wrap

Every text a person sees in Paw's UI: button labels, headings, menu items,
tooltips (`title=`), placeholders, status texts, empty states, hints, help
rows, messages shown in a tab (`sys(S, …)`, `info(S, …)`), `confirm()` and
`alert()` texts, error messages the UI composes, aria-labels.

Write it as `tx("Run now")`. With values: `tx("Started {name} in {folder}", { name: esc(f.name), folder: esc(dir) })`
— never `tx(\`Started ${x}\`)` (the key must be a fixed string).

- HTML in a sentence: keep the markup inside the key when it's part of the
  sentence (`tx("Press <b>Run now</b> to start", …)`), and keep escaping as
  the code does now (escape values before passing them in when the result goes
  into innerHTML). Prefer splitting so markup stays out of keys when that's easy.
- Plurals: two keys — `tx(n === 1 ? "{n} step" : "{n} steps", { n })`.
- Sentences glued from pieces: turn them into one key with placeholders, so a
  translator can reorder words. Don't translate fragments that only make sense
  in English word order.
- Keep keys exactly the current English text (don't reword while wrapping).

## What NOT to wrap

- Text sent to a model or agent: planner prompts, step prompts, factory node
  prompts, `FACTORY_FORMAT`, auto-review prompts, anything built into a prompt.
  These stay English (Paw Agent is separately told the user's language).
- Slash commands and their syntax (`/plan`, `/factory run <name>`), keyboard
  shortcuts (⌘K), file paths, URLs, model ids, product names (Paw, Paw Agent,
  Claude, GitHub Copilot, Ollama, MCP).
- Identifiers: CSS classes, data attributes, event names, settings keys and
  values, state values used as keys (`"running"`, `"done"`) — but a map from a
  state to its *displayed* text (like `STEP_STATE_TEXT`) has displayed values: wrap those.
- Strings the code matches or compares later. Before wrapping a `sys()` text or
  a label, search the file (and the other ui/*.js) for regexes or comparisons
  on it (e.g. `dropRestoreNotes` matches `— restored after restart`). If the
  code matches it, either leave it English or change the matcher so it still
  works in every language (prefer a flag on the line object over text matching).
- console.log/error, comments, test fixtures.

## Glossary (keep it consistent)

| English | Deutsch | Türkçe |
|---|---|---|
| tab | Tab | sekme |
| session | Sitzung | oturum |
| agent | Agent | ajan |
| model | Modell | model |
| plan (noun) | Plan | plan |
| step | Schritt | adım |
| factory | Fabrik | fabrika |
| node | Knoten | düğüm |
| run (noun) | Lauf | çalıştırma |
| trigger | Auslöser | tetikleyici |
| queued | in der Warteschlange | sırada |
| approval | Freigabe | onay |
| approve / reject | Freigeben / Ablehnen | Onayla / Reddet |
| allow / deny | Erlauben / Ablehnen | İzin ver / Reddet |
| shell | Shell | kabuk |
| prompt (the input box / what you type) | Eingabe | istem |
| skills | Skills | beceriler |
| plugins | Plugins | eklentiler |
| settings | Einstellungen | Ayarlar |
| folder | Ordner | klasör |
| sign in | Anmelden | Giriş yap |
| webhook | Webhook | webhook |
| Paw, Paw Agent, MCP | unchanged | unchanged |

German: informal “du”, like macOS/modern apps; natural, short UI German, not
word-for-word. Turkish: polite imperative (“Seçin”, “Çalıştırın”), proper
Turkish letters (ç ğ ı İ ö ş ü), natural UI Turkish. Keep the English
punctuation conventions Paw uses (“…”, “·”, “—”) and keep the same tone:
plain, friendly, short.

## When you're done

- `node -e "new Function(require('fs').readFileSync('<file>','utf8'))"` passes for
  every file you edited (including your two dictionary files).
- `node paw/scripts/i18n-check.js <your .js files>` reports 0 problems.
- Report: how many strings you wrapped, anything you deliberately left in
  English and why, and any matcher you changed.

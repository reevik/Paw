// Paw's languages: English (the source text), German and Turkish.
//
// tx("English text", { name: "x" }) gives the text in the language picked in
// Settings › General › Language, with {name} filled in. The English text is
// the key: a missing translation falls back to it. The translations live in
// i18n/<lang>/<part>.js, each adding its strings with I18N.add(lang, {...}).
//
// Static HTML (index.html, prefs.html, about.html) is translated when the page
// has loaded: text and title/placeholder/aria-label attributes whose whole
// text is a key, and elements marked data-i18n as a whole (their HTML is the key). The language is kept in localStorage too, so it's known
// before the settings arrive (strings built while the scripts load use it).
"use strict";

const I18N = {
  lang: "en",
  langs: { en: "English", de: "Deutsch", tr: "Türkçe" },
  locales: { en: "en-US", de: "de-DE", tr: "tr-TR" },
  dicts: { de: {}, tr: {} },
  add(lang, entries) {
    Object.assign((this.dicts[lang] ??= {}), entries);
  },
  /** The language to show: one Paw knows, else English. */
  pick(lang) {
    return lang && Object.hasOwn(this.langs, lang) ? lang : "en";
  },
  locale() {
    return this.locales[this.lang] ?? "en-US";
  },
  /** Remember the language for the next load (the caller reloads). */
  remember(lang) {
    try { localStorage.setItem("paw.lang", this.pick(lang)); } catch {}
  },
  /** Translate a page's static text in place. */
  translateDom(root = document.body) {
    if (this.lang === "en" || !root) return;
    const dict = this.dicts[this.lang] ?? {};
    if (root === document.body && Object.hasOwn(dict, document.title)) document.title = dict[document.title];
    // An element marked data-i18n is translated whole: its HTML (spaces
    // collapsed) is the key, for text with inline markup like <code>⇧Tab</code>.
    for (const el of root.querySelectorAll("[data-i18n]")) {
      const key = el.innerHTML.trim().replace(/\s+/g, " ");
      if (Object.hasOwn(dict, key)) el.innerHTML = dict[key];
    }
    const skip = "script, style, code, pre, textarea, [data-i18n], .output, .xterm, .tk-md, .tk-pre";
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const s = n.nodeValue.trim();
      if (!s || !Object.hasOwn(dict, s) || n.parentElement?.closest(skip)) continue;
      n.nodeValue = n.nodeValue.replace(s, dict[s]);
    }
    for (const el of root.querySelectorAll("[title], [placeholder], [aria-label]")) {
      for (const a of ["title", "placeholder", "aria-label"]) {
        const v = el.getAttribute(a)?.trim();
        if (v && Object.hasOwn(dict, v)) el.setAttribute(a, dict[v]);
      }
    }
  },
};

try { I18N.lang = I18N.pick(localStorage.getItem("paw.lang")); } catch {}
document.documentElement.lang = I18N.lang;

/** The text in the user's language, {name}s filled in from `vars`. */
function tx(text, vars) {
  let out = text;
  if (I18N.lang !== "en") {
    const d = I18N.dicts[I18N.lang];
    if (d && Object.hasOwn(d, text)) out = d[text];
  }
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  return out;
}

document.addEventListener("DOMContentLoaded", () => I18N.translateDom());

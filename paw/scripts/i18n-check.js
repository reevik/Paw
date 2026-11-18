#!/usr/bin/env node
// Checks Paw's translations: every tx("…") key in the UI's scripts has a
// German and a Turkish entry, no key is built at run time (tx(`…${x}…`)), and
// every translation keeps its {placeholders}.
//
//   node paw/scripts/i18n-check.js            # all of ui/*.js
//   node paw/scripts/i18n-check.js app.js     # one file
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ui = path.join(__dirname, "..", "ui");
const ctx = { I18N: { dicts: { de: {}, tr: {} }, add(l, e) { Object.assign((this.dicts[l] ??= {}), e); } } };
vm.createContext(ctx);
for (const lang of ["de", "tr"]) {
  for (const f of fs.readdirSync(path.join(ui, "i18n", lang)).filter((f) => f.endsWith(".js"))) {
    try { vm.runInContext(fs.readFileSync(path.join(ui, "i18n", lang, f), "utf8"), ctx, { filename: `${lang}/${f}` }); }
    catch (e) { console.log(`✗ i18n/${lang}/${f}: ${e.message}`); process.exitCode = 1; }
  }
}
const dicts = ctx.I18N.dicts;

const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(ui).filter((f) => f.endsWith(".js") && f !== "i18n.js");
// Each tx( call's first argument: every string literal in it is a key (so
// tx(n === 1 ? "{n} step" : "{n} steps", …) counts both).
function firstArgStrings(src, at) {
  const out = [];
  let i = at, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, raw = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; continue; } raw += src[j++]; }
      out.push({ quote: c, raw, at: i });
      i = j + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) break;
    i++;
  }
  return out;
}
const unescape = (raw) => { try { return JSON.parse(`"${raw.replace(/\\'/g, "'").replace(/\\`/g, "`").replace(/(^|[^\\])"/g, '$1\\"')}"`); } catch { return raw; } };
let keys = 0, missing = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(ui, f), "utf8");
  for (const m of src.matchAll(/\btx\(/g)) {
    const line = src.slice(0, m.index).split("\n").length;
    const strs = firstArgStrings(src, m.index + m[0].length);
    if (!strs.length) continue; // tx(variable): checked where the variable's strings are
    for (const { quote, raw } of strs) {
      if (quote === "`" && raw.includes("${")) { console.log(`✗ ${f}:${line} builds its key at run time: tx(\`${raw.slice(0, 60)}…\`) — use {name} and tx("…", { name })`); process.exitCode = 1; continue; }
      const key = unescape(raw);
      keys++;
      const vars = (key.match(/\{\w+\}/g) ?? []).sort().join(",");
      for (const lang of ["de", "tr"]) {
        const v = dicts[lang][key];
        if (v === undefined) { missing++; console.log(`✗ ${f}:${line} no ${lang}: ${JSON.stringify(key).slice(0, 100)}`); process.exitCode = 1; }
        else if ((v.match(/\{\w+\}/g) ?? []).sort().join(",") !== vars) { console.log(`✗ ${f}:${line} ${lang} changes the placeholders: ${JSON.stringify(key).slice(0, 80)}`); process.exitCode = 1; }
      }
    }
  }
}
console.log(`${keys} tx() calls checked in ${files.length} file(s); ${missing} translation(s) missing.`);

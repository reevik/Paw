// Terminal themes — shared by the main window and Settings.
//
// A theme is { id, name, appearance: "light"|"dark", background, foreground,
// cursor, selection, palette: [16 hex colors] }. Built-ins define the 8 base
// colors; the bright half of the palette is derived.

(function () {
  // ---------- color helpers ----------
  function parseHex(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}/i.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const toHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  function mix(a, b, t) {
    const x = parseHex(a), y = parseHex(b);
    if (!x || !y) return a;
    return toHex(x.map((v, i) => v + (y[i] - v) * t));
  }
  function rgba(hex, alpha) {
    const c = parseHex(hex) || [0, 0, 0];
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
  }
  /** Relative luminance, 0 (black) … 1 (white). */
  function luminance(hex) {
    const c = (parseHex(hex) || [0, 0, 0]).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function derivePalette(base, t) {
    const dark = t.appearance === "dark";
    const bright = base.map((c, i) => {
      if (i === 0) return mix(t.foreground, t.background, 0.5);
      if (i === 7) return dark ? mix(t.foreground, "#ffffff", 0.5) : mix(t.background, "#000000", 0.08);
      return dark ? mix(c, "#ffffff", 0.22) : mix(c, "#ffffff", 0.12);
    });
    return [...base, ...bright];
  }

  function normalize(t) {
    const theme = { ...t };
    theme.appearance = theme.appearance || (luminance(theme.background) < 0.4 ? "dark" : "light");
    const pal = (theme.palette || []).filter((c) => parseHex(c));
    theme.palette = pal.length >= 16 ? pal.slice(0, 16)
      : pal.length >= 8 ? derivePalette(pal.slice(0, 8), theme)
      : derivePalette(BUILTIN[theme.appearance === "dark" ? 0 : 5].base, theme);
    theme.cursor = parseHex(theme.cursor) ? theme.cursor : theme.palette[4];
    theme.selection = parseHex(theme.selection) ? theme.selection : mix(theme.background, theme.cursor, 0.3);
    return theme;
  }

  // ---------- built-in themes ----------
  const BUILTIN = [
    { id: "paw-dark", name: "Paw Dark", appearance: "dark", background: "#101014", foreground: "#e4e4e7", cursor: "#7dcfff", selection: "#2a3a52",
      base: ["#2a2b36", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] },
    { id: "midnight-tide", name: "Midnight Tide", appearance: "dark", background: "#0b1622", foreground: "#d6e2ee", cursor: "#4fd6be", selection: "#1c3550",
      base: ["#13202e", "#ff6b7a", "#4fd6a0", "#f2c36b", "#5ca8ff", "#b48cff", "#4fd6be", "#c5d4e3"] },
    { id: "ember", name: "Ember", appearance: "dark", background: "#17110c", foreground: "#f1e3cf", cursor: "#ffb547", selection: "#3a2a18",
      base: ["#2a1f16", "#ff6a3d", "#b8c25a", "#ffb547", "#d49a62", "#e38a6e", "#d8b56a", "#e8d6bd"] },
    { id: "moss", name: "Moss", appearance: "dark", background: "#121612", foreground: "#dfe6d8", cursor: "#9fd479", selection: "#26331f",
      base: ["#1f261e", "#e5786d", "#9fd479", "#e3c56f", "#7fb0c9", "#c39ac9", "#79c7a8", "#cdd6c4"] },
    { id: "graphite", name: "Graphite", appearance: "dark", background: "#1b1b1d", foreground: "#e6e4e1", cursor: "#f08d5a", selection: "#3a3633",
      base: ["#2a2a2d", "#e06c5f", "#a8b882", "#d9b26f", "#8aa1b8", "#b393ad", "#86b3a8", "#cfccc7"] },
    { id: "paw-light", name: "Paw Light", appearance: "light", background: "#ffffff", foreground: "#1f2328", cursor: "#0a6cff", selection: "#cfe2ff",
      base: ["#24292f", "#cf222e", "#1a7f37", "#9a6700", "#0969da", "#8250df", "#1b7c83", "#6e7781"] },
    { id: "parchment", name: "Parchment", appearance: "light", background: "#fbf6ea", foreground: "#3b3226", cursor: "#c0623a", selection: "#efdcc0",
      base: ["#3b3226", "#b8432f", "#6a8a2e", "#b07d1a", "#3f6fa8", "#8c4f9e", "#2f8a83", "#a39784"] },
    { id: "seafoam", name: "Seafoam", appearance: "light", background: "#f1faf7", foreground: "#1f3330", cursor: "#12a08a", selection: "#c6ebe3",
      base: ["#1f3330", "#c44a4a", "#2e8a57", "#a17b16", "#2f6fb0", "#8a55b5", "#12a08a", "#8fa6a1"] },
    { id: "sakura", name: "Sakura", appearance: "light", background: "#fdf5f7", foreground: "#3a2a30", cursor: "#d94f7a", selection: "#f6d3de",
      base: ["#3a2a30", "#c93d5c", "#4f8a4a", "#b07a1f", "#4b6fb5", "#a24fa8", "#2e8f95", "#a8939a"] },
    { id: "fog", name: "Fog", appearance: "light", background: "#f3f4f6", foreground: "#2b2f36", cursor: "#5b6bd8", selection: "#d6dbf5",
      base: ["#2b2f36", "#c0463f", "#3f8a4f", "#a8781a", "#4a62c9", "#8b55b8", "#2f8798", "#8c919b"] },
  ];
  const BUILTIN_THEMES = BUILTIN.map((b) => normalize({ ...b, palette: b.base, builtin: true }));

  function allThemes(settings) {
    const custom = (settings?.appearance?.custom || []).filter((t) => t && t.id && t.background).map(normalize);
    return [...custom, ...BUILTIN_THEMES];
  }
  const systemAppearance = () => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  /** The theme (and whether ANSI colors are on) for the current appearance. */
  function activeTheme(settings, appearance = systemAppearance()) {
    const ap = settings?.appearance || {};
    const id = appearance === "dark" ? ap.dark : ap.light;
    const list = allThemes(settings).filter((t) => t.appearance === appearance);
    const theme = list.find((t) => t.id === id) || list.find((t) => t.id === `paw-${appearance}`);
    const extended = (appearance === "dark" ? ap.dark_extended : ap.light_extended) !== false;
    return { theme, extended };
  }

  /** CSS custom properties for the terminal surface. */
  function themeVars(t, opacity = 0.94) {
    const dark = t.appearance === "dark";
    const p = t.palette;
    const v = {
      "--t-bg": rgba(t.background, Math.max(0.3, Math.min(1, opacity))),
      "--t-bg-solid": t.background,
      "--t-fg": t.foreground,
      "--t-strong": dark ? mix(t.foreground, "#ffffff", 0.6) : mix(t.foreground, "#000000", 0.45),
      "--t-dim": mix(t.foreground, t.background, 0.45),
      "--t-accent": t.cursor,
      "--t-red": p[1], "--t-green": p[2], "--t-yellow": p[3], "--t-blue": p[4], "--t-purple": p[5], "--t-cyan": p[6],
      "--t-border": rgba(t.foreground, 0.14),
      "--t-hover": rgba(t.foreground, 0.05),
      "--t-input-bg": rgba(t.foreground, 0.03),
      "--t-surface": rgba(mix(t.background, t.foreground, dark ? 0.07 : 0.03), 0.97),
      "--t-selbg": rgba(t.cursor, 0.18),
      "--t-selection": rgba(t.selection, dark ? 0.75 : 0.9),
      "--t-glow": rgba(t.cursor, dark ? 0.10 : 0.06),
      // chrome tokens inside the session (pills, scrollbars…)
      "--text": t.foreground,
      "--text-2": mix(t.foreground, t.background, 0.35),
      "--text-3": mix(t.foreground, t.background, 0.55),
      "--hair": rgba(t.foreground, 0.08),
      "--card-2": rgba(t.foreground, 0.06),
      "--hover": rgba(t.foreground, 0.09),
      "color-scheme": t.appearance,
    };
    p.forEach((c, i) => (v[`--ansi-${i}`] = c));
    return v;
  }

  /** The window around the tabs (tab bar, sidebar, status bar) in the theme's colors. */
  function chromeVars(t) {
    const dark = t.appearance === "dark";
    const bg = t.background, fg = t.foreground;
    return {
      "--main-solid": dark ? mix(bg, fg, 0.045) : bg,
      "--card": dark ? rgba(mix(bg, fg, 0.14), 0.85) : rgba(mix(bg, "#ffffff", 0.6), 0.9),
      "--card-2": rgba(fg, dark ? 0.045 : 0.035),
      "--hover": rgba(fg, dark ? 0.06 : 0.05),
      "--selected": rgba(fg, dark ? 0.1 : 0.08),
      "--hair": rgba(fg, 0.09),
      "--text": fg,
      "--text-2": mix(fg, bg, 0.35),
      "--text-3": mix(fg, bg, 0.55),
      // The sidebar's tint over the native blur (it steadies the background
      // whatever the wallpaper), in the theme's hue, and its stronger text.
      "--sidebar-bg": dark ? rgba(mix(bg, "#000000", 0.1), 0.5) : rgba(mix(bg, "#ffffff", 0.4), 0.4),
      "--side-text-2": mix(fg, bg, 0.18),
      "--side-text-3": mix(fg, bg, 0.38),
    };
  }

  function applyChrome(el, theme) {
    if (!el || !theme) return;
    for (const [k, val] of Object.entries(chromeVars(theme))) el.style.setProperty(k, val);
  }

  function applyTheme(el, theme, extended, opacity) {
    if (!el || !theme) return;
    for (const [k, val] of Object.entries(themeVars(theme, opacity))) {
      if (k === "color-scheme") el.style.colorScheme = val;
      else el.style.setProperty(k, val);
    }
    el.dataset.appearance = theme.appearance;
    el.dataset.ansi = extended ? "on" : "off";
  }

  // ---------- ANSI (SGR) → HTML ----------
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function xterm256(n) {
    if (n < 16) return `var(--ansi-${n})`;
    if (n >= 232) { const g = 8 + 10 * (n - 232); return toHex([g, g, g]); }
    n -= 16;
    const lv = (x) => (x ? 55 + x * 40 : 0);
    return toHex([lv(Math.floor(n / 36)), lv(Math.floor(n / 6) % 6), lv(n % 6)]);
  }
  function applySgr(st, params) {
    const codes = params === "" ? [0] : params.split(";").map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.keys(st).forEach((k) => delete st[k]);
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 9) st.strike = true;
      else if (c === 22) { delete st.bold; delete st.dim; }
      else if (c === 23) delete st.italic;
      else if (c === 24) delete st.underline;
      else if (c === 27) delete st.inverse;
      else if (c === 29) delete st.strike;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c === 39) delete st.fg;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 49) delete st.bg;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) { st[key] = codes[i + 2]; i += 2; }
        else if (codes[i + 1] === 2) { st[key] = toHex([codes[i + 2], codes[i + 3], codes[i + 4]]); i += 4; }
      }
    }
  }
  function sgrCss(st, extended) {
    const css = [];
    if (extended) {
      const color = (v) => (typeof v === "number" ? xterm256(v) : v);
      let fg = st.fg != null ? color(st.fg) : null;
      let bg = st.bg != null ? color(st.bg) : null;
      if (st.inverse) { [fg, bg] = [bg || "var(--t-bg-solid)", fg || "var(--t-fg)"]; }
      if (fg) css.push(`color:${fg}`);
      if (bg) css.push(`background:${bg}`);
    }
    if (st.bold) css.push("font-weight:700");
    if (st.dim) css.push("opacity:.65");
    if (st.italic) css.push("font-style:italic");
    if (st.underline || st.strike) css.push(`text-decoration:${st.underline ? "underline" : ""} ${st.strike ? "line-through" : ""}`);
    return css.join(";");
  }
  /** Turn a line with SGR escapes into escaped HTML with styled spans. */
  function ansiToHtml(text, extended = true) {
    text = String(text ?? "");
    if (!text.includes("\x1b")) return escHtml(text);
    const re = /\x1b\[([\d;]*)m/g;
    const st = {};
    let out = "", last = 0, m;
    const flush = (chunk) => {
      if (!chunk) return;
      const css = sgrCss(st, extended);
      out += css ? `<span style="${css}">${escHtml(chunk)}</span>` : escHtml(chunk);
    };
    while ((m = re.exec(text))) {
      flush(text.slice(last, m.index));
      applySgr(st, m[1]);
      last = re.lastIndex;
    }
    flush(text.slice(last));
    return out;
  }
  const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[\d;]*m/g, "");

  // ---------- import: Ghostty & iTerm ----------
  /** Keep 16 colors if all are present, else the first 8 (brights get derived), else none. */
  function completePalette(p) {
    const take = (n) => Array.from({ length: n }, (_, i) => p[i]);
    if (take(16).every(Boolean)) return take(16);
    if (take(8).every(Boolean)) return take(8);
    return [];
  }
  function parseGhostty(text) {
    const t = { palette: [] };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      const hex = (v) => (parseHex(v) ? "#" + v.replace(/^#/, "").slice(0, 6) : null);
      if (key === "palette") {
        const j = val.indexOf("=");
        const idx = Number(val.slice(0, j));
        if (j > 0 && idx >= 0 && idx < 16 && hex(val.slice(j + 1).trim())) t.palette[idx] = hex(val.slice(j + 1).trim());
      } else if (key === "background") t.background = hex(val);
      else if (key === "foreground") t.foreground = hex(val);
      else if (key === "cursor-color") t.cursor = hex(val);
      else if (key === "selection-background") t.selection = hex(val);
    }
    t.palette = completePalette(t.palette);
    return t;
  }

  function parseITerm(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const root = doc.querySelector("plist > dict");
    if (!root) throw new Error(tx("not an iTerm color file"));
    const t = { palette: [] };
    const kids = [...root.children];
    for (let i = 0; i < kids.length - 1; i++) {
      if (kids[i].tagName !== "key" || kids[i + 1].tagName !== "dict") continue;
      const name = kids[i].textContent.trim();
      const comp = {};
      const dk = [...kids[i + 1].children];
      for (let j = 0; j < dk.length - 1; j++) {
        if (dk[j].tagName === "key") comp[dk[j].textContent.trim()] = parseFloat(dk[j + 1].textContent);
      }
      if (comp["Red Component"] == null) continue;
      const hex = toHex(["Red", "Green", "Blue"].map((c) => (comp[`${c} Component`] || 0) * 255));
      const ansi = name.match(/^Ansi (\d+) Color$/);
      if (ansi && Number(ansi[1]) < 16) t.palette[Number(ansi[1])] = hex;
      else if (name === "Background Color") t.background = hex;
      else if (name === "Foreground Color") t.foreground = hex;
      else if (name === "Cursor Color") t.cursor = hex;
      else if (name === "Selection Color") t.selection = hex;
    }
    t.palette = completePalette(t.palette);
    return t;
  }

  /** Parse a Ghostty or iTerm theme file into a custom theme. */
  function importThemeFile(fileName, text) {
    const parsed = /<plist[\s>]/.test(text) ? parseITerm(text) : parseGhostty(text);
    if (!parsed.background || !parsed.foreground) throw new Error(tx("No background/foreground colors found in this file."));
    const name = fileName.replace(/\.(itermcolors|conf|txt|toml)$/i, "").replace(/[-_]+/g, " ").trim() || "Imported";
    return normalize({
      ...parsed,
      id: "custom-" + Math.random().toString(36).slice(2, 9),
      name,
      appearance: luminance(parsed.background) < 0.4 ? "dark" : "light",
    });
  }

  window.PawThemes = {
    BUILTIN_THEMES, allThemes, activeTheme, applyTheme, applyChrome, themeVars, normalize, systemAppearance,
    ansiToHtml, stripAnsi, importThemeFile, parseHex, mix, luminance,
  };
})();

// Task Graph 3D: a task's plan as a glowing 3D graph on its board ("3D",
// next to "Graph"). Plain WebGL on the canvas Paw hands over; no libraries.
//
// Dots: the task (the hub), its steps (colored by state, sized by how long
// they took) and the agents that run them (sized by how many). Lines join
// each step to the steps it needs, to its agent, and to the task. A force
// simulation lays them out: linked dots pull together, all push apart,
// steps lean left to right by what they need. Hover a dot to light up its
// neighborhood; click a step for its details; drag to turn, scroll to zoom,
// double-click to reset. Left alone, it drifts and turns slowly.

const COLORS = {
  task: [0.49, 0.86, 0.43],      // the hub: green
  agent: [0.78, 0.43, 0.91],     // agents: violet
  done: [0.34, 0.78, 0.64],      // teal
  running: [0.36, 0.78, 0.9],    // cyan, pulsing
  needs: [0.91, 0.43, 0.64],     // pink: waiting for you
  failed: [0.91, 0.51, 0.42],    // salmon
  stopped: [0.85, 0.72, 0.35],   // amber
  waiting: [0.55, 0.58, 0.68],   // slate
  skipped: [0.38, 0.4, 0.46],
};
const STATE_TEXT = { running: "running", needs: "needs you", done: "done", failed: "failed", stopped: "stopped", skipped: "skipped", waiting: "waiting", blocked: "running" };

// ---------- math (column-major 4×4) ----------
function mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(e, c, up) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
function project(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w, w];
}

// ---------- GL ----------
function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) { const a = gl.getActiveAttrib(p, i); loc[a.name] = gl.getAttribLocation(p, a.name); }
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
  return { p, loc };
}

const minutes = (s, now) => (s.startedAt ? ((s.endedAt ?? now) - s.startedAt) / 60000 : 0);
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
};
const shorten = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const parseHex = (css) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(css ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};

class Graph {
  constructor(ctx) {
    this.ctx = ctx;
    const gl = ctx.canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL isn't available");
    this.gl = gl;
    this.theme = ctx.theme || {};
    this.dark = this.theme.dark !== false;
    // The glow: a solid core and a soft halo, drawn as one point per dot.
    this.dots = program(gl, `
      attribute vec3 aPos; attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform mat4 uMVP; uniform float uScale; varying vec3 vColor; varying float vAlpha;
      void main() {
        gl_Position = uMVP * vec4(aPos, 1.0);
        gl_PointSize = aSize * uScale / gl_Position.w;
        vColor = aColor; vAlpha = aAlpha;
      }`, `
      precision mediump float; varying vec3 vColor; varying float vAlpha; uniform float uGlow;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p);
        if (r > 1.0) discard;
        float core = smoothstep(0.5, 0.45, r);
        float halo = exp(-r * r * 3.0) * uGlow;
        float a = max(core, halo) * vAlpha;
        vec3 c = mix(vColor * 0.85, vColor * 1.12, core);
        gl_FragColor = vec4(c * a, a);
      }`);
    this.lines = program(gl, `
      attribute vec3 aPos; attribute float aAlpha; uniform mat4 uMVP; varying float vAlpha;
      void main() { gl_Position = uMVP * vec4(aPos, 1.0); vAlpha = aAlpha; }`, `
      precision mediump float; varying float vAlpha; uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor * vAlpha, vAlpha); }`);
    this.text = program(gl, `
      attribute vec2 aPos; attribute vec2 aUV; varying vec2 vUV;
      void main() { vUV = aUV; gl_Position = vec4(aPos, 0.0, 1.0); }`, `
      precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform float uAlpha;
      void main() { gl_FragColor = texture2D(uTex, vUV) * uAlpha; }`);
    this.buf = gl.createBuffer();
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] ?? 256;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    this.lineColor = this.dark ? [0.56, 0.58, 0.9] : [0.38, 0.4, 0.62];
    this.textColor = parseHex(this.theme.fg) ?? (this.dark ? [0.9, 0.9, 0.92] : [0.15, 0.15, 0.18]);
    this.labels = new Map(); // text → { tex, w, h }
    this.cam = { yaw: 0.4, pitch: 0.22, zoom: 1 };
    this.touched = 0;
    this.hover = null;
    this.nodes = new Map(); // id → { id, kind, pos, vel, color, size, label, step? }
    this.edges = [];        // [a, b, kind]
    this.heat = 1;
    this.setTask(ctx.task);
    this.resize(ctx);
    ctx.on("resize", (s) => this.resize(s));
    ctx.on("task", (t) => this.setTask(t));
    ctx.on("pointer", (e) => this.pointer(e));
    ctx.on("wheel", (e) => { this.cam.zoom = Math.min(3, Math.max(0.3, this.cam.zoom * Math.exp(e.dy * 0.0015))); this.touched = performance.now(); });
    ctx.on("close", () => { this.closed = true; });
    this.visible = true;
    ctx.on("visible", (v) => { this.visible = !!v; });
    const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
    const loop = (t) => {
      if (this.closed) return;
      if (!this.visible) return setTimeout(() => loop(performance.now()), 500);
      this.step();
      this.draw(t);
      raf(loop);
    };
    raf(loop);
  }

  resize({ width, height, dpr }) {
    this.w = width; this.h = height; this.dpr = dpr || 1;
    this.ctx.canvas.width = Math.round(width * this.dpr);
    this.ctx.canvas.height = Math.round(height * this.dpr);
  }

  /** Dots and lines for the task; dots that were there keep their place. */
  setTask(task) {
    this.task = task;
    const steps = task?.steps ?? [];
    const now = Date.now();
    const byId = new Map(steps.map((s) => [s.id, s]));
    // How deep a step is (what it needs): the layout leans that way, left to right.
    const level = new Map();
    const lv = (s, seen) => {
      if (level.has(s.id)) return level.get(s.id);
      if (seen.has(s.id)) return 0;
      seen.add(s.id);
      const l = (s.needs ?? []).filter((n) => byId.has(n)).reduce((m, n) => Math.max(m, lv(byId.get(n), seen) + 1), 0);
      level.set(s.id, l);
      return l;
    };
    steps.forEach((s) => lv(s, new Set()));
    this.levels = Math.max(0, ...level.values()) + 1;
    const old = this.nodes;
    const nodes = new Map();
    const jitter = () => (Math.random() - 0.5) * 1.5;
    const place = (id, near) => old.get(id)?.pos ?? (near ? near.map((v) => v + jitter()) : [jitter() * 2, jitter() * 2, jitter() * 2]);
    const add = (id, kind, props) => {
      const n = { id, kind, pos: place(id, props.near), vel: old.get(id)?.vel ?? [0, 0, 0], ...props };
      nodes.set(id, n);
      return n;
    };
    const hub = add("task", "task", { color: COLORS.task, size: 1.0, label: shorten(task?.title || "Task", 40), sub: STATE_TEXT[task?.state] ?? "" });
    const agents = new Map();
    for (const s of steps) {
      const m = minutes(s, now);
      const state = s.state === "blocked" ? "running" : s.state;
      add(`s:${s.id}`, "step", {
        step: s.id, state, color: COLORS[state] ?? COLORS.waiting,
        size: 0.5 + Math.min(0.6, Math.sqrt(m) * 0.08), label: shorten(s.title, 34),
        sub: [STATE_TEXT[s.state] ?? s.state, s.startedAt && s.state !== "waiting" ? fmtTime((s.endedAt ?? now) - s.startedAt) : ""].filter(Boolean).join(" · "),
        level: level.get(s.id) ?? 0, near: hub.pos,
      });
      agents.set(s.agent, (agents.get(s.agent) ?? 0) + 1);
    }
    for (const [name, count] of agents) {
      add(`a:${name}`, "agent", { color: COLORS.agent, size: 0.55 + Math.min(0.4, count * 0.06), label: name || "agent", sub: `${count} step${count === 1 ? "" : "s"}` });
    }
    const edges = [];
    for (const s of steps) {
      for (const n of s.needs ?? []) if (byId.has(n)) edges.push([`s:${n}`, `s:${s.id}`, "needs"]);
      edges.push([`a:${s.agent}`, `s:${s.id}`, "agent"]);
      edges.push(["task", `s:${s.id}`, "task"]);
    }
    const changed = nodes.size !== old.size || [...nodes.keys()].some((k) => !old.has(k));
    this.nodes = nodes;
    this.edges = edges;
    this.neighbors = new Map([...nodes.keys()].map((k) => [k, new Set([k])]));
    for (const [a, b] of edges) { this.neighbors.get(a)?.add(b); this.neighbors.get(b)?.add(a); }
    if (changed) {
      this.heat = 1;
      for (let i = 0; i < 260; i++) this.step(true); // settle before the first frame
    }
  }

  /** One step of the layout: springs on lines, everything apart, a pull to the middle. */
  step(fast = false) {
    const nodes = [...this.nodes.values()];
    if (!nodes.length) return;
    const k = fast ? 1 : Math.max(0.04, this.heat);
    const force = nodes.map(() => [0, 0, 0]);
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].pos, b = nodes[j].pos;
      const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
      const l2 = Math.max(0.05, d0 * d0 + d1 * d1 + d2 * d2);
      const l = Math.sqrt(l2);
      const f = 2.2 / l2 / l;
      force[i][0] += d0 * f; force[i][1] += d1 * f; force[i][2] += d2 * f;
      force[j][0] -= d0 * f; force[j][1] -= d1 * f; force[j][2] -= d2 * f;
    }
    for (const [ia, ib, kind] of this.edges) {
      const i = index.get(ia), j = index.get(ib);
      if (i == null || j == null) continue;
      const a = nodes[i].pos, b = nodes[j].pos;
      const rest = kind === "needs" ? 1.9 : kind === "agent" ? 2.6 : 3.2;
      const strength = kind === "needs" ? 0.09 : kind === "agent" ? 0.035 : 0.02;
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = Math.hypot(d[0], d[1], d[2]) || 0.01;
      const f = (l - rest) * strength / l;
      for (let c = 0; c < 3; c++) { force[i][c] += d[c] * f; force[j][c] -= d[c] * f; }
    }
    nodes.forEach((n, i) => {
      const f = force[i];
      for (let c = 0; c < 3; c++) f[c] -= n.pos[c] * 0.012; // toward the middle
      // Steps lean left to right by what they need.
      if (n.kind === "step") f[0] += ((n.level - (this.levels - 1) / 2) * 1.6 - n.pos[0]) * 0.02;
      for (let c = 0; c < 3; c++) {
        n.vel[c] = (n.vel[c] + f[c] * k) * 0.82;
        n.pos[c] += Math.max(-0.5, Math.min(0.5, n.vel[c]));
      }
    });
    if (!fast) this.heat = Math.max(0.04, this.heat * 0.995); // settles, but keeps drifting a little
  }

  pointer(e) {
    // The dot under the pointer is picked each frame (dots move); this is where the pointer is.
    if (e.type === "pointermove" && !e.buttons) { this.mouse = { x: e.x, y: e.y }; this.touched = performance.now(); }
    if (e.type === "pointerleave") { this.mouse = null; this.hover = null; this.drag = null; }
    if (e.type === "pointerdown") { this.drag = { x: e.x, y: e.y, moved: 0 }; this.touched = performance.now(); }
    else if (e.type === "pointermove" && this.drag && e.buttons) {
      const dx = e.x - this.drag.x, dy = e.y - this.drag.y;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.drag.x = e.x; this.drag.y = e.y;
      this.cam.yaw -= dx * 0.008;
      this.cam.pitch = Math.max(-1.3, Math.min(1.3, this.cam.pitch + dy * 0.008));
      this.touched = performance.now();
    } else if (e.type === "pointerup") {
      if (this.drag && this.drag.moved < 5) {
        const n = this.pick(e.x, e.y);
        this.ctx.select(n?.step ?? null);
      }
      this.drag = null;
    } else if (e.type === "dblclick") {
      this.cam = { yaw: 0.4, pitch: 0.22, zoom: 1 };
      this.heat = 0.6;
    }
  }

  /** The dot under the pointer (front-most). */
  pick(x, y) {
    let best = null;
    for (const s of this.screen ?? []) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= s.r + 4 && (!best || s.z < best.z)) best = s;
    }
    return best?.node ?? null;
  }

  /** A label as a texture (cached by its text). */
  label(text, sub, strong) {
    const key = `${text}|${sub}|${strong}`;
    if (this.labels.has(key)) return this.labels.get(key);
    const S = 2; // drawn at 2× for sharp text
    const c = new OffscreenCanvas(8, 8);
    let g = c.getContext("2d");
    const f1 = `${strong ? 600 : 500} ${11 * S}px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif`;
    const f2 = `${10 * S}px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif`;
    g.font = f1;
    const w1 = g.measureText(text).width;
    g.font = f2;
    const w2 = sub ? g.measureText(sub).width : 0;
    const W = Math.ceil(Math.max(w1, w2) + 8 * S), H = Math.ceil((sub ? 30 : 16) * S);
    c.width = W; c.height = H;
    g = c.getContext("2d");
    const [r, gg, b] = this.textColor.map((v) => Math.round(v * 255));
    g.textAlign = "center";
    g.textBaseline = "top";
    // A soft shadow keeps text readable over lines.
    g.shadowColor = this.dark ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.9)";
    g.shadowBlur = 3 * S;
    g.font = f1;
    g.fillStyle = `rgba(${r},${gg},${b},0.95)`;
    g.fillText(text, W / 2, 1 * S);
    if (sub) {
      g.font = f2;
      g.fillStyle = `rgba(${r},${gg},${b},0.6)`;
      g.fillText(sub, W / 2, 15 * S);
    }
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const out = { tex, w: W / S, h: H / S };
    // Times change every second: don't keep every old one.
    if (this.labels.size > 400) {
      for (const [k, v] of this.labels) { gl.deleteTexture(v.tex); this.labels.delete(k); if (this.labels.size < 200) break; }
    }
    this.labels.set(key, out);
    return out;
  }

  draw(t) {
    const gl = this.gl;
    if (!this.drag && !this.mouse && performance.now() - this.touched > 4000) this.cam.yaw += 0.0016;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const nodes = [...this.nodes.values()];
    if (!nodes.length) return;

    // Fit the camera to the graph (a sphere around it), then the user's zoom.
    const center = [0, 0, 0];
    for (const n of nodes) for (let c = 0; c < 3; c++) center[c] += n.pos[c] / nodes.length;
    let radius = 1;
    for (const n of nodes) radius = Math.max(radius, Math.hypot(n.pos[0] - center[0], n.pos[1] - center[1], n.pos[2] - center[2]) + n.size * 0.5);
    this.center = this.center ? this.center.map((v, i) => v + (center[i] - v) * 0.05) : center;
    this.radius = this.radius ? this.radius + (radius - this.radius) * 0.05 : radius;
    const fov = 0.8, aspect = this.w / Math.max(1, this.h);
    const half = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect)) / 2;
    const d = (this.radius / Math.sin(half)) * 1.05 * this.cam.zoom;
    const { yaw, pitch } = this.cam;
    const c0 = this.center;
    const eye = [c0[0] + Math.cos(pitch) * Math.sin(yaw) * d, c0[1] + Math.sin(pitch) * d, c0[2] + Math.cos(pitch) * Math.cos(yaw) * d];
    // this.fit narrows or widens the view so the graph fills the board (learned
    // from the last frame); the camera keeps its distance, so near dots don't balloon.
    this.fit = this.fit ?? 1;
    const view = 2 * Math.atan(Math.tan(fov / 2) * this.fit);
    const vp = mul(perspective(view, aspect, 0.1, 500), lookAt(eye, c0, [0, 1, 0]));
    const focal = this.h / 2 / Math.tan(view / 2); // CSS px per world unit at distance 1
    const pulse = 0.75 + 0.25 * Math.sin(t / 260);

    // What's lit: the hovered dot and its neighbors (else the selected step's), else everything.
    const sel = this.task?.selected ? `s:${this.task.selected}` : null;
    const focus = this.hover?.id ?? (sel && this.nodes.has(sel) ? sel : null);
    const lit = focus ? this.neighbors.get(focus) : null;
    const dim = (id) => (lit && !lit.has(id) ? 0.22 : 1);

    // Lines.
    const lineData = [];
    for (const [a, b, kind] of this.edges) {
      const A = this.nodes.get(a), B = this.nodes.get(b);
      if (!A || !B) continue;
      const on = lit ? a === focus || b === focus : false;
      const base = kind === "needs" ? 0.55 : kind === "agent" ? 0.28 : 0.16;
      const alpha = on ? 0.95 : base * (lit ? 0.35 : 1);
      lineData.push(...A.pos, alpha, ...B.pos, alpha);
    }
    gl.useProgram(this.lines.p);
    gl.uniformMatrix4fv(this.lines.loc.uMVP, false, vp);
    gl.uniform3fv(this.lines.loc.uColor, this.lineColor);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.lines.loc.aPos);
    gl.enableVertexAttribArray(this.lines.loc.aAlpha);
    gl.vertexAttribPointer(this.lines.loc.aPos, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.lines.loc.aAlpha, 1, gl.FLOAT, false, 16, 12);
    if (lineData.length) gl.drawArrays(gl.LINES, 0, lineData.length / 4);
    gl.disableVertexAttribArray(this.lines.loc.aPos);
    gl.disableVertexAttribArray(this.lines.loc.aAlpha);

    // Dots, far ones first.
    const sizeScale = focal * this.dpr * 2.7;
    const screen = nodes.map((n) => {
      const p = project(vp, n.pos);
      // The core's radius on screen, in CSS px (the core is half the sprite's radius).
      const sprite = Math.min(this.maxPoint, n.size * sizeScale / p[3]) / this.dpr;
      return { node: n, x: (p[0] * 0.5 + 0.5) * this.w, y: (0.5 - p[1] * 0.5) * this.h, z: p[2], w: p[3], r: sprite * 0.25, ndc: p };
    }).filter((s) => s.w > 0);
    // Fill the board: how far the dots reach on screen, against a margin for labels.
    let reach = 0.01;
    for (const s of screen) reach = Math.max(reach, Math.abs(s.ndc[0]) / (1 - 120 / this.w), Math.abs(s.ndc[1]) / (1 - 70 / this.h));
    if (!this.drag) this.fit = Math.min(2, Math.max(0.3, this.fit * (1 + (reach / 0.92 - 1) * 0.08)));
    this.hover = this.mouse && !this.drag ? this.pick(this.mouse.x, this.mouse.y) : null;
    screen.sort((a, b) => b.z - a.z);
    this.screen = screen;
    const dotData = [];
    for (const s of screen) {
      const n = s.node;
      const k = n.state === "running" || n.state === "needs" ? pulse : 1;
      const color = n.color.map((c) => c * k);
      const big = n.id === focus ? 1.25 : 1;
      dotData.push(...n.pos, ...color, n.size * big, dim(n.id) * (n.state === "skipped" ? 0.6 : 1));
    }
    gl.useProgram(this.dots.p);
    gl.uniformMatrix4fv(this.dots.loc.uMVP, false, vp);
    gl.uniform1f(this.dots.loc.uScale, sizeScale);
    gl.uniform1f(this.dots.loc.uGlow, this.dark ? 0.85 : 0.45);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dotData), gl.DYNAMIC_DRAW);
    const stride = 32;
    const L0 = this.dots.loc;
    for (const a of [L0.aPos, L0.aColor, L0.aSize, L0.aAlpha]) gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(L0.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(L0.aColor, 3, gl.FLOAT, false, stride, 12);
    gl.vertexAttribPointer(L0.aSize, 1, gl.FLOAT, false, stride, 24);
    gl.vertexAttribPointer(L0.aAlpha, 1, gl.FLOAT, false, stride, 28);
    gl.drawArrays(gl.POINTS, 0, dotData.length / 8);
    for (const a of [L0.aPos, L0.aColor, L0.aSize, L0.aAlpha]) gl.disableVertexAttribArray(a);

    // Labels under the dots, in screen space; far and unlit ones fainter.
    gl.useProgram(this.text.p);
    gl.enableVertexAttribArray(this.text.loc.aPos);
    gl.enableVertexAttribArray(this.text.loc.aUV);
    const zs = screen.map((s) => s.w);
    const near = Math.min(...zs), far = Math.max(...zs);
    // Which labels fit: the focused one, the task, its neighbors and agents first, then nearer ones.
    const rank = (s) => (s.node.id === focus ? 0 : s.node.kind === "task" ? 1 : lit?.has(s.node.id) ? 2 : s.node.kind === "agent" ? 3 : 4) * 1e4 + s.w;
    const placed = [];
    const shown = new Set();
    for (const s of [...screen].sort((a, b) => rank(a) - rank(b))) {
      const n = s.node;
      const showSub = n.kind === "task" || n.id === focus || (lit && lit.has(n.id));
      const L = this.label(n.label, showSub ? n.sub : "", n.kind !== "step" || n.id === focus);
      const box = [s.x - L.w / 2 + 6, s.y + s.r + 5, s.x + L.w / 2 - 6, s.y + s.r + 5 + L.h - 4];
      if (n.id !== focus && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      shown.add(s);
    }
    for (const s of screen) {
      if (!shown.has(s)) continue;
      const n = s.node;
      const strong = n.kind !== "step" || n.id === focus;
      const showSub = n.kind === "task" || n.id === focus || (lit && lit.has(n.id));
      const L = this.label(n.label, showSub ? n.sub : "", strong);
      const depth = far > near ? (s.w - near) / (far - near) : 0;
      const alpha = dim(n.id) * (n.id === focus ? 1 : 0.95 - depth * 0.45);
      const cx = s.x, top = s.y + s.r + 5;
      const x0 = (cx - L.w / 2) / this.w * 2 - 1, x1 = (cx + L.w / 2) / this.w * 2 - 1;
      const y0 = 1 - top / this.h * 2, y1 = 1 - (top + L.h) / this.h * 2;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, 0, 0, x1, y0, 1, 0, x1, y1, 1, 1, x0, y0, 0, 0, x1, y1, 1, 1, x0, y1, 0, 1]), gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(this.text.loc.aPos, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(this.text.loc.aUV, 2, gl.FLOAT, false, 16, 8);
      gl.uniform1f(this.text.loc.uAlpha, alpha);
      gl.bindTexture(gl.TEXTURE_2D, L.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.disableVertexAttribArray(this.text.loc.aPos);
    gl.disableVertexAttribArray(this.text.loc.aUV);

    // The selected step: a ring around its dot.
    const s = sel && screen.find((x) => x.node.id === sel);
    if (s) {
      const ring = [];
      const R = s.r * (focus === sel ? 1.25 : 1) + 5;
      for (let i = 0; i <= 48; i++) {
        const a = i / 48 * Math.PI * 2;
        ring.push((s.x + Math.cos(a) * R) / this.w * 2 - 1, 1 - (s.y + Math.sin(a) * R) / this.h * 2, 0, 0.9);
      }
      gl.useProgram(this.lines.p);
      gl.uniformMatrix4fv(this.lines.loc.uMVP, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
      gl.uniform3fv(this.lines.loc.uColor, parseHex(this.theme.accent) ?? [0.49, 0.81, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ring), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.lines.loc.aPos);
      gl.enableVertexAttribArray(this.lines.loc.aAlpha);
      gl.vertexAttribPointer(this.lines.loc.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(this.lines.loc.aAlpha, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.LINE_STRIP, 0, ring.length / 4);
      gl.disableVertexAttribArray(this.lines.loc.aPos);
      gl.disableVertexAttribArray(this.lines.loc.aAlpha);
    }
  }
}

paw.view("graph3d", { label: "3D" }, (ctx) => {
  try {
    new Graph(ctx);
  } catch (e) {
    console.error("Task Graph 3D:", e);
  }
});

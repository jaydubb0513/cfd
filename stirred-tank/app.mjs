// The live page: the input panel, the figure (back SVG, flow canvas,
// particle canvas, front SVG with the turning rotor), the results and the
// "save as HTML" button. Everything is rebuilt from one config object.

import * as k from "../.claude/skills/anatomy/kit/iso-kit.mjs";
import { IMPELLERS, HEADS, FLUIDS, normalize, analyse, clone, format } from "./model.mjs";
import { createSolver } from "./solver.mjs";
import { buildFigure, WEDGE } from "./figure.mjs";
import { colormap } from "./colormap.mjs";

const DEG = Math.PI / 180;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const still = matchMedia("(prefers-reduced-motion: reduce)");

const FIELDS = {
  speed: { label: "속도 크기 |U|", unit: "m/s", signed: false },
  meridional: { label: "단면 속도 √(u²+w²)", unit: "m/s", signed: false },
  axial: { label: "축방향 속도 w (+위)", unit: "m/s", signed: true },
  radial: { label: "반경방향 속도 u (+바깥)", unit: "m/s", signed: true },
  swirl: { label: "선회 속도 v_θ", unit: "m/s", signed: false },
  shear: { label: "전단률 γ̇ (log)", unit: "1/s", signed: false, log: true },
  viscosity: { label: "겉보기 점도 μ (log)", unit: "Pa·s", signed: false, logged: true },
  tracer: { label: "트레이서 농도 c/c∞", unit: "", signed: false },
};

// ---------------------------------------------------------------- template
const TEMPLATE = "<!doctype html>\n" + document.documentElement.outerHTML;
const initial = JSON.parse($("#cfd-config").textContent);
let config = normalize(initial);
document.body.dataset.theme = config.view.theme === "light" ? "light" : "dark";

const root = $("#cfd-root");
root.innerHTML = `
<aside class="cfd-panel" aria-label="입력">
  <header class="cfd-brand"><span class="cfd-mark"></span><div><strong>Stirred-tank CFD</strong><small>reduced-order · axisymmetric RANS</small></div></header>
  <form id="cfd-form" autocomplete="off"></form>
</aside>
<section class="cfd-main">
  <figure class="iso-figure cfd-figure">
    <div class="iso-plate">
      <div class="iso-plate-corners" aria-hidden="true">
        <span class="iso-plate-corner" data-corner="fig">Fig 1</span>
        <span class="iso-plate-corner" data-corner="title">Stirred tank · flow</span>
        <span class="iso-plate-corner" data-corner="hint">Space 정지 · T 트레이서 · R 초기화</span>
        <span class="iso-plate-corner" data-corner="readout" data-readout></span>
      </div>
      <div class="iso-stage cfd-stage" tabindex="0" role="img" aria-label="교반조 CFD 단면">
        <svg class="iso-svg cfd-back" xmlns="http://www.w3.org/2000/svg"></svg>
        <canvas class="cfd-field"></canvas>
        <canvas class="cfd-dots"></canvas>
        <svg class="iso-svg cfd-front" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
    <figcaption class="iso-legend cfd-legend">
      <div class="cfd-bar"><span class="cfd-bar-label"></span><canvas class="cfd-bar-canvas" width="256" height="1"></canvas><span class="cfd-bar-ticks"></span></div>
    </figcaption>
  </figure>
  <div class="cfd-actions">
    <button type="button" data-act="run">❚❚ 일시정지</button>
    <button type="button" data-act="reset">초기화</button>
    <button type="button" data-act="tracer">트레이서 주입</button>
    <button type="button" data-act="save" class="cfd-primary">HTML 저장</button>
    <button type="button" data-act="json">설정 JSON 복사</button>
  </div>
  <div class="cfd-results"></div>
  <ul class="cfd-warnings"></ul>
  <div class="cfd-table"></div>
  <details class="cfd-method"><summary>계산 방법과 한계</summary>
    <p>단면의 색은 축대칭(r–z) 비압축성 Navier–Stokes를 선회 성분과 함께 엇갈림(MAC) 격자에서 푼 결과입니다. 이류는 semi-Lagrangian, 점성은 국부 겉보기 점도(Newtonian, power-law, Herschel–Bulkley)와 난류 와점성 ν<sub>t</sub> = 0.09 ε<sup>1/3</sup>(0.07T)<sup>4/3</sup>의 implicit 처리, 압력은 red-black SOR 투영입니다. 벽은 층류에서 no-slip, 난류에서는 c<sub>f</sub>/2 ≈ 0.0015 벽함수입니다.</p>
    <p>임펠러는 격자로 그리지 않고 스윕 영역의 운동량 source로 둡니다: 날개 속도의 일정 비율로 선회를 주고, 반경류·축류 임펠러는 토출 속도를 주되 그 세기를 유량수 Nq(Q = Nq·N·D³)에 맞게 실시간 보정합니다. 배플은 벽 근처 선회에 대한 항력입니다. 선회의 원심력 v²/r이 Rushton의 이중 루프와 무배플 와류를 만듭니다.</p>
    <p>동력(Np), 유량수, 혼합시간(Grenville), 캐번 직경(Elson)은 상관식입니다. 3차원 효과(날개 후류 와류, 배플 뒤 박리, 자유표면 변형, 기포)는 들어 있지 않으므로 설계 확정에는 3D RANS/LES나 실험으로 검증하세요.</p>
  </details>
</section>`;

const form = $("#cfd-form");
const stage = $(".cfd-stage");
const backSvg = $(".cfd-back");
const frontSvg = $(".cfd-front");
const fieldCanvas = $(".cfd-field");
const dotsCanvas = $(".cfd-dots");
const readout = $("[data-readout]");

// ---------------------------------------------------------------- form
const num = (path, label, value, { step = "any", min, max, unit = "" } = {}) =>
  `<label class="cfd-field-row"><span>${label}${unit ? ` <em>${unit}</em>` : ""}</span><input type="number" data-path="${path}" value="${value}" step="${step}"${min != null ? ` min="${min}"` : ""}${max != null ? ` max="${max}"` : ""}></label>`;
const pick = (path, label, value, options) =>
  `<label class="cfd-field-row"><span>${label}</span><select data-path="${path}">${Object.entries(options).map(([key, text]) => `<option value="${key}"${key === value ? " selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
const check = (path, label, value) => `<label class="cfd-check"><input type="checkbox" data-path="${path}"${value ? " checked" : ""}> ${label}</label>`;
const round = (value, digits = 4) => Number(Number(value).toPrecision(digits));

function renderForm() {
  const v = config.vessel;
  const f = config.fluid;
  const imps = config.impellers
    .map((imp, i) => {
      const spec = IMPELLERS[imp.type];
      const axial = spec.flow === "axial" || spec.flow === "mixed";
      return `<fieldset class="cfd-imp"><legend>임펠러 ${i + 1}${config.impellers.length > 1 ? ` <button type="button" class="cfd-x" data-remove="${i}" aria-label="임펠러 ${i + 1} 삭제">×</button>` : ""}</legend>
        ${pick(`impellers.${i}.type`, "종류", imp.type, Object.fromEntries(Object.entries(IMPELLERS).map(([key, s]) => [key, s.label])))}
        <div class="cfd-grid2">
        ${num(`impellers.${i}.diameter`, "직경 D", round(imp.diameter), { unit: "m", min: 0.01 })}
        ${num(`impellers.${i}.clearance`, "높이 C", round(imp.clearance), { unit: "m", min: 0 })}
        ${num(`impellers.${i}.blades`, "날개 수", imp.blades, { step: 1, min: 2, max: 12 })}
        ${num(`impellers.${i}.width`, "날개 폭 W/D", round(imp.width, 3), { step: 0.01, min: 0.05, max: 1.2 })}
        ${imp.type === "pbt" ? num(`impellers.${i}.pitch`, "피치 각", imp.pitch, { unit: "°", step: 1, min: 15, max: 75 }) : ""}
        ${axial ? pick(`impellers.${i}.pumping`, "토출 방향", imp.pumping, { down: "아래로 (down)", up: "위로 (up)" }) : ""}
        </div>
        <p class="cfd-note">D/T ${format.num(imp.diameter / v.diameter, 3)} · C/T ${format.num(imp.clearance / v.diameter, 3)} · C/D ${format.num(imp.clearance / imp.diameter, 3)}</p>
      </fieldset>`;
    })
    .join("");
  const rheo =
    f.model === "newtonian"
      ? num("fluid.viscosity", "점도 μ", f.viscosity, { unit: "Pa·s", min: 0 })
      : `<div class="cfd-grid2">${num("fluid.K", "K", f.K, { unit: "Pa·sⁿ", min: 0 })}${num("fluid.n", "n", f.n, { step: 0.05, min: 0.1, max: 1.5 })}${f.model === "herschel" ? num("fluid.tauY", "항복응력 τy", f.tauY, { unit: "Pa", min: 0 }) : ""}</div>`;
  form.innerHTML = `
  <section><h3>용기</h3>
    <div class="cfd-grid2">
    ${num("vessel.diameter", "직경 T", round(v.diameter), { unit: "m", min: 0.05 })}
    ${num("vessel.liquidHeight", "액 높이 H", round(v.liquidHeight), { unit: "m", min: 0.01 })}
    ${num("vessel.straightSide", "직동부 높이", round(v.straightSide), { unit: "m", min: 0.01 })}
    ${num("vessel.wall", "벽 두께", round(v.wall), { unit: "m", min: 0.001 })}
    </div>
    ${pick("vessel.head", "바닥 헤드", v.head, HEADS)}
    ${v.head === "conical" ? num("vessel.coneAngle", "원추 꼭지각", v.coneAngle, { unit: "°", step: 1, min: 40, max: 160 }) : ""}
    <div class="cfd-grid2">
    ${num("vessel.baffles", "배플 수", v.baffles, { step: 1, min: 0, max: 8 })}
    ${num("vessel.baffleWidth", "배플 폭 B/T", round(v.baffleWidth, 3), { step: 0.005, min: 0.02, max: 0.2 })}
    </div>
    <p class="cfd-note">H/T ${format.num(v.liquidHeight / v.diameter, 3)} · 액량 <span data-live="volume"></span></p>
  </section>
  <section><h3>임펠러 <small>한 축, 같은 회전수</small></h3>${imps}
    ${config.impellers.length < 4 ? `<button type="button" class="cfd-add" data-add>+ 임펠러 추가</button>` : ""}
  </section>
  <section><h3>구동</h3>
    <label class="cfd-field-row cfd-speed"><span>회전수 N <em>rpm</em></span><input type="range" data-path="speed" min="5" max="${Math.max(600, Math.ceil(config.speed / 100) * 100)}" step="1" value="${config.speed}"><input type="number" data-path="speed" value="${config.speed}" step="1" min="1"></label>
  </section>
  <section><h3>유체</h3>
    ${pick("fluid.preset", "프리셋", f.preset in FLUIDS ? f.preset : "custom", { ...Object.fromEntries(Object.entries(FLUIDS).map(([key, x]) => [key, x.label])), custom: "직접 입력" })}
    <div class="cfd-grid2">
    ${num("fluid.density", "밀도 ρ", f.density, { unit: "kg/m³", min: 1 })}
    ${pick("fluid.model", "유변 모델", f.model, { newtonian: "Newtonian", powerlaw: "Power-law", herschel: "Herschel–Bulkley" })}
    </div>
    ${rheo}
  </section>
  <section><h3>표시</h3>
    ${pick("view.field", "변수", config.view.field, Object.fromEntries(Object.entries(FIELDS).map(([key, x]) => [key, x.label])))}
    <div class="cfd-grid2">
    ${pick("view.colormap", "컬러맵", config.view.colormap, { turbo: "Turbo", viridis: "Viridis", ink: "Ink (mono)" })}
    ${pick("view.theme", "테마", config.view.theme, { dark: "Dark", light: "Light" })}
    ${pick("view.speedup", "시뮬 속도", String(config.view.speedup ?? 1), { "0.25": "0.25× 실시간", "0.5": "0.5×", "1": "1× 실시간", "4": "4×", "max": "최대" })}
    ${pick("view.scale", "색 범위", config.view.scale ?? "auto", { auto: "자동", tip: "0 – tip speed" })}
    </div>
    ${check("view.particles", "입자 궤적", config.view.particles)}
  </section>`;
  $("[data-live=volume]", form).textContent = result ? volume(result.V) : "";
}

const volume = (v) => (v < 1 ? `${format.num(v * 1000, 3)} L` : `${format.num(v, 3)} m³`);

function setPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
  node[keys[keys.length - 1]] = value;
}

form.addEventListener("input", (event) => {
  const el = event.target;
  const path = el.dataset.path;
  if (!path) return;
  let value = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? Number(el.value) : el.value;
  if (el.type === "number" && !isFinite(value)) return;
  const next = clone(config);
  setPath(next, path, value);
  if (path === "fluid.preset" && FLUIDS[value]) Object.assign(next.fluid, clone(FLUIDS[value]), { preset: value });
  else if (path.startsWith("fluid.") && path !== "fluid.preset") next.fluid.preset = "custom";
  if (path === "speed") form.querySelectorAll('[data-path="speed"]').forEach((other) => other !== el && (other.value = value));
  if (path.endsWith(".type")) {
    const i = Number(path.split(".")[1]);
    const spec = IMPELLERS[value];
    Object.assign(next.impellers[i], { blades: spec.blades, width: spec.width });
    if (value === "anchor") Object.assign(next.impellers[i], { diameter: 0.9 * next.vessel.diameter, clearance: 0.04 * next.vessel.diameter, width: 0.75 });
  }
  const structural = el.tagName === "SELECT" || path.endsWith(".blades") || path === "vessel.baffles";
  apply(next, { redrawForm: structural, light: path.startsWith("view.") });
});
form.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add]");
  const remove = event.target.closest("[data-remove]");
  if (!add && !remove) return;
  const next = clone(config);
  if (add) {
    const top = Math.max(...next.impellers.map((imp) => imp.clearance));
    const last = next.impellers[next.impellers.length - 1];
    next.impellers.push({ ...clone(last), clearance: Math.min(top + 1.2 * last.diameter, next.vessel.liquidHeight - 0.6 * last.diameter) });
  } else next.impellers.splice(Number(remove.dataset.remove), 1);
  apply(next, { redrawForm: true });
});

// ---------------------------------------------------------------- state
let result = null;
let fig = null;
let solver = null;
let map = null;
let display = null;
let particles = [];
let surfaceDots = [];
let angle = 0;
let running = true;
let scaleMax = 1;
let lastKey = "";
let rebuildTimer = 0;

function geometryKey(c) {
  return JSON.stringify([c.vessel, c.impellers]);
}

function apply(next, { redrawForm = false, light = false } = {}) {
  const normal = normalize(next);
  const themeChanged = normal.view.theme !== config.view.theme;
  config = normal;
  document.body.dataset.theme = config.view.theme === "light" ? "light" : "dark";
  if (redrawForm) renderForm();
  if (light) {
    if (themeChanged) drawBar();
    drawBar();
    kick();
    return;
  }
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 180);
}

function rebuild() {
  const key = geometryKey(config);
  result = analyse(config);
  const keep = key === lastKey && solver;
  if (key !== lastKey || !fig) {
    fig = buildFigure(config, result);
    mountFigure();
  }
  const old = solver;
  solver = createSolver(config, result);
  if (keep && old.NR === solver.NR && old.NZ === solver.NZ) {
    // Same geometry: carry the developed flow over to the new run.
    solver.u.set(old.u); solver.w.set(old.w); solver.v.set(old.v);
  }
  lastKey = key;
  map = pixelMap();
  display = new Float32Array(solver.NR * solver.NZ);
  seedParticles();
  renderResults();
  const vol = $("[data-live=volume]", form);
  if (vol) vol.textContent = volume(result.V);
  drawBar();
  kick();
}

// ---------------------------------------------------------------- figure
function mountFigure() {
  const { width, height } = fig;
  for (const svg of [backSvg, frontSvg]) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
  }
  stage.style.aspectRatio = `${width} / ${height}`;
  stage.setAttribute("aria-label", fig.label);
  backSvg.innerHTML = fig.back;
  frontSvg.innerHTML = `${fig.frontStatic}<clipPath id="cfd-liquid"><path d="${fig.clip}"/></clipPath><g clip-path="url(#cfd-liquid)" class="cfd-dim"><g>${fig.dimStatic}</g><g data-part="dim"></g></g>${fig.shaft}<g data-part="near"></g>${fig.top}`;
  fieldCanvas.width = width;
  fieldCanvas.height = height;
  const ratio = Math.min(2, (window.devicePixelRatio || 1) * 1.25);
  dotsCanvas.width = Math.round(width * ratio);
  dotsCanvas.height = Math.round(height * ratio);
  dotsCanvas.dataset.ratio = ratio;
  drawRotor();
}

function drawRotor() {
  const parts = fig.rotor(angle);
  frontSvg.querySelector('[data-part="dim"]').innerHTML = parts.dim;
  frontSvg.querySelector('[data-part="near"]').innerHTML = parts.near;
}

// For every canvas pixel: which liquid face it sees (cut face A, cut face B
// or the free surface) and where that is in the solver grid.
function pixelMap() {
  const { width, height, P, lay, a } = fig;
  const { s, Rw, Zb, Zr, Hw, zIn } = lay;
  const cam = k.cameraOf(P);
  const [ox, oy] = k.iso([0, 0, 0], P);
  const K = cam.k;
  const sinW = Math.sin(WEDGE), cosW = Math.cos(WEDGE);
  const tanE = cam.sinE / cam.cosE;
  const rTop = fig.rTop;
  const baffles = fig.baffles.map((t) => ({ t, sin: Math.sin(t), cos: Math.cos(t), r0: Rw - fig.gap - fig.bw, r1: Rw - fig.gap }));
  const idx = [], fi = [], fj = [], shade = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = x + 0.5, sy = y + 0.5;
      const dx = sx - ox;
      // Cut faces: t = +45° maps to the left of the axis, -45° to the right.
      const rho = Math.abs(dx) / (K * sinW);
      const z = (oy + K * rho * cosW * cam.sinE - sy) / (K * cam.cosE);
      if (rho <= Rw && z >= zIn(rho) && z <= Hw) {
        idx.push(x + y * width);
        fi.push(rho / s);
        fj.push((z - Zb) / s);
        shade.push(dx < 0 ? 0 : 1);
        continue;
      }
      // Free surface of the remaining liquid.
      const q = dx / K;
      const p = ((sy - oy) / K + Hw * cam.cosE) / cam.sinE;
      const r = Math.hypot(p, q);
      if (r > rTop) continue;
      const t = Math.atan2(-q, p);
      if (Math.abs(t) < WEDGE) continue;
      // Hidden behind the shell where the ray toward the viewer leaves the
      // vessel through a wall that is still there, below the rim.
      const pExit = Math.sqrt(Math.max(0, Rw * Rw - q * q));
      const zExit = Hw + (pExit - p) * tanE;
      if (Math.abs(Math.atan2(-q, pExit)) >= WEDGE && zExit < Zr) continue;
      // ...or behind a baffle standing out of the liquid.
      let hidden = false;
      for (const b of baffles) {
        if (Math.abs(b.sin) < 1e-6) continue;
        const rr = q / b.sin * -1;
        if (rr < b.r0 || rr > b.r1) continue;
        const d = rr * b.cos - p;
        if (d > 0 && Hw + d * tanE < Zr - 2) { hidden = true; break; }
      }
      if (hidden) continue;
      idx.push(x + y * width);
      fi.push(r / s);
      fj.push((Hw - Zb) / s - 1e-6);
      shade.push(2);
    }
  const image = fieldCanvas.getContext("2d").createImageData(width, height);
  return { idx: Int32Array.from(idx), fi: Float32Array.from(fi), fj: Float32Array.from(fj), shade: Uint8Array.from(shade), image, pixels: new Uint32Array(image.data.buffer), ox, oy, K, cam };
}

// Screen point of a liquid point (r, z in metres) on cut face side +1/-1.
function planePoint(side, r, z) {
  const { lay } = fig;
  const { s, Zb } = lay;
  const { ox, oy, K, cam } = map;
  const rho = r * s;
  const zz = Zb + z * s;
  return [ox - side * K * rho * Math.sin(WEDGE), oy + K * (rho * Math.cos(WEDGE) * cam.sinE - zz * cam.cosE)];
}

// ---------------------------------------------------------------- colour
function currentField() {
  const kind = config.view.field;
  solver.fieldOf(kind, display);
  const spec = FIELDS[kind];
  const NR = solver.NR, NZ = solver.NZ;
  // Fill solid cells from fluid neighbours so samples near walls stay clean.
  for (let pass = 0; pass < 2; pass++)
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const c = i + j * NR;
        if (!Number.isNaN(display[c])) continue;
        let sum = 0, n = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= NR || jj >= NZ) continue;
          const vv = display[ii + jj * NR];
          if (!Number.isNaN(vv)) { sum += vv; n++; }
        }
        if (n) display[c] = sum / n;
      }
  for (let c = 0; c < display.length; c++) if (Number.isNaN(display[c])) display[c] = 0;
  let lo = 0, hi = 0;
  if (spec.log) {
    for (let c = 0; c < display.length; c++) display[c] = Math.log10(Math.max(display[c], 1e-2));
  }
  for (let c = 0; c < display.length; c++) {
    lo = Math.min(lo, display[c]);
    hi = Math.max(hi, display[c]);
  }
  let range;
  if (kind === "tracer") range = [0, 2];
  else if (spec.log || spec.logged) {
    let min = Infinity;
    for (let c = 0; c < display.length; c++) if (!solver.solid[c]) min = Math.min(min, display[c]);
    range = [Math.min(min, hi - 0.5), Math.max(hi, min + 0.5)];
  } else {
    const auto = Math.max(Math.abs(lo), Math.abs(hi), 1e-6);
    scaleMax += (auto - scaleMax) * 0.08;
    const top = config.view.scale === "tip" ? result.tip : Math.max(scaleMax, 1e-4);
    range = spec.signed ? [-top, top] : [0, top];
  }
  return range;
}

let range = [0, 1];
let lut = colormap("turbo");
function paintField() {
  range = currentField();
  const signed = FIELDS[config.view.field].signed;
  lut = colormap(signed ? "coolwarm" : config.view.colormap, document.body.dataset.theme);
  const { idx, fi, fj, shade, pixels, image } = map;
  const NR = solver.NR, NZ = solver.NZ, h = solver.h, hz = solver.hz;
  const [lo, hi] = range;
  const span = 255 / (hi - lo || 1);
  const light = document.body.dataset.theme === "light";
  const alpha = light ? [236, 236, 228] : [238, 238, 232];
  const gain = [1, 0.84, 0.94];
  pixels.fill(0);
  for (let q = 0; q < idx.length; q++) {
    let x = fi[q] / h - 0.5, y = fj[q] / hz - 0.5;
    x = x < 0 ? 0 : x > NR - 1 ? NR - 1 : x;
    y = y < 0 ? 0 : y > NZ - 1 ? NZ - 1 : y;
    let i0 = x | 0, j0 = y | 0;
    if (i0 > NR - 2) i0 = NR - 2;
    if (j0 > NZ - 2) j0 = NZ - 2;
    const ax = x - i0, ay = y - j0;
    const c = i0 + j0 * NR;
    const value = (display[c] * (1 - ax) + display[c + 1] * ax) * (1 - ay) + (display[c + NR] * (1 - ax) + display[c + NR + 1] * ax) * ay;
    let t = ((value - lo) * span) | 0;
    t = t < 0 ? 0 : t > 255 ? 255 : t;
    const g = gain[shade[q]];
    const rgb = lut[t];
    pixels[idx[q]] = (alpha[shade[q]] << 24) | (((rgb[2] * g) | 0) << 16) | (((rgb[1] * g) | 0) << 8) | ((rgb[0] * g) | 0);
  }
  fieldCanvas.getContext("2d").putImageData(image, 0, 0);
}

function drawBar() {
  const canvas = $(".cfd-bar-canvas");
  const signed = FIELDS[config.view.field].signed;
  const table = colormap(signed ? "coolwarm" : config.view.colormap, document.body.dataset.theme);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(256, 1);
  for (let i = 0; i < 256; i++) img.data.set([...table[i], 255], i * 4);
  ctx.putImageData(img, 0, 0);
}
function updateBar() {
  const spec = FIELDS[config.view.field];
  $(".cfd-bar-label").textContent = `${spec.label}${spec.unit ? ` [${spec.unit}]` : ""}`;
  const [lo, hi] = range;
  const show = (v) => (spec.log || spec.logged ? format.num(10 ** v, 2) : format.num(v, 2));
  $(".cfd-bar-ticks").innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${show(lo + (hi - lo) * f)}</span>`).join("");
}

// ---------------------------------------------------------------- particles
function randomLiquidPoint() {
  const R = solver.R, H = solver.H;
  for (let tries = 0; tries < 40; tries++) {
    const r = R * Math.random();
    const z = H * Math.random();
    if (r > fig.shaftR / fig.lay.s && solver.fluidAt(r, z)) return [r, z];
  }
  return [0.5 * R, 0.5 * H];
}
function seedParticles() {
  const count = Math.round(220 + 120 * Math.min(2, solver.H / solver.R / 2));
  particles = [];
  for (let side = -1; side <= 1; side += 2)
    for (let i = 0; i < count; i++) {
      const [r, z] = randomLiquidPoint();
      particles.push({ side, r, z, age: Math.random() * 4, life: 2.5 + 3 * Math.random(), trail: [] });
    }
  surfaceDots = Array.from({ length: 140 }, () => ({ r: solver.R * Math.sqrt(0.05 + 0.95 * Math.random()) * (fig.rTop / fig.lay.Rw), t: Math.PI * (0.25 + 1.5 * Math.random()), trail: [], age: Math.random() * 4, life: 3 + 3 * Math.random() }));
}
function moveParticles(dt, wall) {
  const h = solver.h;
  for (const p of particles) {
    p.age += wall;
    let left = dt;
    let dead = false;
    while (left > 0 && !dead) {
      const u = solver.sampleU(p.r, p.z), w = solver.sampleW(p.r, p.z);
      const speed = Math.hypot(u, w) + 1e-9;
      const sub = Math.min(left, (0.45 * h) / speed);
      const rm = p.r + 0.5 * sub * u, zm = p.z + 0.5 * sub * w;
      p.r += sub * solver.sampleU(rm, zm);
      p.z += sub * solver.sampleW(rm, zm);
      left -= sub;
      if (!solver.fluidAt(p.r, p.z) || p.r < 0 || p.r > solver.R || p.z < 0 || p.z > solver.H) dead = true;
    }
    if (dead || p.age > p.life) {
      [p.r, p.z] = randomLiquidPoint();
      p.age = 0;
      p.trail = [];
    }
    p.trail.push(planePoint(p.side, p.r, p.z));
    if (p.trail.length > 9) p.trail.shift();
  }
  const top = solver.H - 0.5 * solver.hz;
  for (const d of surfaceDots) {
    d.age += wall;
    const vel = solver.sampleC(solver.v, d.r, top);
    d.t += (vel / Math.max(d.r, 1e-3)) * dt;
    d.r += solver.sampleU(d.r, top) * dt;
    if (d.age > d.life || d.r > (fig.rTop / fig.lay.s) * 0.98 || d.r < 0.02 * solver.R) {
      d.r = solver.R * Math.sqrt(0.05 + 0.9 * Math.random()) * (fig.rTop / fig.lay.Rw);
      d.t = Math.PI * 2 * Math.random();
      d.age = 0;
      d.trail = [];
    }
    const { lay, a } = fig;
    const rho = d.r * lay.s;
    const t = Math.atan2(Math.sin(d.t), Math.cos(d.t));
    const pt = k.iso([rho * Math.cos(a + t), rho * Math.sin(a + t), lay.Hw], fig.P);
    const px = Math.floor(pt[0]), py = Math.floor(pt[1]);
    const ok = Math.abs(t) > WEDGE && visibleSurface(px, py);
    if (!ok) { d.trail = []; continue; }
    d.trail.push(pt);
    if (d.trail.length > 9) d.trail.shift();
  }
}
let surfaceMask = null;
function visibleSurface(px, py) {
  if (!surfaceMask) {
    surfaceMask = new Uint8Array(fig.width * fig.height);
    for (let q = 0; q < map.idx.length; q++) if (map.shade[q] === 2) surfaceMask[map.idx[q]] = 1;
  }
  return px >= 0 && py >= 0 && px < fig.width && py < fig.height && surfaceMask[px + py * fig.width] === 1;
}
function drawParticles() {
  const ctx = dotsCanvas.getContext("2d");
  const ratio = Number(dotsCanvas.dataset.ratio) || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, dotsCanvas.width, dotsCanvas.height);
  if (!config.view.particles) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const light = document.body.dataset.theme === "light";
  const ink = light ? "20,20,24" : "255,255,255";
  ctx.lineCap = "round";
  ctx.lineWidth = 0.9;
  // Trails fade toward their tails; segments are batched into a few alpha
  // levels so a frame strokes six paths instead of thousands.
  const levels = 6;
  const batches = Array.from({ length: levels }, () => []);
  for (const p of [...particles, ...surfaceDots]) {
    const tr = p.trail;
    if (tr.length < 2) continue;
    const fadeIn = Math.max(0, Math.min(1, p.age / 0.4) * Math.min(1, (p.life - p.age) / 0.5));
    for (let i = 1; i < tr.length; i++) {
      const level = Math.round((i / tr.length) * fadeIn * levels);
      if (level > 0) batches[level - 1].push(tr[i - 1], tr[i]);
    }
  }
  batches.forEach((segs, level) => {
    if (!segs.length) return;
    ctx.strokeStyle = `rgba(${ink},${(((level + 1) / levels) * 0.85).toFixed(3)})`;
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 2) {
      ctx.moveTo(segs[i][0], segs[i][1]);
      ctx.lineTo(segs[i + 1][0], segs[i + 1][1]);
    }
    ctx.stroke();
  });
}

// ---------------------------------------------------------------- results
// Volumetric flow in L/s below 1 m³/s, m³/s above (SI prefixes on m³ mislead).
const flow = (q) => (q < 1 ? `${format.num(q * 1000, 3)} L/s` : `${format.num(q, 3)} m³/s`);
function card(label, value, note = "") {
  return `<div class="cfd-card"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`;
}
const REGIME = { laminar: "층류", transitional: "천이", turbulent: "난류" };
function renderResults() {
  const r = result;
  const blendNote = r.Re * Math.cbrt(r.NpSum) >= 6370 ? "Grenville, 난류" : "Grenville, 천이";
  const cards = [
    card("Reynolds Re", format.num(r.Re, 3), `${REGIME[r.regime]} · ${IMPELLERS[r.main.type].label}`),
    card("동력수 Np (합)", format.num(r.NpSum, 3), `배플 효과 ${(r.baffling * 100).toFixed(0)}%`),
    card("교반 동력 P", format.si(r.power, "W", 3), `토크 ${format.si(r.torque, "N·m", 3)}`),
    card("P/V", format.si(r.PV, "W/m³", 3), `ε ${format.si(r.epsilon, "W/kg", 3)}`),
    card("Tip speed", `${format.num(r.tip, 3)} m/s`, `Fr ${format.num(r.Fr, 3)}`),
    card("토출 유량 Q", flow(r.Q), `순환시간 ${isFinite(r.circulation) ? format.num(r.circulation, 3) + " s" : "–"}`),
    card("혼합시간 θ95", `${format.num(r.blend, 3)} s`, blendNote),
    card("Kolmogorov η", format.si(r.eta, "m", 3), "평균 ε 기준"),
    card("시뮬 혼합 θ95", `<span data-live="mix">트레이서 주입 전</span>`, "축대칭 해석"),
    card("표면 와류 깊이", `<span data-live="vortex">–</span>`, "선회로부터 ∫ρv²/r dr"),
  ];
  if (r.cavern) cards.push(card("캐번 직경 Dc", `${format.num(r.cavern.diameter, 3)} m`, r.cavern.fills ? "Dc ≥ T: 탱크 전체 유동" : `Dc/T ${format.num(r.cavern.diameter / r.T, 3)} (Elson)`));
  cards.push(card("격자", `${solver.NR} × ${solver.NZ}`, `ν<sub>t</sub> ${format.si(solver.nut, "m²/s", 2)}`));
  $(".cfd-results").innerHTML = cards.join("");
  $(".cfd-warnings").innerHTML = r.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
  $(".cfd-table").innerHTML = `<table><thead><tr><th>#</th><th>종류</th><th>D/T</th><th>C/T</th><th>Re</th><th>Np</th><th>P</th><th>Q (Nq)</th><th>Q 시뮬</th></tr></thead><tbody>${r.impellers
    .map((imp, i) => `<tr><td>${i + 1}</td><td>${esc(imp.spec.label)}</td><td>${format.num(imp.D / r.T, 3)}</td><td>${format.num(imp.clearance / r.T, 3)}</td><td>${format.num(imp.Re, 3)}</td><td>${format.num(imp.Np, 3)}</td><td>${format.si(imp.power, "W", 3)}</td><td>${imp.Q > 0 ? flow(imp.Q) : "–"}</td><td data-live="q${i}">–</td></tr>`)
    .join("")}</tbody></table>`;
}
let blendSim = null;
function updateLive() {
  const mix = solver.mixing();
  const el = $("[data-live=mix]");
  if (mix && el) {
    if (mix.worst <= 0.05 && blendSim === null) blendSim = mix.since;
    el.textContent = blendSim !== null ? `${format.num(blendSim, 3)} s` : `${format.num(mix.since, 3)} s · 편차 ${(mix.worst * 100).toFixed(0)}%`;
  }
  const vx = $("[data-live=vortex]");
  if (vx) vx.textContent = format.si(solver.vortexDepth(), "m", 2);
  result.impellers.forEach((imp, i) => {
    const cell = $(`[data-live=q${i}]`);
    if (cell) cell.textContent = imp.Q > 0 ? flow(solver.pumping(imp)) : "–";
  });
  const developed = solver.time * result.N;
  const text = `t ${format.num(solver.time, 3)} s · ${format.num(developed, 3)} rev · |U|max ${format.num(solver.umax, 3)} m/s${running ? "" : " · 정지"}`;
  if (readout.textContent !== text) readout.textContent = text;
  updateBar();
}

// ---------------------------------------------------------------- loop
let frame = 0;
let last = 0;
let visible = true;
let tick = 0;
function loop(now) {
  frame = 0;
  const wall = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
  last = now;
  if (!solver || !fig) return;
  const speed = config.view.speedup === "max" ? Infinity : Number(config.view.speedup ?? 1);
  let simDt = 0;
  if (running) {
    const want = speed * wall;
    const t0 = performance.now();
    while (simDt < want && performance.now() - t0 < 9) simDt += solver.step();
    if (!(simDt > 0)) simDt = 0;
    // The drawing turns at most a fifth of a turn per frame, so a fast
    // impeller does not strobe; the readout keeps the true time.
    angle += Math.min(result.N * 2 * Math.PI * simDt, 0.2 * Math.PI * 2 * wall * 6);
    moveParticles(simDt, wall);
    drawRotor();
  }
  paintField();
  drawParticles();
  if (tick++ % 8 === 0) updateLive();
  if (running && visible && !still.matches) frame = requestAnimationFrame(loop);
}
function kick() {
  if (!frame) { last = 0; frame = requestAnimationFrame(loop); }
}
new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (visible) kick();
}).observe(stage);
if (still.matches) {
  // Reduced motion: compute ahead and show one settled frame.
  running = true;
}

// ---------------------------------------------------------------- actions
function toggle(on = !running) {
  running = on;
  $('[data-act="run"]').textContent = running ? "❚❚ 일시정지" : "▶ 실행";
  kick();
}
function inject() {
  solver.inject(0.5);
  blendSim = null;
  if (config.view.field !== "tracer") apply({ ...clone(config), view: { ...config.view, field: "tracer" } }, { redrawForm: true, light: true });
  kick();
}
function resetFlow() {
  solver.reset();
  blendSim = null;
  seedParticles();
  kick();
}
function pageWith(current) {
  const json = JSON.stringify(current, null, 2).replace(/</g, "\\u003c");
  return TEMPLATE.replace(/(<script type="application\/json" id="cfd-config">)[\s\S]*?(<\/script>)/, (_, open, close) => open + json + close);
}
function saveHtml() {
  const html = pageWith(config);
  const blob = new Blob([html], { type: "text/html" });
  const link = document.createElement("a");
  const name = `stirred-tank-${config.impellers.map((imp) => imp.type).join("-")}-${Math.round(config.speed)}rpm.html`;
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
async function copyJson() {
  const text = JSON.stringify(config, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    flash("설정 JSON을 복사했습니다");
  } catch {
    prompt("설정 JSON", text);
  }
}
function flash(text) {
  const btn = $('[data-act="json"]');
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}
document.addEventListener("click", (event) => {
  const act = event.target.closest("[data-act]")?.dataset.act;
  if (act === "run") toggle();
  else if (act === "reset") resetFlow();
  else if (act === "tracer") inject();
  else if (act === "save") saveHtml();
  else if (act === "json") copyJson();
});
document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, select, textarea")) return;
  if (event.key === " ") { event.preventDefault(); toggle(); }
  else if (event.key === "t" || event.key === "T") inject();
  else if (event.key === "r" || event.key === "R") resetFlow();
});

renderForm();
rebuild();
clearTimeout(rebuildTimer);
// Test hooks for headless checks.
window.__cfd = { html: () => pageWith(config), get config() { return config; }, get solver() { return solver; }, get result() { return result; }, apply, inject, toggle };

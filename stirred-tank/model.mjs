// Stirred-tank engineering model: geometry, rheology and the standard
// correlations (power number, flow number, blend time, cavern size).
// Pure functions in SI units, shared by the solver, the figure and the page.

export const G = 9.81;

// Turbulent power number Np_t, laminar constant Kp (Np = Kp/Re), turbulent
// flow number Nq, Metzner-Otto constant ks, the reference blade count and
// width W/D the constants belong to, the exponents of the corrections, and how
// the blades drive the liquid (share of tip speed given to swirl, discharge).
export const IMPELLERS = {
  rushton: { label: "Rushton turbine", Np: 5.0, Kp: 70, Nq: 0.72, ks: 11.5, blades: 6, width: 0.2, bladeExp: 0.8, widthExp: 1.0, swirl: 0.62, flow: "radial" },
  pbt: { label: "Pitched blade 45°", Np: 1.27, Kp: 50, Nq: 0.79, ks: 13, blades: 4, width: 0.2, bladeExp: 0.8, widthExp: 0.65, swirl: 0.42, flow: "mixed" },
  hydrofoil: { label: "Hydrofoil", Np: 0.3, Kp: 43, Nq: 0.56, ks: 10, blades: 3, width: 0.15, bladeExp: 0.8, widthExp: 0.65, swirl: 0.25, flow: "axial" },
  propeller: { label: "Marine propeller", Np: 0.35, Kp: 40, Nq: 0.45, ks: 10, blades: 3, width: 0.3, bladeExp: 0.8, widthExp: 0.5, swirl: 0.3, flow: "axial" },
  paddle: { label: "Flat paddle", Np: 1.7, Kp: 60, Nq: 0.5, ks: 11, blades: 2, width: 0.2, bladeExp: 0.8, widthExp: 1.0, swirl: 0.6, flow: "radial" },
  anchor: { label: "Anchor", Np: 0.35, Kp: 300, Nq: 0.0, ks: 25, blades: 2, width: 0.1, bladeExp: 0.8, widthExp: 0.5, swirl: 0.85, flow: "tangential" },
};

export const HEADS = {
  flat: "Flat",
  ellipsoidal: "2:1 ellipsoidal",
  torispherical: "Torispherical (F&D)",
  hemispherical: "Hemispherical",
  conical: "Conical",
};

export const FLUIDS = {
  water: { label: "Water 20 °C", density: 998, model: "newtonian", viscosity: 0.001 },
  oil: { label: "Light oil", density: 870, model: "newtonian", viscosity: 0.08 },
  glycerol: { label: "Glycerol 99%", density: 1260, model: "newtonian", viscosity: 1.2 },
  syrup: { label: "Corn syrup", density: 1380, model: "newtonian", viscosity: 6.0 },
  xanthan: { label: "Xanthan 0.5% (shear-thinning)", density: 1000, model: "powerlaw", K: 3.0, n: 0.3 },
  cmc: { label: "CMC 2% (shear-thinning)", density: 1010, model: "powerlaw", K: 1.6, n: 0.55 },
  carbopol: { label: "Carbopol gel (yield stress)", density: 1000, model: "herschel", tauY: 8, K: 1.8, n: 0.45 },
  slurry: { label: "Mineral slurry (Bingham-like)", density: 1450, model: "herschel", tauY: 3, K: 0.05, n: 1.0 },
};

export const DEFAULT_CONFIG = {
  vessel: { diameter: 1.2, liquidHeight: 1.2, straightSide: 1.25, head: "torispherical", coneAngle: 90, baffles: 4, baffleWidth: 1 / 12, wall: 0.008 },
  impellers: [
    { type: "rushton", diameter: 0.4, clearance: 0.4, blades: 6, width: 0.2, pitch: 45, pumping: "down" },
  ],
  speed: 120,
  fluid: { preset: "water", density: 998, model: "newtonian", viscosity: 0.001, K: 1, n: 1, tauY: 0 },
  view: { field: "speed", particles: true, vectors: false, colormap: "turbo", theme: "dark" },
};

export const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Fill missing keys from the defaults and keep every number in a sane range,
// so a hand-written config or a half-edited form never breaks the solver.
export function normalize(input = {}) {
  const base = clone(DEFAULT_CONFIG);
  const config = {
    vessel: { ...base.vessel, ...(input.vessel || {}) },
    impellers: (input.impellers && input.impellers.length ? input.impellers : base.impellers).slice(0, 4).map((item) => ({ ...base.impellers[0], ...item })),
    speed: Number(input.speed ?? base.speed),
    fluid: { ...base.fluid, ...(input.fluid || {}) },
    view: { ...base.view, ...(input.view || {}) },
  };
  const v = config.vessel;
  v.diameter = clamp(Number(v.diameter) || 1, 0.05, 20);
  v.liquidHeight = clamp(Number(v.liquidHeight) || v.diameter, 0.2 * v.diameter, 3.5 * v.diameter);
  v.straightSide = Number(v.straightSide) || v.liquidHeight * 1.1;
  if (!HEADS[v.head]) v.head = "flat";
  v.coneAngle = clamp(Number(v.coneAngle) || 90, 40, 160);
  v.baffles = clamp(Math.round(Number(v.baffles) || 0), 0, 8);
  v.baffleWidth = clamp(Number(v.baffleWidth) || 1 / 12, 0.02, 0.2);
  v.wall = clamp(Number(v.wall) || 0.006 * v.diameter, 0.001, 0.1);
  v.straightSide = clamp(v.straightSide, 0.3 * v.diameter, 5 * v.diameter);
  config.speed = clamp(config.speed || 0, 1, 3000);
  for (const imp of config.impellers) {
    if (!IMPELLERS[imp.type]) imp.type = "rushton";
    imp.diameter = clamp(Number(imp.diameter) || v.diameter / 3, 0.05 * v.diameter, 0.98 * v.diameter);
    imp.clearance = clamp(Number(imp.clearance) || v.diameter / 3, 0.01 * v.diameter, 3.5 * v.diameter);
    imp.blades = clamp(Math.round(Number(imp.blades) || IMPELLERS[imp.type].blades), 2, 12);
    imp.width = clamp(Number(imp.width) || IMPELLERS[imp.type].width, 0.05, 1.2);
    imp.pitch = clamp(Number(imp.pitch) || 45, 15, 75);
    imp.pumping = imp.pumping === "up" ? "up" : "down";
  }
  const f = config.fluid;
  f.density = clamp(Number(f.density) || 1000, 1, 20000);
  f.viscosity = clamp(Number(f.viscosity) || 0.001, 1e-5, 1e4);
  f.K = clamp(Number(f.K) || 1, 1e-4, 1e4);
  f.n = clamp(Number(f.n) || 1, 0.1, 1.5);
  f.tauY = clamp(Number(f.tauY) || 0, 0, 1e4);
  if (!["newtonian", "powerlaw", "herschel"].includes(f.model)) f.model = "newtonian";
  return config;
}

// Depth of the bottom head and its inner profile zb(r): the height of the
// inside of the head above the lowest point, for 0 <= r <= R.
export function headOf(vessel) {
  const R = vessel.diameter / 2;
  switch (vessel.head) {
    case "ellipsoidal": {
      const a = R / 2;
      return { depth: a, at: (r) => a * (1 - Math.sqrt(Math.max(0, 1 - (r / R) ** 2))) };
    }
    case "hemispherical":
      return { depth: R, at: (r) => R - Math.sqrt(Math.max(0, R * R - r * r)) };
    case "torispherical": {
      // ASME F&D: crown radius = D, knuckle radius = 0.06 D (inside).
      const Rc = 2 * R;
      const rk = 0.06 * 2 * R;
      const sinB = (R - rk) / (Rc - rk);
      const rJoin = Rc * sinB;
      const zCrown = (r) => Rc - Math.sqrt(Math.max(0, Rc * Rc - r * r));
      const zJoin = zCrown(rJoin);
      const cosB = Math.sqrt(1 - sinB * sinB);
      const kneeZ = zJoin + rk * cosB;
      const depth = kneeZ;
      return {
        depth,
        at: (r) => {
          if (r <= rJoin) return zCrown(r);
          const dx = r - (R - rk);
          return kneeZ - Math.sqrt(Math.max(0, rk * rk - dx * dx));
        },
      };
    }
    case "conical": {
      const half = ((vessel.coneAngle || 90) / 2) * (Math.PI / 180);
      const depth = R / Math.tan(half);
      return { depth, at: (r) => r / Math.tan(half) };
    }
    default:
      return { depth: 0, at: () => 0 };
  }
}

// Liquid volume (m3) by integrating the annulus area over height.
export function liquidVolume(vessel) {
  const head = headOf(vessel);
  const R = vessel.diameter / 2;
  const H = vessel.liquidHeight;
  let volume = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const r0 = (i / n) * R;
    const r1 = ((i + 1) / n) * R;
    const rm = (r0 + r1) / 2;
    const column = Math.max(0, H - head.at(rm));
    volume += Math.PI * (r1 * r1 - r0 * r0) * column;
  }
  return volume;
}

// Apparent viscosity (Pa s) at shear rate gamma (1/s), with Papanastasiou
// regularisation of the yield stress so it stays finite at rest.
export function apparentViscosity(fluid, gamma) {
  const g = Math.max(gamma, 1e-3);
  if (fluid.model === "newtonian") return fluid.viscosity;
  const power = fluid.K * Math.pow(g, fluid.n - 1);
  if (fluid.model === "powerlaw") return power;
  const m = 100;
  return power + (fluid.tauY * (1 - Math.exp(-m * g))) / g;
}

// Fully baffled from four baffles of T/12, nB (B/T)^1.2 = 0.2; unbaffled turbulent
// power falls to roughly a quarter.
export function baffleFactor(vessel) {
  if (!vessel.baffles) return 0;
  return clamp((vessel.baffles * Math.pow(vessel.baffleWidth, 1.2)) / 0.2, 0, 1);
}

export function powerNumber(type, imp, Re, baffling) {
  const spec = IMPELLERS[type];
  let Npt = spec.Np * Math.pow(imp.blades / spec.blades, spec.bladeExp) * Math.pow(imp.width / spec.width, spec.widthExp);
  if (type === "pbt") Npt *= Math.pow(Math.sin((imp.pitch * Math.PI) / 180) / Math.sin(Math.PI / 4), 2.6);
  if (type !== "anchor") Npt *= 0.28 + 0.72 * baffling;
  const laminar = (spec.Kp * Math.pow(imp.blades / spec.blades, 0.5)) / Re;
  return laminar + (Npt * Re) / (Re + 100);
}

export function flowNumber(type, imp, Re) {
  const spec = IMPELLERS[type];
  let Nq = spec.Nq * Math.pow(imp.blades / spec.blades, 0.25) * Math.pow(imp.width / spec.width, 0.4);
  if (type === "pbt") Nq *= Math.pow(Math.sin((imp.pitch * Math.PI) / 180) / Math.sin(Math.PI / 4), 0.6);
  return Nq * (1 - Math.exp(-Re / 400));
}

// Everything the readouts show, from one config.
export function analyse(config) {
  const { vessel, fluid } = config;
  const T = vessel.diameter;
  const R = T / 2;
  const H = vessel.liquidHeight;
  const N = config.speed / 60;
  const rho = fluid.density;
  const V = liquidVolume(vessel);
  const head = headOf(vessel);
  const baffling = baffleFactor(vessel);
  const warnings = [];
  const sorted = [...config.impellers].sort((a, b) => a.clearance - b.clearance);

  const impellers = config.impellers.map((imp) => {
    const spec = IMPELLERS[imp.type];
    const D = imp.diameter;
    // Metzner-Otto: the average shear rate around the impeller is ks N.
    const gamma = spec.ks * N;
    const mu = apparentViscosity(fluid, gamma);
    const Re = (rho * N * D * D) / mu;
    const Np = powerNumber(imp.type, imp, Re, baffling);
    const Nq = flowNumber(imp.type, imp, Re);
    return { ...imp, spec, D, gamma, mu, Re, Np, Nq, tip: Math.PI * N * D, Q: Nq * N * D ** 3, power: Np * rho * N ** 3 * D ** 5 };
  });

  // Close impellers on one shaft share their power: below a spacing of one
  // diameter each draws less than alone.
  const byHeight = [...impellers].sort((a, b) => a.clearance - b.clearance);
  for (let i = 1; i < byHeight.length; i++) {
    const gap = byHeight[i].clearance - byHeight[i - 1].clearance;
    const ratio = gap / Math.max(byHeight[i].D, byHeight[i - 1].D);
    if (ratio < 1) {
      const share = 0.7 + 0.3 * clamp(ratio, 0, 1);
      byHeight[i].power *= share;
      byHeight[i - 1].power *= share;
    }
    if (ratio < 0.5) warnings.push(`임펠러 ${i}–${i + 1} 간격이 D/2 미만: 서로 간섭이 큽니다.`);
  }

  const main = impellers.reduce((best, imp) => (imp.power > best.power ? imp : best), impellers[0]);
  const power = impellers.reduce((sum, imp) => sum + imp.power, 0);
  const torque = power / (2 * Math.PI * N);
  const Q = impellers.reduce((sum, imp) => sum + imp.Q, 0);
  const epsilon = power / (rho * V);
  const nuBulk = main.mu / rho;
  const eta = Math.pow((nuBulk ** 3) / Math.max(epsilon, 1e-12), 0.25);
  const Fr = (N * N * main.D) / G;
  const NpSum = power / (rho * N ** 3 * main.D ** 5);

  // Grenville blend time, for the largest impeller and the total power number.
  const ReNp = main.Re * Math.cbrt(NpSum);
  const TD = T / main.D;
  const HT = H / T;
  let blend;
  if (ReNp >= 6370) blend = (5.2 / Math.cbrt(NpSum)) * TD * TD * Math.sqrt(HT) / N;
  else blend = (33500 / (Math.pow(NpSum, 2 / 3) * main.Re)) * TD * TD * Math.sqrt(HT) / N;
  if (HT > 1.2) warnings.push("H/T > 1.2: 단일 루프 혼합시간 상관식이 혼합시간을 과소평가할 수 있습니다.");

  // Elson cavern diameter for yield-stress fluids.
  let cavern = null;
  if (fluid.model === "herschel" && fluid.tauY > 0) {
    const Dc = main.D * Math.cbrt((1.36 / (Math.PI * Math.PI)) * (NpSum * rho * N * N * main.D * main.D) / fluid.tauY);
    cavern = { diameter: Dc, fills: Dc >= T };
  }

  const regime = main.Re < 10 ? "laminar" : main.Re < 1e4 ? "transitional" : "turbulent";

  for (const imp of impellers) {
    const zb = head.at(Math.min(imp.D / 2, R));
    if (imp.clearance - (imp.width * imp.D) / 2 < zb) warnings.push(`${imp.spec.label}: 날개가 바닥 헤드에 닿습니다 (clearance를 늘리세요).`);
    if (imp.clearance + (imp.width * imp.D) / 2 > H) warnings.push(`${imp.spec.label}: 액면 위로 나옵니다.`);
    else if (H - imp.clearance < 0.5 * imp.D && imp.type !== "anchor") warnings.push(`${imp.spec.label}: 잠김 깊이가 D/2 미만 → 표면 공기 혼입 위험.`);
    if (vessel.baffles && imp.D / 2 > R - vessel.baffleWidth * T * 1.1 && imp.type !== "anchor") warnings.push(`${imp.spec.label}: 임펠러가 배플과 간섭합니다.`);
  }
  if (!vessel.baffles && regime === "turbulent" && sorted.some((imp) => IMPELLERS[imp.type].flow !== "tangential")) warnings.push("배플 없음 + 난류: 강한 선회류와 표면 와류가 생깁니다.");
  if (main.tip > 8) warnings.push("Tip speed > 8 m/s: 기계적/전단 손상 검토가 필요합니다.");

  return {
    T, H, R, N, rho, V, head, baffling, impellers, main, power, torque, Q, epsilon, eta, Fr, blend, regime, cavern, warnings,
    PV: power / V,
    circulation: Q > 0 ? V / Q : Infinity,
    tip: main.tip,
    Re: main.Re,
    NpSum,
  };
}

// Eddy viscosity (m2/s) for the reduced-order solver: k-epsilon scaling,
// nu_t = 0.09 k^2/eps with k = (eps L)^(2/3), so nu_t = 0.09 eps^(1/3) L^(4/3),
// with the mean dissipation and a mixing length of 0.07 T; switched on with Re.
export const turbulentShare = (result) => smoothstep(Math.log10(800), Math.log10(2e4), Math.log10(Math.max(result.Re, 1)));
export function eddyViscosity(result) {
  const L = 0.07 * result.T;
  return 0.09 * Math.cbrt(Math.max(result.epsilon, 0)) * Math.pow(L, 4 / 3) * turbulentShare(result);
}

export const format = {
  si(value, unit, digits = 3) {
    if (!isFinite(value)) return "∞ " + unit;
    const abs = Math.abs(value);
    const prefixes = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"]];
    for (const [scale, p] of prefixes) if (abs >= scale * 0.9995) return `${(value / scale).toPrecision(digits)} ${p}${unit}`;
    return `${value.toExponential(2)} ${unit}`;
  },
  num(value, digits = 3) {
    if (!isFinite(value)) return "∞";
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) return value.toExponential(2).replace("e+", "e");
    return Number(value.toPrecision(digits)).toString();
  },
};

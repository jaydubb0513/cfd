// Reduced-order CFD for a stirred tank: incompressible, axisymmetric
// Navier-Stokes in the meridional (r, z) plane with swirl, on a staggered
// (MAC) grid. Semi-Lagrangian advection, implicit viscosity with a local
// apparent viscosity (Newtonian, power-law or Herschel-Bulkley) plus an eddy
// viscosity, and a red-black SOR pressure projection.
//
// The impellers are not meshed: each is a momentum source over its swept
// volume that drives swirl (a share of the blade speed) and, for radial and
// axial impellers, the discharge velocity its flow number Nq implies. Baffles
// are a drag on the swirl near the wall. Centrifugal force from the swirl
// (v^2/r) is what turns the radial jet and spins up an unbaffled vortex.

import { IMPELLERS, headOf, apparentViscosity, eddyViscosity, turbulentShare } from "./model.mjs";

export function createSolver(config, result, { cells = 44, maxRows = 150 } = {}) {
  const { vessel, fluid } = config;
  const R = vessel.diameter / 2;
  const H = vessel.liquidHeight;
  let h = R / cells;
  if (H / h > maxRows) h = H / maxRows;
  const NR = Math.max(8, Math.round(R / h));
  h = R / NR;
  const NZ = Math.max(8, Math.round(H / h));
  const hz = H / NZ;
  const head = headOf(vessel);
  const N = config.speed / 60;
  const omega = 2 * Math.PI * N;
  const rho = fluid.density;
  const nut = eddyViscosity(result);
  // Walls: no-slip when laminar; when turbulent a wall function, a ghost
  // value that leaves the wall stress near cf/2 U^2 with cf/2 = 0.0015.
  const share = turbulentShare(result);
  const wallSlip = (1 - share) + share * Math.min(1, (0.0015 * result.tip * R) / (cells * Math.max(nut + result.main.mu / rho, 1e-9)));
  const shaftR = Math.max(0.012 * vessel.diameter, 0.5 * h);

  const size = NR * NZ;
  const id = (i, j) => i + j * NR;
  const rc = (i) => (i + 0.5) * h;
  const zc = (j) => (j + 0.5) * hz;

  // Solid cells: the bottom head and the shaft (down to its lowest impeller).
  const low = Math.min(...config.impellers.map((imp) => imp.clearance));
  const solid = new Uint8Array(size);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NR; i++) {
      const r = rc(i);
      const z = zc(j);
      if (z < head.at(Math.min(r, R))) solid[id(i, j)] = 1;
      else if (r < shaftR && z > low) solid[id(i, j)] = 2;
    }
  const fluidCell = (i, j) => i >= 0 && i < NR && j >= 0 && j < NZ && !solid[id(i, j)];

  // Faces: u at (i*h, zc(j)) for i = 0..NR, w at (rc(i), j*hz) for j = 0..NZ.
  const u = new Float32Array((NR + 1) * NZ);
  const w = new Float32Array(NR * (NZ + 1));
  const uOpen = new Uint8Array((NR + 1) * NZ);
  const wOpen = new Uint8Array(NR * (NZ + 1));
  const ui = (i, j) => i + j * (NR + 1);
  const wi = (i, j) => i + j * NR;
  for (let j = 0; j < NZ; j++) for (let i = 1; i < NR; i++) uOpen[ui(i, j)] = fluidCell(i - 1, j) && fluidCell(i, j) ? 1 : 0;
  for (let j = 1; j < NZ; j++) for (let i = 0; i < NR; i++) wOpen[wi(i, j)] = fluidCell(i, j - 1) && fluidCell(i, j) ? 1 : 0;

  const v = new Float32Array(size); // swirl velocity at cell centres
  const p = new Float32Array(size); // pressure * dt / rho
  const tracer = new Float32Array(size);
  const nuCap = 20 * omega * R * R;
  const nu = new Float32Array(size).fill(nut + Math.min(result.main.mu / rho, nuCap));
  const gamma = new Float32Array(size);
  const scratchU = new Float32Array(u.length);
  const scratchW = new Float32Array(w.length);
  const scratchC = new Float32Array(size);
  const scratchT = new Float32Array(size);

  // Impeller sources: per cell weights for swirl, radial and axial drive.
  const swirlTarget = new Float32Array(size);
  const swirlRate = new Float32Array(size);
  const uTarget = new Float32Array(u.length);
  const uRate = new Float32Array(u.length);
  const wTarget = new Float32Array(w.length);
  const wRate = new Float32Array(w.length);
  // Which impeller drives each face, so its gain can be calibrated.
  const uOwner = new Int8Array(u.length).fill(-1);
  const wOwner = new Int8Array(w.length).fill(-1);
  const gain = result.impellers.map(() => 1);
  const bell = (x) => Math.exp(-0.5 * x * x);

  result.impellers.forEach((imp, owner) => {
    const spec = IMPELLERS[imp.type];
    const D = imp.diameter;
    const tip = D / 2;
    const C = imp.clearance;
    const Wb = imp.width * D;
    const rate = Math.min(60, (omega * imp.blades) / 4);
    const flowShare = Math.min(1, imp.Nq / Math.max(spec.Nq, 1e-6)) || 0;
    if (imp.type === "anchor") {
      // Two arms close to the wall from the clearance up to C + Wb, and a
      // bottom bar following the head.
      const arm = Math.max(0.06 * D, 1.5 * h);
      for (let j = 0; j < NZ; j++)
        for (let i = 0; i < NR; i++) {
          const r = rc(i);
          const z = zc(j);
          const top = C + Wb;
          const inArm = r > tip - arm && r < tip && z > head.at(Math.min(r, R)) && z < top;
          const bar = r < tip && Math.abs(z - Math.max(C, head.at(Math.min(r, R)) + (C - head.at(0)))) < arm;
          if (inArm || bar) {
            const k = id(i, j);
            swirlTarget[k] = Math.max(swirlTarget[k], spec.swirl * omega * r);
            swirlRate[k] = Math.max(swirlRate[k], rate);
          }
        }
      return;
    }
    const halfH = Math.max(Wb / 2, 1.2 * hz);
    const Ud = spec.flow === "radial" ? (imp.Nq * N * D * D) / (Math.PI * Wb) : 0;
    const Ua = spec.flow === "axial" || spec.flow === "mixed" ? (4 * imp.Nq * N * D) / Math.PI : 0;
    const sign = imp.pumping === "up" ? 1 : -1;
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const r = rc(i);
        const z = zc(j);
        const dz = (z - C) / halfH;
        if (Math.abs(dz) > 1.6 || r > tip * 1.05) continue;
        const k = id(i, j);
        const along = Math.min(1, r / tip);
        const wgt = bell(dz * 1.2) * (r <= tip ? 1 : 0.5);
        swirlTarget[k] = Math.max(swirlTarget[k], spec.swirl * omega * r * (0.6 + 0.4 * flowShare));
        swirlRate[k] = Math.max(swirlRate[k], rate * wgt);
      }
    // Radial discharge just inside and beyond the tip.
    if (Ud > 0) {
      for (let j = 0; j < NZ; j++)
        for (let i = 1; i < NR; i++) {
          const r = i * h;
          const z = zc(j);
          const dz = (z - C) / halfH;
          if (Math.abs(dz) > 1.4 || r < 0.55 * tip || r > tip * 1.08) continue;
          const k = ui(i, j);
          uTarget[k] = Ud * Math.min(1, r / tip) * bell(dz * 1.3);
          uRate[k] = Math.max(uRate[k], rate * 0.8);
          uOwner[k] = owner;
        }
    }
    // Axial discharge through the swept disc, peaking near 0.7 of the tip
    // radius; a pitched blade throws part of it outward too.
    if (Ua > 0) {
      for (let j = 1; j < NZ; j++)
        for (let i = 0; i < NR; i++) {
          const r = rc(i);
          const z = j * hz;
          const dz = (z - C) / halfH;
          if (Math.abs(dz) > 1.3 || r > tip) continue;
          const x = r / tip;
          const profile = 1.9 * Math.sin(Math.PI * Math.min(1, x * 0.95)) * (0.35 + 0.65 * x);
          const k = wi(i, j);
          wTarget[k] = sign * Ua * profile * 0.62;
          wRate[k] = Math.max(wRate[k], rate * 0.7 * bell(dz * 1.1));
          wOwner[k] = owner;
        }
      if (spec.flow === "mixed") {
        const tilt = Math.cos((imp.pitch * Math.PI) / 180);
        for (let j = 0; j < NZ; j++)
          for (let i = 1; i < NR; i++) {
            const r = i * h;
            const z = zc(j) - sign * halfH * 0.7;
            const dz = (z - C) / halfH;
            if (Math.abs(dz) > 1.3 || r < 0.6 * tip || r > tip * 1.05) continue;
            const k = ui(i, j);
            uTarget[k] = Ua * 0.45 * tilt * bell(dz * 1.4);
            uRate[k] = Math.max(uRate[k], rate * 0.5);
            uOwner[k] = owner;
          }
      }
    }
  });

  // Baffle drag on swirl within the baffle width of the wall.
  const baffleZone = vessel.baffles ? vessel.baffleWidth * vessel.diameter * 1.15 : 0;
  const baffleDrag = vessel.baffles ? (vessel.baffles / 4) * 2.2 / Math.max(baffleZone, h) : 0;

  // ---------- interpolation ----------
  // Bilinear samples on the three grids; trace() leaves its result in tr, tz.
  function sampleU(r, z) {
    let x = r / h, y = z / hz - 0.5;
    x = x < 0 ? 0 : x > NR ? NR : x;
    y = y < 0 ? 0 : y > NZ - 1 ? NZ - 1 : y;
    let i0 = x | 0, j0 = y | 0;
    if (i0 > NR - 1) i0 = NR - 1;
    if (j0 > NZ - 2) j0 = NZ - 2;
    const fx = x - i0, fy = y - j0;
    const k = i0 + j0 * (NR + 1);
    return (u[k] * (1 - fx) + u[k + 1] * fx) * (1 - fy) + (u[k + NR + 1] * (1 - fx) + u[k + NR + 2] * fx) * fy;
  }
  function sampleW(r, z) {
    let x = r / h - 0.5, y = z / hz;
    x = x < 0 ? 0 : x > NR - 1 ? NR - 1 : x;
    y = y < 0 ? 0 : y > NZ ? NZ : y;
    let i0 = x | 0, j0 = y | 0;
    if (i0 > NR - 2) i0 = NR - 2;
    if (j0 > NZ - 1) j0 = NZ - 1;
    const fx = x - i0, fy = y - j0;
    const k = i0 + j0 * NR;
    return (w[k] * (1 - fx) + w[k + 1] * fx) * (1 - fy) + (w[k + NR] * (1 - fx) + w[k + NR + 1] * fx) * fy;
  }
  function sampleC(field, r, z) {
    let x = r / h - 0.5, y = z / hz - 0.5;
    x = x < 0 ? 0 : x > NR - 1 ? NR - 1 : x;
    y = y < 0 ? 0 : y > NZ - 1 ? NZ - 1 : y;
    let i0 = x | 0, j0 = y | 0;
    if (i0 > NR - 2) i0 = NR - 2;
    if (j0 > NZ - 2) j0 = NZ - 2;
    const fx = x - i0, fy = y - j0;
    const k = i0 + j0 * NR;
    return (field[k] * (1 - fx) + field[k + 1] * fx) * (1 - fy) + (field[k + NR] * (1 - fx) + field[k + NR + 1] * fx) * fy;
  }
  // Back-trace a point by the meridional velocity (midpoint rule), keeping
  // it inside the domain.
  let tr = 0, tz = 0;
  function trace(r, z, dt) {
    const rm = r - 0.5 * dt * sampleU(r, z), zm = z - 0.5 * dt * sampleW(r, z);
    const a = r - dt * sampleU(rm, zm), b = z - dt * sampleW(rm, zm);
    tr = a < 0 ? 0 : a > R ? R : a;
    tz = b < 0 ? 0 : b > H ? H : b;
  }

  // ---------- implicit viscosity stencils ----------
  // For each unknown of a component: up to four neighbours with a geometric
  // coefficient and a boundary mode. 0 open, 1 slip (free surface), 2 a wall
  // value of zero (a closed face of the same component), 3 no-slip (ghost -x),
  // 4 the turning shaft (ghost 2 vs - x).
  function stencilOf(kind) {
    const cols = kind === "u" ? NR + 1 : NR;
    const rows = kind === "w" ? NZ + 1 : NZ;
    const n = cols * rows;
    const open = new Uint8Array(n);
    const nbr = new Int32Array(4 * n).fill(-1);
    const coef = new Float32Array(4 * n);
    const mode = new Uint8Array(4 * n);
    const extra = new Float32Array(n);
    const isOpen = (i, j) => {
      if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
      if (kind === "u") return uOpen[i + j * cols] === 1;
      if (kind === "w") return wOpen[i + j * cols] === 1;
      return !solid[i + j * cols];
    };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = i + j * cols;
        if (!isOpen(i, j)) continue;
        open[k] = 1;
        const r = Math.max(kind === "u" ? i * h : rc(i), 0.5 * h);
        const east = (r + 0.5 * h) / r, west = Math.max(r - 0.5 * h, 0) / r;
        const list = [
          [i + 1, j, east / (h * h), kind === "u", false],
          [i - 1, j, west / (h * h), kind === "u", false],
          [i, j + 1, 1 / (hz * hz), kind === "w", j + 1 >= rows],
          [i, j - 1, 1 / (hz * hz), kind === "w", false],
        ];
        list.forEach(([ii, jj, c, normal, free], d) => {
          const q = 4 * k + d;
          if (d === 1 && i === 0) { mode[q] = 5; return; }
          coef[q] = c;
          if (isOpen(ii, jj)) { mode[q] = 0; nbr[q] = ii + jj * cols; }
          else if (free) mode[q] = 1;
          else if (normal) mode[q] = 2;
          else if (kind === "v" && ii >= 0 && jj >= 0 && ii < cols && jj < rows && solid[ii + jj * cols] === 2) { mode[q] = 4; nbr[q] = ii + jj * cols; }
          else mode[q] = 3;
        });
        if (kind !== "w") extra[k] = 1 / (r * r);
      }
    return { cols, rows, n, open, nbr, coef, mode, extra };
  }

  // ---------- steps ----------
  function advect(dt) {
    scratchU.set(u);
    scratchW.set(w);
    for (let j = 0; j < NZ; j++)
      for (let i = 1; i < NR; i++) {
        const k = ui(i, j);
        if (!uOpen[k]) { scratchU[k] = 0; continue; }
        trace(i * h, zc(j), dt);
        scratchU[k] = sampleU(tr, tz);
      }
    for (let j = 1; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = wi(i, j);
        if (!wOpen[k]) { scratchW[k] = 0; continue; }
        trace(rc(i), j * hz, dt);
        scratchW[k] = sampleW(tr, tz);
      }
    // Swirl travels as angular momentum r v, which advection conserves.
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = id(i, j);
        if (solid[k]) { scratchC[k] = 0; scratchT[k] = tracer[k]; continue; }
        trace(rc(i), zc(j), dt);
        scratchC[k] = sampleC(angular, tr, tz) / rc(i);
        scratchT[k] = tracerActive ? sampleC(tracer, tr, tz) : 0;
      }
    u.set(scratchU);
    w.set(scratchW);
    v.set(scratchC);
    tracer.set(scratchT);
  }
  // r v at cell centres, refreshed before each advection.
  const angular = new Float32Array(size);
  function angularMomentum() {
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NR; i++) angular[id(i, j)] = v[id(i, j)] * rc(i);
  }

  function forces(dt) {
    // Swirl: impeller drive, shaft, baffle and wall drag.
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = id(i, j);
        if (solid[k]) { v[k] = solid[k] === 2 ? omega * rc(i) : 0; continue; }
        if (swirlRate[k] > 0) v[k] += (swirlTarget[k] - v[k]) * (1 - Math.exp(-swirlRate[k] * dt));
        if (baffleZone && R - rc(i) < baffleZone) v[k] /= 1 + baffleDrag * Math.abs(v[k]) * dt;
      }
    // Radial: centrifugal v^2/r and the impeller discharge.
    for (let j = 0; j < NZ; j++)
      for (let i = 1; i < NR; i++) {
        const k = ui(i, j);
        if (!uOpen[k]) continue;
        const vm = 0.5 * (v[id(i - 1, j)] + v[id(i, j)]);
        u[k] += (dt * vm * vm) / (i * h);
        if (uRate[k] > 0) u[k] += (uTarget[k] * (uOwner[k] >= 0 ? gain[uOwner[k]] : 1) - u[k]) * (1 - Math.exp(-uRate[k] * dt));
      }
    for (let j = 1; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = wi(i, j);
        if (!wOpen[k] || wRate[k] <= 0) continue;
        w[k] += (wTarget[k] * (wOwner[k] >= 0 ? gain[wOwner[k]] : 1) - w[k]) * (1 - Math.exp(-wRate[k] * dt));
      }
  }

  // Local shear rate and apparent viscosity at cell centres.
  function rheology() {
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = id(i, j);
        if (solid[k]) { gamma[k] = 0; continue; }
        const r = rc(i);
        const dudr = (u[ui(i + 1, j)] - u[ui(i, j)]) / h;
        const dwdz = (w[wi(i, j + 1)] - w[wi(i, j)]) / hz;
        const uc = 0.5 * (u[ui(i + 1, j)] + u[ui(i, j)]);
        const jp = Math.min(j + 1, NZ - 1), jm = Math.max(j - 1, 0);
        const ip = Math.min(i + 1, NR - 1), im = Math.max(i - 1, 0);
        const uz = (0.5 * (u[ui(i, jp)] + u[ui(i + 1, jp)]) - 0.5 * (u[ui(i, jm)] + u[ui(i + 1, jm)])) / ((jp - jm) * hz || 1);
        const wr = (0.5 * (w[wi(ip, j)] + w[wi(ip, j + 1)]) - 0.5 * (w[wi(im, j)] + w[wi(im, j + 1)])) / ((ip - im) * h || 1);
        const vr = (v[id(ip, j)] / rc(ip) - v[id(im, j)] / rc(im)) / ((ip - im) * h || 1) * r;
        const vz = (v[id(i, jp)] - v[id(i, jm)]) / ((jp - jm) * hz || 1);
        const s2 = 2 * (dudr * dudr + dwdz * dwdz + (uc / r) ** 2) + (uz + wr) ** 2 + vr * vr + vz * vz;
        gamma[k] = Math.sqrt(s2);
        if (fluid.model !== "newtonian") nu[k] = Math.min(apparentViscosity(fluid, gamma[k]) / rho, nuCap) + nut;
      }
  }

  // Implicit viscosity, (1 - dt nu L) x = x0, by red-black Gauss-Seidel.
  const stencils = { u: stencilOf("u"), w: stencilOf("w"), v: stencilOf("v") };
  const x0 = new Float32Array(Math.max(u.length, w.length, size));
  const nuAt = new Float32Array(Math.max(u.length, w.length, size));
  function diffuse(field, kind, dt, sweeps = 6) {
    const S = stencils[kind];
    const { cols, rows, open, nbr, coef, mode, extra } = S;
    x0.set(field);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = i + j * cols;
        if (kind === "u") nuAt[k] = 0.5 * (nu[id(i > 0 ? i - 1 : 0, j)] + nu[id(i < NR ? i : NR - 1, j)]);
        else if (kind === "w") nuAt[k] = 0.5 * (nu[id(i, j > 0 ? j - 1 : 0)] + nu[id(i, j < NZ ? j : NZ - 1)]);
        else nuAt[k] = nu[k];
      }
    for (let s = 0; s < sweeps; s++)
      for (let colour = 0; colour < 2; colour++)
        for (let j = 0; j < rows; j++)
          for (let i = (j + colour) & 1; i < cols; i += 2) {
            const k = i + j * cols;
            if (!open[k]) continue;
            const a = dt * nuAt[k];
            const fk = field[k];
            let sum = 0, diag = 1 + a * extra[k];
            for (let d = 0; d < 4; d++) {
              const q = 4 * k + d;
              const m = mode[q];
              if (m === 5) continue;
              const c = a * coef[q];
              diag += c;
              if (m === 0) sum += c * field[nbr[q]];
              else if (m === 1) sum += c * fk;
              else if (m === 3) sum += c * fk * (1 - 2 * wallSlip);
              else if (m === 4) sum += c * (2 * field[nbr[q]] - fk);
            }
            field[k] = (x0[k] + sum) / diag;
          }
  }

  // Pressure projection by Gauss-Seidel on the velocity itself: raising the
  // pressure of a cell by dp changes its divergence by dp * diag, so each
  // visit corrects its open faces at once (over-relaxed, red-black order).
  const cellsOf = [[], []];
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NR; i++) if (!solid[id(i, j)]) cellsOf[(i + j) & 1].push(i + j * NR);
  const order = Int32Array.from([...cellsOf[0], ...cellsOf[1]]);
  const pE = new Int32Array(size), pW = new Int32Array(size), pN = new Int32Array(size), pS = new Int32Array(size);
  const dE = new Float32Array(size), dW = new Float32Array(size), dN = new Float32Array(size), dS = new Float32Array(size);
  const inv = new Float32Array(size);
  for (const k of order) {
    const i = k % NR, j = (k / NR) | 0;
    const r = rc(i);
    pE[k] = ui(i + 1, j); pW[k] = ui(i, j); pN[k] = wi(i, j + 1); pS[k] = wi(i, j);
    // Divergence weights of the four faces (zero when the face is closed).
    dE[k] = uOpen[pE[k]] ? ((i + 1) * h) / (r * h) : 0;
    dW[k] = uOpen[pW[k]] ? (i * h) / (r * h) : 0;
    dN[k] = wOpen[pN[k]] ? 1 / hz : 0;
    dS[k] = wOpen[pS[k]] ? 1 / hz : 0;
    const diag = (dE[k] + dW[k]) / h + (dN[k] + dS[k]) / hz;
    inv[k] = diag > 0 ? 1 / diag : 0;
  }
  const uh = 1 / h, wh = 1 / hz;
  function divergenceAt(k) {
    return dE[k] * u[pE[k]] - dW[k] * u[pW[k]] + dN[k] * w[pN[k]] - dS[k] * w[pS[k]];
  }
  function project(iterations = 60) {
    const relax = 1.85;
    const n = order.length;
    for (let it = 0; it < iterations; it++)
      for (let q = 0; q < n; q++) {
        const k = order[q];
        const dp = -relax * divergenceAt(k) * inv[k];
        if (dE[k]) u[pE[k]] += dp * uh;
        if (dW[k]) u[pW[k]] -= dp * uh;
        if (dN[k]) w[pN[k]] += dp * wh;
        if (dS[k]) w[pS[k]] -= dp * wh;
      }
  }
  function residual() {
    let worst = 0;
    for (const k of order) worst = Math.max(worst, Math.abs(divergenceAt(k)));
    return worst;
  }

  let time = 0;
  let tracerActive = false;
  let steps = 0;
  const maxSpeed = () => {
    let m = 0;
    for (let k = 0; k < u.length; k++) m = Math.max(m, Math.abs(u[k]));
    for (let k = 0; k < w.length; k++) m = Math.max(m, Math.abs(w[k]));
    return m;
  };
  let umax = 0;

  function step() {
    const scale = Math.max(umax, 0.35 * result.tip, 1e-4);
    const dt = Math.min((1.2 * Math.min(h, hz)) / scale, 0.25 / N);
    angularMomentum();
    advect(dt);
    forces(dt);
    if (steps % 3 === 0) rheology();
    diffuse(u, "u", dt);
    diffuse(w, "w", dt);
    diffuse(v, "v", dt);
    project();
    if (tracerActive) diffuseTracer(dt);
    time += dt;
    steps++;
    if (steps % 4 === 0) umax = maxSpeed();
    if (steps % 10 === 0 && time * N > 1.5) calibrate();
    return dt;
  }

  // Tracer: same advection, turbulent (Sc_t = 0.7) or molecular diffusion.
  function diffuseTracer(dt) {
    // Zero-flux walls: only open neighbours take part.
    const S = stencils.v;
    x0.set(tracer);
    for (let s = 0; s < 4; s++)
      for (let k = 0; k < size; k++) {
        if (!S.open[k]) continue;
        const a = (dt * nu[k]) / 0.7;
        let sum = 0, diag = 1;
        for (let d = 0; d < 4; d++) {
          const q = 4 * k + d;
          if (S.mode[q] !== 0) continue;
          const c = a * S.coef[q];
          diag += c;
          sum += c * tracer[S.nbr[q]];
        }
        tracer[k] = (x0[k] + sum) / diag;
      }
  }

  // Inject a ring of tracer just under the surface at r (default: half radius).
  function inject(rFrac = 0.5) {
    tracer.fill(0);
    const r0 = rFrac * R;
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const dr = (rc(i) - r0) / (0.12 * R);
        const dz = (zc(j) - (H - 0.08 * H)) / (0.06 * H);
        if (!solid[id(i, j)]) tracer[id(i, j)] = Math.exp(-dr * dr - dz * dz);
      }
    // Normalise so the fully mixed concentration is 1 (volume weighted).
    const [sum, vol] = moments();
    const mean = sum / vol;
    for (let k = 0; k < size; k++) tracer[k] /= mean || 1;
    tracerActive = true;
    injectedAt = time;
  }
  let injectedAt = 0;
  function moments() {
    let sum = 0, vol = 0;
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = id(i, j);
        if (solid[k]) continue;
        const dv = rc(i);
        sum += tracer[k] * dv;
        vol += dv;
      }
    return [sum, vol];
  }
  // Coefficient of variation of the tracer over the volume, and the worst
  // local deviation: mixed to 95% when every cell is within 5% of the mean.
  function mixing() {
    if (!tracerActive) return null;
    const [sum, vol] = moments();
    const mean = sum / vol;
    let worst = 0, varSum = 0;
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = id(i, j);
        if (solid[k]) continue;
        const d = Math.abs(tracer[k] / mean - 1);
        worst = Math.max(worst, d);
        varSum += d * d * rc(i);
      }
    return { cov: Math.sqrt(varSum / vol), worst, since: time - injectedAt };
  }

  // Cell-centred fields for display.
  function velocityAt(i, j) {
    const uc = 0.5 * (u[ui(i, j)] + u[ui(i + 1, j)]);
    const wc = 0.5 * (w[wi(i, j)] + w[wi(i, j + 1)]);
    return [uc, wc, v[id(i, j)]];
  }
  function fieldOf(kind, out) {
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NR; i++) {
        const k = id(i, j);
        if (solid[k]) { out[k] = NaN; continue; }
        const [a, b, c] = velocityAt(i, j);
        if (kind === "speed") out[k] = Math.sqrt(a * a + b * b + c * c);
        else if (kind === "meridional") out[k] = Math.sqrt(a * a + b * b);
        else if (kind === "axial") out[k] = b;
        else if (kind === "radial") out[k] = a;
        else if (kind === "swirl") out[k] = c;
        else if (kind === "shear") out[k] = gamma[k];
        else if (kind === "viscosity") out[k] = Math.log10(Math.max(nu[k] * rho, 1e-6));
        else if (kind === "tracer") out[k] = tracer[k];
      }
    return out;
  }

  // Pumping through the impeller: radial flux at the tip cylinder for radial
  // types, axial flux through the swept disc for axial ones (m3/s).
  function pumping(imp) {
    const spec = IMPELLERS[imp.type];
    const tip = imp.diameter / 2;
    if (spec.flow === "radial") {
      const i = Math.min(NR, Math.max(1, Math.round(tip / h)));
      const half = (imp.width * imp.diameter) / 2;
      let q = 0;
      for (let j = 0; j < NZ; j++) if (Math.abs(zc(j) - imp.clearance) <= half + 0.5 * hz) q += Math.max(0, u[ui(i, j)]) * 2 * Math.PI * i * h * hz;
      return q;
    }
    if (spec.flow === "axial" || spec.flow === "mixed") {
      const below = imp.clearance + (imp.pumping === "up" ? 1 : -1) * (imp.width * imp.diameter) * 0.6;
      const j = Math.min(NZ, Math.max(1, Math.round(below / hz)));
      let q = 0;
      for (let i = 0; i < NR; i++) if (rc(i) <= tip) q += Math.abs(w[wi(i, j)]) * 2 * Math.PI * rc(i) * h;
      return q;
    }
    return 0;
  }

  // Scale each impeller's discharge drive until the simulated pumping
  // matches its flow number, Q = Nq N D^3 (an actuator calibrated to Nq).
  function calibrate() {
    result.impellers.forEach((imp, index) => {
      if (!(imp.Q > 0)) return;
      const q = pumping(imp);
      if (!(q > 0)) return;
      gain[index] = Math.min(4, Math.max(0.3, gain[index] * Math.pow(imp.Q / q, 0.15)));
    });
  }

  // Free-surface depression from the swirl at the top row: dp/dr = rho v^2/r.
  function vortexDepth() {
    let depth = 0;
    const j = NZ - 1;
    for (let i = 0; i < NR; i++) {
      const vv = v[id(i, j)];
      depth += ((vv * vv) / rc(i)) * h;
    }
    return depth / 9.81;
  }

  function surfaceProfile(out) {
    let acc = 0;
    const j = NZ - 1;
    for (let i = 0; i < NR; i++) {
      const vv = v[id(i, j)];
      acc += ((vv * vv) / rc(i)) * h;
      out[i] = acc / 9.81;
    }
    return out;
  }

  return {
    NR, NZ, h, hz, R, H, solid, u, w, v, p, tracer, gamma, nu, nut,
    get time() { return time; },
    get steps() { return steps; },
    get umax() { return umax; },
    get gain() { return gain.slice(); },
    step, inject, mixing, residual, fieldOf, pumping, vortexDepth, surfaceProfile, sampleU, sampleW, sampleC, velocityAt,
    fluidAt(r, z) {
      const i = Math.floor(r / h), j = Math.floor(z / hz);
      return fluidCell(i, j);
    },
    reset() { u.fill(0); w.fill(0); v.fill(0); p.fill(0); tracer.fill(0); tracerActive = false; time = 0; steps = 0; umax = 0; },
  };
}

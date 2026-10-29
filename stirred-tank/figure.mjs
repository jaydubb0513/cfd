// The drawing: an agitated vessel on legs with a 90° wedge cut out toward the
// viewer, so the two cut faces of the liquid (planes at ±45° from the view)
// carry the computed flow. Built from the anatomy kit (iso-kit + lathe), in
// world units of about 1 px, x and y on the floor and z up.
//
// Layers, back to front: `back` (pad, legs, shell, rim, nozzles), the flow
// canvas, `front` (cut faces of the wall, shaft, drive, bridge) with two
// live groups for the turning impellers: `dim` (blades behind the cut faces,
// seen through the liquid and clipped to it) and `near` (blades in the wedge).

import * as k from "../.claude/skills/anatomy/kit/iso-kit.mjs";
import * as G from "../.claude/skills/anatomy/kit/lathe.mjs";
import { headOf } from "./model.mjs";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
export const WEDGE = 45 * DEG;

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);

const signedArea = (points) => {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
};
const oriented = (points) => (signedArea(points) < 0 ? [...points].reverse() : points);

// Join loose segments that share end points into polylines.
function chain(segments) {
  const key = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const ends = new Map();
  segments.forEach((seg, index) => {
    for (const end of [0, 1]) {
      const name = key(seg[end]);
      if (!ends.has(name)) ends.set(name, []);
      ends.get(name).push([index, end]);
    }
  });
  const used = new Uint8Array(segments.length);
  const lines = [];
  const walk = (line, point) => {
    for (;;) {
      const next = (ends.get(key(point)) || []).find(([index]) => !used[index]);
      if (!next) return;
      used[next[0]] = 1;
      point = segments[next[0]][1 - next[1]];
      line.push(point);
    }
  };
  segments.forEach((seg, index) => {
    if (used[index]) return;
    used[index] = 1;
    const line = [seg[0], seg[1]];
    walk(line, seg[1]);
    line.reverse();
    walk(line, line[line.length - 1]);
    lines.push(line);
  });
  return lines.map((line) => k.pathOf(line)).join("");
}

// A partial surface of revolution about the vertical axis through the
// origin: meridian [[r, z, smooth?], ...] swept over view-relative angles
// t0..t1. Facets are culled and shaded by the kit's light; the outline is
// every visible facet edge whose neighbour is hidden or missing, so cut
// edges and limbs both come out. Returns kit SolidPaths.
export function revolve(meridian, t0, t1, P, { inward = false, step = 2.5 } = {}) {
  const a = (P.azimuth ?? 45) * DEG;
  const V = G.viewOf(P);
  const Lt = G.lightOf(P);
  const n = Math.max(2, Math.ceil((t1 - t0) / (step * DEG)));
  const m = meridian.length;
  const angle = (j) => a + t0 + ((t1 - t0) * j) / n;
  const pts = meridian.map(([r, z]) => Array.from({ length: n + 1 }, (_, j) => k.iso([r * Math.cos(angle(j)), r * Math.sin(angle(j)), z], P)));
  const vis = [];
  const tone = [];
  for (let i = 0; i < m - 1; i++) {
    const dr = meridian[i + 1][0] - meridian[i][0];
    const dz = meridian[i + 1][1] - meridian[i][1];
    const len = Math.hypot(dr, dz) || 1;
    const nr = (inward ? -dz : dz) / len;
    const nz = (inward ? dr : -dr) / len;
    const row = [];
    const toneRow = [];
    for (let j = 0; j < n; j++) {
      const phi = angle(j + 0.5);
      const normal = [nr * Math.cos(phi), nr * Math.sin(phi), nz];
      row.push(G.dot3(normal, V) > 1e-6 && Math.hypot(dr, dz) > 1e-9);
      toneRow.push(G.bandOf(G.dot3(normal, Lt)));
    }
    vis.push(row);
    tone.push(toneRow);
  }
  const buckets = [[], [], [], [], []];
  const fills = [];
  for (let i = 0; i < m - 1; i++) {
    let j = 0;
    while (j < n) {
      if (!vis[i][j]) { j++; continue; }
      const t = tone[i][j];
      let e = j;
      while (e + 1 < n && vis[i][e + 1] && tone[i][e + 1] === t) e++;
      const poly = [];
      for (let q = j; q <= e + 1; q++) poly.push(pts[i][q]);
      for (let q = e + 1; q >= j; q--) poly.push(pts[i + 1][q]);
      const d = k.pathOf(oriented(poly), true);
      buckets[t].push(d);
      fills.push(d);
      j = e + 1;
    }
  }
  const edges = [];
  const creases = [];
  for (let i = 0; i < m - 1; i++)
    for (let j = 0; j < n; j++) {
      if (!vis[i][j]) continue;
      if (j === 0 || !vis[i][j - 1]) edges.push([pts[i][j], pts[i + 1][j]]);
      if (j === n - 1 || !vis[i][j + 1]) edges.push([pts[i][j + 1], pts[i + 1][j + 1]]);
      if (meridian[i][0] > 1e-6 && (i === 0 || !vis[i - 1][j])) edges.push([pts[i][j], pts[i][j + 1]]);
      if (meridian[i + 1][0] > 1e-6 && (i === m - 2 || !vis[i + 1][j])) edges.push([pts[i + 1][j], pts[i + 1][j + 1]]);
      if (i > 0 && vis[i - 1][j] && !meridian[i][2] && meridian[i][0] > 1e-6) creases.push([pts[i][j], pts[i][j + 1]]);
    }
  return { fill: fills.join(""), outline: chain(edges), crease: chain(creases), top: buckets[4].join(""), shades: buckets.slice(0, 4).map((list) => list.join("")), seamless: true };
}

// Everything about the drawing that depends on the config.
export function layoutOf(config, result) {
  const { vessel } = config;
  const T = vessel.diameter;
  const s = 230 / T; // world units per metre
  const head = headOf(vessel);
  const Rw = (T / 2) * s;
  const tw = Math.min(5, Math.max(2.6, vessel.wall * s));
  const Zb = 74;
  const rimM = Math.max(head.depth + vessel.straightSide, vessel.liquidHeight + 0.04 * T);
  const Zr = Zb + rimM * s;
  const Hw = Zb + vessel.liquidHeight * s;
  const zIn = (r) => Zb + head.at(Math.min(Math.abs(r), Rw) / s) * s;
  // Inner meridian, bottom centre to rim, finely sampled through the head.
  const inner = [];
  const samples = 40;
  for (let i = 0; i <= samples; i++) {
    const r = (Rw * i) / samples;
    inner.push([r, zIn(r), i > 0 && i < samples && vessel.head !== "flat" && vessel.head !== "conical" ? 1 : 0]);
  }
  if (vessel.head === "flat") inner.splice(1, inner.length - 2);
  if (vessel.head === "conical") inner.splice(1, inner.length - 2);
  inner.push([Rw, Zr, 0]);
  // Outer meridian: the inner one offset by the wall along its normal.
  const outer = inner.map(([r, z, smooth], i) => {
    const a = inner[Math.max(0, i - 1)];
    const b = inner[Math.min(inner.length - 1, i + 1)];
    let dr = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dr, dz) || 1;
    dr /= len; dz /= len;
    if (i === 0) return [0, z - tw, 0];
    if (i === inner.length - 1) return [r + tw, z, 0];
    // At a corner, push out along the bisector so the wall keeps its width.
    let nr = dz, nz = -dr;
    if (!smooth && i > 0 && i < inner.length - 1) {
      const t1 = [inner[i][0] - inner[i - 1][0], inner[i][1] - inner[i - 1][1]];
      const t2 = [inner[i + 1][0] - inner[i][0], inner[i + 1][1] - inner[i][1]];
      const l1 = Math.hypot(...t1) || 1, l2 = Math.hypot(...t2) || 1;
      const n1 = [t1[1] / l1, -t1[0] / l1], n2 = [t2[1] / l2, -t2[0] / l2];
      const bis = [n1[0] + n2[0], n1[1] + n2[1]];
      const bl = Math.hypot(...bis) || 1;
      const cos = (bis[0] / bl) * n1[0] + (bis[1] / bl) * n1[1];
      nr = (bis[0] / bl) / Math.max(cos, 0.3);
      nz = (bis[1] / bl) / Math.max(cos, 0.3);
    }
    return [r + nr * tw, z + nz * tw, smooth];
  });
  return { T, s, head, Rw, tw, Zb, Zr, Hw, zIn, inner, outer, rimM };
}

// Angles (view relative) of the baffles that survive the cut.
export function bafflesOf(config) {
  const n = config.vessel.baffles;
  const list = [];
  for (let i = 0; i < n; i++) {
    let t = (TAU * i) / n + Math.PI / n + 12 * DEG;
    t = Math.atan2(Math.sin(t), Math.cos(t));
    if (Math.abs(t) > WEDGE + 6 * DEG) list.push(t);
  }
  return list;
}

export function buildFigure(config, result, { width = 760 } = {}) {
  const lay = layoutOf(config, result);
  const { s, Rw, tw, Zb, Zr, Hw, zIn, inner, outer } = lay;
  const T = lay.T;
  const pad = { x: -(Rw + 30), y: -(Rw + 30), w: 2 * (Rw + 30), d: 2 * (Rw + 30), r: 6 };
  const driveTop = Zr + 18 + 130;
  const extremes = [...k.boxCorners(pad, -14, 0), [0, 0, driveTop], [Rw + 60, 0, Zr], [-(Rw + 60), 0, Zr], [0, Rw + 60, Zr], [0, -(Rw + 60), Zr]];
  const probe = k.fitProjection(extremes, 1000, 1000, { pad: 0, azimuth: 45, elevation: 30 });
  const xs = extremes.map((p) => k.iso(p, probe)[0]);
  const ys = extremes.map((p) => k.iso(p, probe)[1]);
  const aspect = (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs));
  const height = Math.round(Math.min(1180, Math.max(560, width * aspect * 1.04 + 40)));
  const P = k.fitProjection(extremes, width, height, { pad: 34, azimuth: 45, elevation: 30 });
  const a = 45 * DEG;
  const dir = (t) => [Math.cos(a + t), Math.sin(a + t), 0];
  const at = (t, r, z) => [r * Math.cos(a + t), r * Math.sin(a + t), z];
  const scr = (p) => k.iso(p, P);
  const depth = (p) => k.depthOf(p, P);
  const KS = G.scaleOf(P);

  // ---------- back ----------
  const back = [];
  // Plinth with a grout groove, anchor plates and a ruler along the front.
  back.push(`<path class="iso-halo" d="${k.haloOf(pad, -14, 14, P)}"/>`);
  back.push(S(k.slabOf(pad, -14, 14, P, 8, 1.4), { tone: "lo" }));
  back.push(L(k.planOutline(k.insetPlan(pad, 6), 0, P), { tone: "faint" }));
  const screws = k.corners(pad, 12);
  back.push(L(screws.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(""), { tone: "lo" }));
  back.push(D(screws.map(([x, y]) => scr([x, y, 0])), { size: 0.5 }));
  // Ruler: one tick per 0.1 m, a major per 0.5 m, along the +x front edge.
  const rulerLen = Math.min(pad.w - 40, Math.floor((pad.w - 40) / (0.1 * s)) * 0.1 * s);
  const strip = { x: pad.x + pad.w - 16, y: pad.y + (pad.d - rulerLen) / 2 - 3, w: 8, d: rulerLen + 6, r: 1 };
  back.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const step = (0.1 * s);
  const ticks = k.topTicks(strip.y + 3, strip.y + 3 + rulerLen + 0.01, step, 5, strip.x + strip.w - 0.8, 0.6, [-2.4, -4.4], P, "y");
  back.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  back.push(D([scr([strip.x + 4, strip.y + 1.5, 0.6]), scr([strip.x + 4, strip.y + strip.d - 1.5, 0.6])], { size: 0.4 }));
  // Label plate on the plinth, three engraved rule lines.
  const plate = { x: pad.x + 14, y: pad.y + pad.d - 40, w: 22, d: 30, r: 1.2 };
  back.push(S(k.slabOf(plate, 0, 0.8, P, 3, 0.3), { tone: "mid" }));
  [0.3, 0.5, 0.7].forEach((f, i) => back.push(L(k.lineOnTop([plate.x + 5 + i * 4, plate.y + 5], [plate.x + 5 + i * 4, plate.y + plate.d * f + 6], 0.8, P), { tone: "lo", free: true })));
  back.push(D(k.corners(plate, 2.4).map(([x, y]) => scr([x, y, 0.8])), { size: 0.4 }));
  // Soft shadow under the vessel.
  back.push(`<path class="iso-halo" d="${k.haloOf({ x: -Rw * 0.8, y: -Rw * 0.8, w: 1.6 * Rw, d: 1.6 * Rw, r: Rw * 0.8 }, 0, 0.5, P)}" style="filter:blur(14px);opacity:.28"/>`);

  // Legs: square posts on base plates under lugs welded to the shell.
  const lugZ = Math.min(Zb + (lay.head.depth * s) + 0.12 * (Zr - Zb), Zr - 30);
  const legR = Rw + tw + 7;
  const legAt = [118, -118, 62, -62].map((t) => t * DEG);
  const leg = (t) => {
    const out = [];
    const [cx, cy] = [legR * Math.cos(a + t), legR * Math.sin(a + t)];
    const base = { x: cx - 10, y: cy - 10, w: 20, d: 20, r: 1.5 };
    out.push(S(k.slabOf(base, 0, 2, P, 3, 0.4), { tone: "mid" }));
    out.push(D(k.corners(base, 3).map(([x, y]) => scr([x, y, 2])), { size: 0.45 }));
    out.push(L(k.corners(base, 3).map(([x, y]) => k.ring(x, y, 1.3, 2, P, 10)).join(""), { tone: "lo" }));
    out.push(S(k.slabOf({ x: cx - 4.5, y: cy - 4.5, w: 9, d: 9, r: 1 }, 2, lugZ - 2, P, 3, 0.4), { tone: "mid" }));
    out.push(L(k.sideSeam({ x: cx - 4.5, y: cy - 4.5, w: 9, d: 9, r: 1 }, 12, P, 3), { tone: "faint" }));
    // The lug: a block from the shell out over the post.
    const F = G.frameOf([0, 0, 0], dir(t), [0, 0, 1], [-Math.sin(a + t), Math.cos(a + t), 0]);
    const lug = G.prismOf({ ...F, o: [0, 0, 0] }, [[lugZ, -6], [lugZ + 16, -6], [lugZ + 16, 6], [lugZ, 6]], Rw + tw - 0.4, legR + 6, P);
    out.push(S(lug, { tone: "mid" }));
    out.push(D([scr(at(t, legR + 2, lugZ + 12))], { size: 0.45 }));
    return out.join("");
  };
  for (const t of legAt.slice(0, 2)) back.push(leg(t));

  // Inside of the back wall between the liquid and the rim.
  back.push(S(revolve([[Rw, Hw], [Rw, Zr]], WEDGE, TAU - WEDGE, P, { inward: true }), { tone: "lo", crease: "none" }));
  // Baffles above the liquid (below it they are seen through the cut faces).
  const baffles = bafflesOf(config);
  const bw = config.vessel.baffleWidth * T * s;
  const gap = Math.max(1.2, bw / 6);
  const baffle = (t, z0, z1, style) => {
    const F = G.frameOf([0, 0, 0], [-Math.sin(a + t), Math.cos(a + t), 0], dir(t), [0, 0, 1]);
    const r0 = Rw - gap - bw, r1 = Rw - gap;
    const shape = G.prismOf(F, [[r0, z0], [r1, z0], [r1, z1], [r0, z1]], -0.8, 0.8, P);
    const clips = [0.2, 0.5, 0.8].map((f) => z0 + (z1 - z0) * f).filter((z) => z >= z0 + 3 && z <= z1 - 3).map((z) => G.prismOf(F, [[r1, z - 1.6], [Rw, z - 1.6], [Rw, z + 1.6], [r1, z + 1.6]], -1.6, 1.6, P));
    return S(shape, style) + clips.map((c) => S(c, { tone: "lo" })).join("");
  };
  const bottomOf = (t) => zIn(Rw - gap - bw) + 0.02 * T * s;
  [...baffles].sort((p, q) => depth(at(p, Rw, 0)) - depth(at(q, Rw, 0))).forEach((t) => {
    if (Zr - 2 > Hw + 0.5) back.push(baffle(t, Hw, Zr - 2, { tone: "mid" }));
  });
  // Shell, head and rim flange, all but the wedge.
  back.push(S(revolve(outer, WEDGE, TAU - WEDGE, P), { tone: "mid" }));
  const flange = [[Rw + tw, Zr - 5], [Rw + tw + 6, Zr - 5], [Rw + tw + 6, Zr], [Rw, Zr]];
  back.push(S(revolve(flange, WEDGE, TAU - WEDGE, P), { tone: "mid" }));
  // Girth seams where the head meets the shell and half way up.
  const seams = [];
  for (const z of [Zb + lay.head.depth * s + 3, (Zb + lay.head.depth * s + Zr) / 2].filter((z) => z < Zr - 8)) {
    const pts = [];
    for (let deg = 45; deg <= 315; deg += 2) {
      const t = deg * DEG;
      const c = Math.cos(t);
      if (c > 0.02) pts.push(scr(at(t, Rw + tw, z)));
      else if (pts.length) { seams.push(k.pathOf(pts)); pts.length = 0; }
    }
    if (pts.length) seams.push(k.pathOf(pts.splice(0)));
  }
  back.push(L(seams.join(""), { tone: "faint" }));
  // Bolt holes on the rim flange.
  const bolts = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * TAU + 3.75 * DEG;
    const tt = Math.atan2(Math.sin(t), Math.cos(t));
    if (Math.abs(tt) > WEDGE + 2 * DEG) bolts.push(scr(at(tt, Rw + tw + 3, Zr)));
  }
  back.push(D(bolts, { size: 0.45, tone: "mid" }));
  // A side inlet nozzle on the left flank and a nameplate on the right one.
  const nozzle = (t, z, r, len) => {
    const F = G.frameOf(at(t, 0, z), dir(t), [0, 0, 1], [-Math.sin(a + t), Math.cos(a + t), 0]);
    const out = [];
    out.push(S(G.disc(Rw + tw - 2, Rw + tw + len, r, F, P), { tone: "mid" }));
    out.push(S(G.disc(Rw + tw + len, Rw + tw + len + 3.2, r * 1.9, F, P), { tone: "mid" }));
    out.push(S(G.disc(Rw + tw + len + 3.2, Rw + tw + len + 4.4, r * 1.2, F, P), { tone: "lo" }));
    out.push(D(G.dotsOf(F, Rw + tw + len + 3.2, r * 1.55, 8, P, { phase: Math.PI / 8 }), { size: 0.45 }));
    return out.join("");
  };
  back.push(nozzle(76 * DEG, Zr - 0.18 * (Zr - Zb), 5.5, 12));
  back.push(nozzle(-82 * DEG, Zb + lay.head.depth * s + 0.3 * (Zr - Zb - lay.head.depth * s), 3.4, 8));
  {
    const t = -64 * DEG;
    const zc = (Zb + lay.head.depth * s + Zr) / 2 - 14;
    const F = G.frameOf(at(t, 0, 0), dir(t), [-Math.sin(a + t), Math.cos(a + t), 0], [0, 0, 1]);
    const rr = Rw + tw;
    const plateP = G.prismOf(F, [[-9, zc - 7], [9, zc - 7], [9, zc + 7], [-9, zc + 7]], rr + 0.6, rr + 1.4, P);
    back.push(S(plateP, { tone: "mid" }));
    const lines = [3.5, 0, -3.5].map((dz, i) => k.pathOf([scr(G.pointOf(F, rr + 1.45, 0, 0).map((v, q) => v + F.u[q] * -6 + F.v[q] * (zc + dz))), scr(G.pointOf(F, rr + 1.45, 0, 0).map((v, q) => v + F.u[q] * (i === 2 ? 1 : 6) + F.v[q] * (zc + dz)))]));
    back.push(L(lines.join(""), { tone: "lo", free: true }));
    back.push(D([[-7.5, -5.5], [7.5, -5.5], [7.5, 5.5], [-7.5, 5.5]].map(([x, y]) => scr(G.pointOf(F, rr + 1.45, 0, 0).map((v, q) => v + F.u[q] * x + F.v[q] * (zc + y)))), { size: 0.4 }));
  }
  for (const t of legAt.slice(2)) back.push(leg(t));

  // ---------- front ----------
  const front = [];
  // Cut faces of the wall and rim in both planes, hatched.
  const cutPolygon = (t) => {
    const ring = [...inner.map(([r, z]) => [r, z]), [Rw, Zr], [Rw + tw + 6, Zr], [Rw + tw + 6, Zr - 5], [Rw + tw, Zr - 5], ...outer.slice(0, -1).reverse().map(([r, z]) => [r, z])];
    return ring.map(([r, z]) => scr(at(t, r, z)));
  };
  const cuts = [WEDGE, -WEDGE];
    for (const t of cuts) {
    const poly = cutPolygon(t);
    const d = k.pathOf(poly, true);
    const normal = [-Math.sin(a + t), Math.cos(a + t), 0].map((v) => v * (t > 0 ? -1 : 1));
    const shade = G.bandOf(G.dot3(normal, G.lightOf(P)));
    // 45° hatching, each line cut exactly where it crosses the outline.
    const xs2 = poly.map((p) => p[0]), ys2 = poly.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs2), Math.max(...xs2), Math.min(...ys2), Math.max(...ys2)];
    const hatch = [];
    for (let c = x0 - (y1 - y0) + 1.6; c < x1; c += 3.2) {
      // Line p(u) = (c + u, y1 - u), u in [0, y1 - y0].
      const hits = [];
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
        const ex = bx - ax, ey = by - ay;
        const den = ex + ey; // cross of (1,-1) with (ex,ey), negated
        if (Math.abs(den) < 1e-9) continue;
        const t = ((c - ax) * -1 + (y1 - ay) * -1) / -den;
        if (t < 0 || t >= 1) continue;
        hits.push(ax + ex * t - c);
      }
      hits.sort((p, q) => p - q);
      for (let i = 0; i + 1 < hits.length; i += 2) if (hits[i + 1] - hits[i] > 0.6) hatch.push(`M${(c + hits[i]).toFixed(2)} ${(y1 - hits[i]).toFixed(2)}L${(c + hits[i + 1]).toFixed(2)} ${(y1 - hits[i + 1]).toFixed(2)}`);
    }
    front.push(`<g class="iso-solid cfd-cut"><path class="iso-fill" d="${d}"/><path class="iso-shade" data-shade="${Math.min(shade, 3)}" d="${d}"/><path class="iso-line" data-tone="faint" d="${hatch.join("")}"/><path class="iso-line iso-edge" data-tone="hi" d="${d}"/></g>`);
  }
  // Bottom outlet: neck, flange, ball valve with lever, outlet flange.
  {
    const zTop = Zb - tw + 0.6;
    const F = G.frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
    const neck = Math.max(10, Math.min(18, zTop - 46));
    const z1 = zTop - neck;
    front.push(S(G.disc(z1, zTop, 6, F, P), { tone: "mid" }));
    front.push(S(G.disc(z1 - 3, z1, 11, F, P), { tone: "mid" }));
    front.push(D(G.dotsOf(F, z1, 8.6, 8, P, { phase: Math.PI / 8 }), { size: 0.4 }));
    front.push(S(G.disc(z1 - 6, z1 - 3, 7.5, F, P), { tone: "mid" }));
    front.push(S(G.sphereOf([0, 0, z1 - 12], 8.6, P), { tone: "mid" }));
    front.push(S(G.disc(z1 - 23, z1 - 18, 7.5, F, P), { tone: "mid" }));
    front.push(S(G.disc(z1 - 26, z1 - 23, 11, F, P), { tone: "mid" }));
    front.push(D(G.dotsOf(F, z1 - 23, 8.6, 8, P, { phase: Math.PI / 8 }), { size: 0.4 }));
    front.push(S(G.disc(z1 - 34, z1 - 26, 6, F, P), { tone: "lo" }));
    const stem = G.frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
    front.push(S(G.disc(z1 - 12, z1 - 3.2, 2, stem, P), { tone: "mid" }));
    const lever = G.frameOf([0, 0, z1 - 4.5], [0, 0, 1], dir(-30 * DEG), dir(60 * DEG));
    front.push(S(G.prismOf(lever, [[-2, -2.2], [26, -2.2], [26, 2.2], [-2, 2.2]], 0, 1.6, P), { tone: "hi", crease: "lo" }));
    front.push(D([scr([0, 0, z1 - 2.9])], { size: 0.5, tone: "hi" }));
  }
  const frontStatic = front.join("");

  // Shaft, drive and bridge go on top of the rotor's near group.
  const top = [];
  const imps = [...result.impellers].sort((p, q) => p.clearance - q.clearance);
  const shaftR = Math.max(2.2, 0.012 * T * s * 1.4);
  const zLow = Zb + imps[0].clearance * s - (imps[0].type === "anchor" ? 0 : 2);
  const beamZ = Zr + 1.6;
  const beamH = 12;
  const deck = beamZ + beamH;
  const Fz = G.frameOf([0, 0, 0], [0, 0, 1], dir(0), dir(Math.PI / 2));
  const shaft = S(G.disc(zLow, beamZ - 2, shaftR, Fz, P), { tone: "hi", crease: "none" });
  // Bridge: two beams across the rim, square to the view, on bearing pads.
  // Back beam, then the shaft and seal housing between them, then the front.
  const across = dir(-Math.PI / 2);
  const span = Rw + tw + 18;
  const beam = (side) => {
    const out = [];
    const off = side * 18;
    const Fb = G.frameOf(G.mul3(dir(0), off), across, [0, 0, 1], dir(0));
    const reach = Math.sqrt(Math.max(0, (Rw + 3) ** 2 - off * off));
    for (const end of [-1, 1]) {
      const c = G.add3(G.mul3(dir(0), off), G.mul3(across, end * reach));
      const Fp = G.frameOf([c[0], c[1], 0], [0, 0, 1], across, dir(0));
      out.push(S(G.prismOf(Fp, [[-6, -5], [6, -5], [6, 5], [-6, 5]], Zr, beamZ, P), { tone: "lo" }));
    }
    out.push(S(G.prismOf(Fb, [[beamZ, -3.5], [beamZ + beamH, -3.5], [beamZ + beamH, 3.5], [beamZ, 3.5]], -span, span, P), { tone: "mid" }));
    for (const end of [-1, 1]) {
      const c = G.add3(G.mul3(dir(0), off), G.mul3(across, end * reach));
      out.push(D([scr([c[0], c[1], beamZ + beamH])], { size: 0.45 }));
    }
    return out.join("");
  };
  top.push(beam(-1));
  top.push(S(G.disc(beamZ - 2, deck + 10, shaftR, Fz, P), { tone: "hi", crease: "none" }));
  top.push(S(G.solidOf([[beamZ - 2, 7], [beamZ + 4, 7], [beamZ + 4, 9], [deck, 9]], Fz, P), { tone: "mid" }));
  top.push(beam(1));
  // Drive: deck plate, seal housing below, gearbox, motor, fan cowl.
  top.push(S(G.prismOf(Fz, [[-26, -28], [26, -28], [26, 28], [-26, 28]], deck, deck + 3, P), { tone: "mid" }));
  top.push(D([[-22, -24], [22, -24], [22, 24], [-22, 24]].map(([x, y]) => scr(G.add3(G.add3(G.mul3(dir(0), x), G.mul3(dir(Math.PI / 2), y)), [0, 0, deck + 3]))), { size: 0.45 }));
  top.push(S(G.solidOf([[deck + 3, 17], [deck + 6, 17], [deck + 6, 14], [deck + 26, 14, 1], [deck + 32, 12.5, 1], [deck + 35, 11], [deck + 35, 13], [deck + 38, 13]], Fz, P), { tone: "mid" }));
  top.push(D(G.dotsOf(Fz, deck + 6, 15.5, 8, P, { phase: Math.PI / 8 }), { size: 0.45 }));
  top.push(L(G.arcOf(Fz, deck + 16, 14, P), { tone: "faint" }));
  const motorZ = deck + 38;
  const motorH = 52;
  top.push(S(G.disc(motorZ, motorZ + motorH, 15, Fz, P), { tone: "mid" }));
  top.push(k.fadedSvg(G.ribsOf(Fz, motorZ + 4, motorZ + motorH - 6, 15, 36, P, { fade: [0.05, 0.4] }), { tone: "lo" }));
  top.push(L(G.arcOf(Fz, motorZ + 4, 15, P) + G.arcOf(Fz, motorZ + motorH - 6, 15, P), { tone: "faint" }));
  top.push(S(G.solidOf([[motorZ + motorH, 15.6], [motorZ + motorH + 14, 15.6], [motorZ + motorH + 18, 12, 1], [motorZ + motorH + 19, 8]], Fz, P), { tone: "mid" }));
  top.push(L(G.arcOf(Fz, motorZ + motorH + 2, 15.6, P), { tone: "faint" }));
  // Terminal box on the motor side with a cable gland.
  {
    const side = dir(-Math.PI / 2);
    const Ft = G.frameOf([0, 0, 0], side, [0, 0, 1], dir(0));
    top.push(S(G.prismOf(Ft, [[motorZ + 14, -8], [motorZ + 34, -8], [motorZ + 34, 8], [motorZ + 14, 8]], 14, 24, P), { tone: "mid" }));
    const Fg = G.frameOf(G.add3(G.mul3(side, 19), [0, 0, motorZ + 14]), [0, 0, -1], dir(0), side);
    top.push(S(G.disc(0, 5, 3, Fg, P), { tone: "lo" }));
    top.push(D([[11, -6], [11, 6]].map(([u, v]) => scr(G.add3(G.add3(G.mul3(side, 24.1), G.mul3(dir(0), v)), [0, 0, motorZ + 24 + u]))), { size: 0.4 }));
  }

  // Clip region of the cut faces of the liquid, for the dim group.
  const rTop = (() => {
    let r = Rw;
    for (let i = 1; i < inner.length; i++) if (inner[i][1] > Hw) { const [r0, z0] = inner[i - 1], [r1, z1] = inner[i]; r = r0 + ((Hw - z0) / (z1 - z0 || 1)) * (r1 - r0); break; }
    return Math.min(r, Rw);
  })();
  const liquidPoly = (t) => {
    const pts = [];
    for (const [r, z] of inner) if (z <= Hw && r < rTop) pts.push(scr(at(t, r, z)));
    pts.push(scr(at(t, rTop, Hw)));
    pts.push(scr(at(t, 0, Hw)));
    return k.pathOf(pts, true);
  };
  const clip = liquidPoly(WEDGE) + liquidPoly(-WEDGE);

  // ---------- rotor ----------
  const parts = imps.map((imp) => ({ imp, z: Zb + imp.clearance * s, D: imp.diameter * s }));
  // One blade as a thin prism: a polygon in (radial, up) or a pitched plate.
  function bladeParts(entry, phase) {
    const { imp, z, D: Dw } = entry;
    const out = [];
    const nb = imp.blades;
    const W = imp.width * Dw;
    const hub = Math.max(shaftR + 2.2, 0.09 * Dw);
    for (let b = 0; b < nb; b++) {
      const t = phase + (TAU * b) / nb;
      const tt = Math.atan2(Math.sin(t), Math.cos(t));
      const er = dir(tt);
      const et = [-Math.sin(a + tt), Math.cos(a + tt), 0];
      let paths, mid;
      if (imp.type === "rushton" || imp.type === "paddle") {
        const F = G.frameOf([0, 0, 0], et, er, [0, 0, 1]);
        const r0 = imp.type === "rushton" ? 0.25 * Dw : hub;
        paths = G.prismOf(F, [[r0, z - W / 2], [Dw / 2, z - W / 2], [Dw / 2, z + W / 2], [r0, z + W / 2]], -0.7, 0.7, P);
        mid = at(tt, (r0 + Dw / 2) / 2, z);
      } else if (imp.type === "anchor") {
        const F = G.frameOf([0, 0, 0], et, er, [0, 0, 1]);
        const arm = Math.max(3, 0.06 * Dw);
        const r1 = Dw / 2;
        const zTop = z + W;
        // Vertical arm, then the bottom bar following the head in short blocks.
        const pieces = [G.prismOf(F, [[r1 - arm, zIn(r1) + 0.5 + (z - zIn(0))], [r1, zIn(r1) + 0.5 + (z - zIn(0))], [r1, zTop], [r1 - arm, zTop]], -1.4, 1.4, P)];
        const segs = 6;
        for (let q = 0; q < segs; q++) {
          const ra = (r1 * q) / segs, rb = (r1 * (q + 1)) / segs;
          const za = zIn(ra) + (z - zIn(0)), zb2 = zIn(rb) + (z - zIn(0));
          pieces.push(G.prismOf(F, [[ra, za], [rb, zb2], [rb, zb2 + arm], [ra, za + arm]], -1.4, 1.4, P));
        }
        out.push({ t: tt, depth: depth(at(tt, r1 * 0.6, z + W / 2)), svg: pieces.map((p) => S(p, { tone: "hi", lit: true })).join("") });
        continue;
      } else {
        // Pitched plates: chord tilted by the pitch about the radial line.
        const pitch = (imp.type === "pbt" ? imp.pitch : imp.type === "hydrofoil" ? 28 : 32) * DEG;
        const sign = imp.pumping === "up" ? -1 : 1;
        const chord = G.unit3(G.add3(G.mul3(et, Math.cos(pitch)), [0, 0, sign * Math.sin(pitch)]));
        const normal = G.unit3(G.cross3(er, chord));
        const F = G.frameOf([0, 0, z], normal, er, chord);
        let poly;
        if (imp.type === "pbt") poly = [[hub, -W / 2], [Dw / 2, -W / 2], [Dw / 2, W / 2], [hub, W / 2]];
        else if (imp.type === "hydrofoil") poly = [[hub, -W * 0.7], [Dw * 0.46, -W * 0.42], [Dw / 2, -W * 0.18], [Dw / 2, W * 0.2], [hub, W * 0.55]];
        else {
          poly = [];
          for (let q = 0; q <= 10; q++) {
            const ang = Math.PI * (q / 10);
            poly.push([hub + (Dw / 2 - hub) * (0.5 + 0.5 * -Math.cos(ang)), W * 0.75 * Math.sin(ang) * (0.6 + 0.4 * (q / 10))]);
          }
          poly.push([hub, -W * 0.15]);
        }
        paths = G.prismOf(F, poly, -0.6, 0.6, P);
        mid = at(tt, (hub + Dw / 2) / 2, z);
      }
      out.push({ t: tt, depth: depth(mid), svg: S(paths, { tone: "hi", lit: true }) });
    }
    return out;
  }
  function hubParts(entry, phase) {
    const { imp, z, D: Dw } = entry;
    const out = { dimDisc: "", nearDisc: "", hub: "" };
    const hubR = Math.max(shaftR + 2.2, 0.09 * Dw);
    const hubH = imp.type === "anchor" ? 6 : Math.max(5, Math.min(imp.width * Dw * 0.9, 14));
    if (imp.type === "rushton") {
      const discR = 0.375 * Dw;
      const ring = [[0, z - 0.6], [discR, z - 0.6], [discR, z + 0.6], [0, z + 0.6]];
      out.dimDisc = S(revolve(ring.map(([r, zz]) => [r, zz]), WEDGE, TAU - WEDGE, P), { tone: "hi", lit: true });
      out.nearDisc = S(revolve(ring, -WEDGE, WEDGE, P), { tone: "hi", lit: true });
    }
    const Fh = G.frameOf([0, 0, 0], [0, 0, 1], dir(phase), dir(phase + Math.PI / 2));
    out.hub = S(G.disc(z - hubH / 2, z + hubH / 2, hubR, Fh, P), { tone: "hi", lit: true }) + D(G.dotsOf(Fh, z + hubH / 2, (hubR + shaftR) / 2, 4, P, { phase, all: true }), { size: 0.45, tone: "lo" });
    return out;
  }
  const fade = (t) => {
    const x = (Math.abs(t) - (WEDGE - 7 * DEG)) / (14 * DEG);
    const c = Math.min(1, Math.max(0, x));
    return c * c * (3 - 2 * c);
  };
  function rotor(angle) {
    const dim = [];
    const near = [];
    for (const entry of parts) {
      const phase = angle;
      const blades = bladeParts(entry, phase).sort((p, q) => p.depth - q.depth);
      const hubs = hubParts(entry, phase);
      dim.push(hubs.dimDisc);
      for (const blade of blades) {
        const f = fade(blade.t); // 1 behind the cut faces, 0 in the wedge
        if (f > 0.01) dim.push(f < 0.99 ? `<g opacity="${f.toFixed(2)}">${blade.svg}</g>` : blade.svg);
      }
      const behind = blades.filter((b) => fade(b.t) < 0.99);
      near.push(hubs.nearDisc);
      const backHalf = behind.filter((b) => Math.cos(b.t) < 0.35);
      const frontHalf = behind.filter((b) => Math.cos(b.t) >= 0.35);
      for (const blade of backHalf) near.push(`<g opacity="${(1 - fade(blade.t)).toFixed(2)}">${blade.svg}</g>`);
      near.push(hubs.hub);
      for (const blade of frontHalf) near.push(`<g opacity="${(1 - fade(blade.t)).toFixed(2)}">${blade.svg}</g>`);
    }
    return { dim: dim.join(""), near: near.join("") };
  }

  // Baffles below the liquid, seen through the cut faces.
  const dimStatic = [...baffles]
    .sort((p, q) => depth(at(p, Rw, 0)) - depth(at(q, Rw, 0)))
    .map((t) => baffle(t, bottomOf(t), Math.min(Hw, Zr - 2), { tone: "mid" }))
    .join("");

  return {
    width, height, P, lay, a, baffles, bw, gap,
    back: back.join(""),
    frontStatic,
    dimStatic,
    top: top.join(""),
    clip,
    rotor,
    shaftR,
    shaft,
    rTop,
    label: `An agitated vessel on four legs, ${T} m across, with a 90 degree wedge cut away toward the viewer. The two cut faces of the liquid show the computed flow; the impellers turn on a shaft from a motor on a bridge across the rim.`,
  };
}

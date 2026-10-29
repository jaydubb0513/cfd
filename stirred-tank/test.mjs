// Sanity checks for the model and the solver: node stirred-tank/test.mjs
// Runs each case for a few seconds of flow and checks the physics that the
// page relies on. Exits non-zero on any failure.

import { normalize, analyse, headOf, liquidVolume } from "./model.mjs";
import { createSolver } from "./solver.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
  if (!ok) failed++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);

// Geometry: the F&D head is 0.169 D deep, a flat tank holds pi R^2 H.
check("torispherical depth 0.169 D", near(headOf({ diameter: 1, head: "torispherical" }).depth, 0.169, 0.01));
check("flat volume", near(liquidVolume({ diameter: 1, liquidHeight: 1, head: "flat" }), Math.PI / 4, 0.002));
check("hemispherical depth R", near(headOf({ diameter: 2, head: "hemispherical" }).depth, 1, 1e-9));

// Correlations: a standard Rushton in a fully baffled tank has Np = 5.
const standard = analyse(normalize({}));
check("Rushton Np = 5 (turbulent, baffled)", near(standard.NpSum, 5, 0.02), standard.NpSum.toFixed(3));
check("laminar Np = Kp/Re", near(analyse(normalize({ speed: 10, fluid: { model: "newtonian", viscosity: 50, density: 1000 } })).main.Np * analyse(normalize({ speed: 10, fluid: { model: "newtonian", viscosity: 50, density: 1000 } })).Re, 70, 0.1));
const unbaffledNp = analyse(normalize({ vessel: { baffles: 0 } })).NpSum;
check("unbaffled Np lower", unbaffledNp < 0.4 * standard.NpSum, unbaffledNp.toFixed(2));

function run(input, seconds = 12) {
  const config = normalize(input);
  const result = analyse(config);
  const solver = createSolver(config, result);
  while (solver.time < seconds) solver.step();
  return { config, result, solver };
}
const meanAbs = (solver, kind) => {
  const field = solver.fieldOf(kind, new Float32Array(solver.NR * solver.NZ));
  let sum = 0, n = 0;
  for (const v of field) if (!Number.isNaN(v)) { sum += Math.abs(v); n++; }
  return sum / n;
};

const rushton = run({});
check("no NaN in the flow", [...rushton.solver.u, ...rushton.solver.w, ...rushton.solver.v].every(Number.isFinite));
const q = rushton.solver.pumping(rushton.result.impellers[0]);
check("Rushton pumping matches Nq N D^3", near(q, rushton.result.impellers[0].Q, 0.15), `${(q * 1000).toFixed(1)} vs ${(rushton.result.impellers[0].Q * 1000).toFixed(1)} L/s`);
check("divergence small", rushton.solver.residual() < 0.3, rushton.solver.residual().toExponential(2));

// Rushton: radial jet out at impeller height, so u > 0 just beyond the tip.
{
  const { solver, result } = rushton;
  const imp = result.impellers[0];
  const u = solver.sampleU(imp.diameter * 0.7, imp.clearance);
  check("Rushton jet is radial outward", u > 0.2 * result.tip, `${u.toFixed(2)} m/s`);
}
// Down-pumping PBT: w < 0 under the impeller.
{
  const { solver, result } = run({ impellers: [{ type: "pbt", diameter: 0.4, clearance: 0.4 }] });
  const imp = result.impellers[0];
  const w = solver.sampleW(imp.diameter * 0.3, imp.clearance - 0.1);
  check("PBT pumps down", w < -0.1, `${w.toFixed(2)} m/s`);
}
// Baffles kill swirl.
{
  const unbaffled = run({ vessel: { baffles: 0 } });
  const a = meanAbs(rushton.solver, "swirl");
  const b = meanAbs(unbaffled.solver, "swirl");
  check("unbaffled swirl > 2x baffled", b > 2 * a, `${b.toFixed(3)} vs ${a.toFixed(3)} m/s`);
  check("unbaffled surface vortex deeper", unbaffled.solver.vortexDepth() > 5 * rushton.solver.vortexDepth(), `${(unbaffled.solver.vortexDepth() * 100).toFixed(1)} cm`);
}
// Yield stress: the far field stays far more viscous than near the impeller.
{
  const { solver } = run({ fluid: { model: "herschel", density: 1000, tauY: 8, K: 1.8, n: 0.45 } }, 8);
  const mu = solver.fieldOf("viscosity", new Float32Array(solver.NR * solver.NZ));
  const nearImp = mu[Math.round(0.25 * solver.NR) + Math.round((0.4 / solver.H) * solver.NZ) * solver.NR];
  const corner = mu[(solver.NR - 2) + (solver.NZ - 2) * solver.NR];
  check("yield-stress cavern: viscosity far > near", corner > nearImp + 1, `log10 mu ${corner.toFixed(2)} vs ${nearImp.toFixed(2)}`);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

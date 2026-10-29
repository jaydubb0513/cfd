// 256-entry colour tables for the flow field: Turbo and Viridis (polynomial
// fits of the published maps), a cool-warm diverging map for signed
// velocities, and "ink", one hue that follows the page theme.

const clamp = (x) => Math.max(0, Math.min(1, x));
const poly = (c, t) => c.reduceRight((acc, a) => acc * t + a, 0);

const TURBO = [
  [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943],
  [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604],
  [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973],
];
const VIRIDIS = [
  [0.2777273272234177, 0.1050930431085774, -0.3308618287255563, -4.634230498983486, 6.228269936347081, 4.776384997670288, -5.435455855934631],
  [0.005407344544966578, 1.404613529898575, 0.214847559468213, -5.799100973351585, 14.17993336680509, -13.74514537774601, 4.645852612178535],
  [0.3340998053353061, 1.384590162594685, 0.09509516302823659, -19.33244095627987, 56.69055260068105, -65.35303263337234, 26.3124352495832],
];

const cache = new Map();
export function colormap(name, theme = "dark") {
  const key = `${name}:${theme}`;
  if (cache.has(key)) return cache.get(key);
  const table = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let rgb;
    if (name === "viridis") rgb = VIRIDIS.map((c) => poly(c, t));
    else if (name === "coolwarm") {
      // Blue through a neutral middle to red, the middle matched to the page.
      const mid = theme === "light" ? [0.93, 0.93, 0.92] : [0.2, 0.2, 0.21];
      const cold = [0.23, 0.42, 0.95];
      const warm = [0.95, 0.3, 0.22];
      const u = Math.abs(t - 0.5) * 2;
      const e = Math.pow(u, 0.8);
      const end = t < 0.5 ? cold : warm;
      rgb = mid.map((m, q) => m + (end[q] - m) * e);
    } else if (name === "ink") {
      const g = theme === "light" ? 0.95 - 0.85 * t : 0.1 + 0.88 * Math.pow(t, 0.9);
      rgb = [g, g, g * 1.02];
    } else rgb = TURBO.map((c) => poly(c, t));
    table.push(rgb.map((x) => Math.round(clamp(x) * 255)));
  }
  cache.set(key, table);
  return table;
}

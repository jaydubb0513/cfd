// Generates a standalone HTML page for one stirred-tank configuration.
//
//   node stirred-tank/build.mjs                                  # defaults
//   node stirred-tank/build.mjs --config configs/dual-pbt.json   # from a file
//   node stirred-tank/build.mjs --config x.json --out out.html --light
//
// The page carries the config as JSON, the solver and the drawing kit inline,
// and needs nothing else: open it in a browser, change any input, and use
// "HTML 저장" to write a new standalone page with the edited inputs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ISO_CSS } from "../.claude/skills/anatomy/kit/iso-kit.mjs";
import { normalize, analyse, format } from "./model.mjs";
import { bundle } from "./bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const configPath = option("--config");
const raw = configPath ? JSON.parse(readFileSync(resolve(configPath), "utf8")) : {};
if (args.includes("--light")) raw.view = { ...(raw.view || {}), theme: "light" };
if (args.includes("--dark")) raw.view = { ...(raw.view || {}), theme: "dark" };
const config = normalize(raw);
const name = configPath ? basename(configPath).replace(/\.json$/, "") : "stirred-tank";
const out = resolve(option("--out") || join(HERE, "out", `${name}${config.view.theme === "light" ? "-light" : ""}.html`));

const CSS = readFileSync(join(HERE, "app.css"), "utf8");
const script = bundle(join(HERE, "app.mjs"));
const result = analyse(config);
const title = `Stirred tank CFD · ${config.impellers.map((imp) => imp.type).join(" + ")} · ${config.speed} rpm`;

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="T ${config.vessel.diameter} m, ${config.speed} rpm, Re ${format.num(result.Re)}, P ${format.si(result.power, "W")}">
<style>${ISO_CSS}${CSS}</style>
</head>
<body class="iso" data-theme="${config.view.theme === "light" ? "light" : "dark"}">
<main class="cfd-app" id="cfd-root"><noscript>이 페이지는 JavaScript로 유동을 계산합니다.</noscript></main>
<script type="application/json" id="cfd-config">${JSON.stringify(config, null, 2).replace(/</g, "\\u003c")}</script>
<script type="module">${script.replace(/<\/(script)/gi, "<\\/$1")}</script>
</body>
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} kB) · Re ${format.num(result.Re)} · Np ${format.num(result.NpSum)} · P ${format.si(result.power, "W")}`);

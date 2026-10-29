// A tiny bundler for the page: follows relative `import` statements from an
// entry module and wraps each module in its own scope, so names that two
// modules both declare (the kit and lathe share a few helpers) never clash.
// Handles the forms this project uses: `import { a, b } from "./x.mjs"`,
// `import * as x from "./x.mjs"` and `export function|const|let|class`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function bundle(entry) {
  const order = [];
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return seen.get(file);
    const name = `__m${seen.size}`;
    seen.set(file, name);
    const source = readFileSync(file, "utf8");
    const imports = [];
    const body = source.replace(/^import\s+(\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+"([^"]+)";?\s*$/gm, (_, __, star, names, from) => {
      const target = visit(resolve(dirname(file), from));
      imports.push(star ? `const ${star} = ${target};` : `const {${names.replace(/\s+as\s+/g, ": ")}} = ${target};`);
      return "";
    });
    const exports = [...body.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const code = body.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, "");
    order.push(`const ${name} = (() => {\n${imports.join("\n")}\n${code}\nreturn { ${exports.join(", ")} };\n})();`);
    return name;
  };
  visit(resolve(entry));
  return order.join("\n");
}

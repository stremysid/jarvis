import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith(".") ) && specifier.endsWith(".js") && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    const ts = fileURLToPath(url).replace(/\.js$/, ".ts");
    if (existsSync(ts)) return next(specifier.replace(/\.js$/, ".ts"), context);
  }
  if (specifier.endsWith("?raw")) {
    return { url: new URL(specifier.replace(/\?raw$/, ""), context.parentURL).href + "?raw", shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.endsWith("?raw")) {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(fileURLToPath(url.replace(/\?raw$/, "")), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, context);
}

// Maps "./x.js" imports to "./x.ts" when only the .ts file exists, so the archived
// PR tree can run under node --experimental-transform-types without a build step.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith(".") || specifier.startsWith("/")) && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
}

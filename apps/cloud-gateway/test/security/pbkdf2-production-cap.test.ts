import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { readonly eager: true; readonly import: "default"; readonly query: "?raw" },
    ): Record<string, string>;
  }
}

const sourceModules = import.meta.glob(
  "../../src/**/*.ts",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("production PBKDF2 limits", () => {
  it("keeps every PBKDF2 deriveBits call at or below the production 100000-iteration cap", () => {
    const calls: Array<{ readonly path: string; readonly iterations: number }> = [];
    for (const [path, source] of Object.entries(sourceModules)) {
      for (const match of source.matchAll(/\.deriveBits\s*\(\s*(\{[\s\S]*?\})\s*,/gu)) {
        const algorithm = match[1] ?? "";
        if (!/\bname\s*:\s*["']PBKDF2["']/u.test(algorithm)) continue;
        const literal = /\biterations\s*:\s*([0-9][0-9_]*)\b/u.exec(algorithm)?.[1];
        expect(literal, `${path} must pin PBKDF2 iterations as a numeric literal`).toBeDefined();
        calls.push({ path, iterations: Number(literal?.replaceAll("_", "")) });
      }
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ iterations }) => iterations > 100_000)).toEqual([]);
  });
});

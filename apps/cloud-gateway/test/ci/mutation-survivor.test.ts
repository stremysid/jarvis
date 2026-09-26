import { expect, it } from "vitest";
import { labeled } from "./mutation-survivor-source.js";

// Deliberately covers one branch only, so the planted mutation in
// `untestedTail` survives and the self-test can prove the failure path.
it("labels a positive number", () => {
  expect(labeled(1)).toBe("positive");
});

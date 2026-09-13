import type { OutboundControlSource } from "../../src/policy/outbound-controls.js";

/** Explicit policy input for foundation-only component tests, never a production fallback. */
export const permittedOutboundControls: OutboundControlSource = Object.freeze({
  async readControls() { return Object.freeze({ enabled: true, quietStartsAt: null, quietEndsAt: null }); },
});

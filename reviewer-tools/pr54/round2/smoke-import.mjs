const m = await import("./voice-smoke.ts");
console.log("exports:", Object.keys(m).join(", "));
console.log("scenarios:", m.VOICE_SMOKE_SCENARIOS);

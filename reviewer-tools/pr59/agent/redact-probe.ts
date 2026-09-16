import { sanitizeRedaction } from "./calls.ts";
const inputs = [
  "my pin is 12345678",
  "Authorization: Bearer abcdefghijklmnop1234",
  "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
  "my code is 123456 and password: hunter2hunter2",
  "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  "verification code 4821 for school portal",
];
for (const t of inputs) {
  const a = sanitizeRedaction(t);
  if (!a.ok) { console.log("first failed", JSON.stringify(t)); continue; }
  const b = sanitizeRedaction(a.text);
  console.log(b.ok && b.text === a.text ? "idempotent" : "NOT idempotent", JSON.stringify(a.text), b.ok ? JSON.stringify(b.text) : "fail");
}

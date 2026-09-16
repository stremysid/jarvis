import { Redactor } from "./head/apps/cloud-gateway/src/security/redaction.ts";
const r = new Redactor();
for (const t of ["Ask Ms. Lee at lee@school.example or 416-555-0199.", "Ms Lee reference request lee@tdsb.on.ca", "Pay the OUAC fee of 156 bucks."]) console.log(JSON.stringify(r.redactText(t)));

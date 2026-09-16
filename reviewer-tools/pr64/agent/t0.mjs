const m = await import("./head/apps/cloud-gateway/src/university/university-tracker-model.ts");
console.log(Object.keys(m));
const s = await import("./head/apps/cloud-gateway/src/school/school-catchup-model.ts");
console.log(Object.keys(s));
const d = await import("./head/apps/cloud-gateway/src/digest/digest-composer.ts");
console.log(Object.keys(d));

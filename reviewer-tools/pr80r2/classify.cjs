const fs=require("fs");const dir="apps/cloud-gateway/src/persistence/migrations/";
const src=fs.readFileSync("apps/cloud-gateway/src/backup/memory-backup.ts","utf8");
const grab=(n)=>{const i=src.indexOf(n+" = Object.freeze([");const j=src.indexOf("]",i);return [...src.slice(i,j).matchAll(/"([a-z0-9_]+)"/g)].map(x=>x[1]);};
const B=grab("MEMORY_BACKUP_TABLES"),E=grab("MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES");
const created=new Map(),dropped=[],renamed=[];
for(const f of fs.readdirSync(dir).sort()){const s=fs.readFileSync(dir+f,"utf8").replace(/--.*$/gm,"");
for(const m of s.matchAll(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi))created.set(m[3],f);
for(const m of s.matchAll(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi))dropped.push(m[2]+"@"+f);
for(const m of s.matchAll(/ALTER\s+TABLE\s+"?([a-z0-9_]+)"?\s+RENAME\s+TO\s+"?([a-z0-9_]+)"?/gi))renamed.push(m[1]+"->"+m[2]+"@"+f);}
console.log("created",created.size,"backup",B.length,"excluded",E.length,"dupB",B.length-new Set(B).size);
console.log("dropped",dropped.join(" "));console.log("renamed",renamed.join(" "));
const cls=new Set([...B,...E]);
console.log("unclassified",[...created.keys()].filter(t=>!cls.has(t)));
console.log("classified-not-created",[...cls].filter(t=>!created.has(t)));
console.log("both",B.filter(t=>E.includes(t)));

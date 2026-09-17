const fs=require("fs");const dir="apps/cloud-gateway/src/persistence/migrations/";
const trig=new Map();
for(const f of fs.readdirSync(dir).sort()){const s=fs.readFileSync(dir+f,"utf8");
 for(const m of s.matchAll(/CREATE\s+TRIGGER\s+(IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)(\s+OF\s+[a-z0-9_, ]+)?\s+ON\s+"?([a-z0-9_]+)"?([\s\S]*?)\bEND;/gi)){
   trig.set(m[2],{file:f,when:m[3],op:m[4].toUpperCase(),table:m[6],body:m[7]});}
 for(const m of s.matchAll(/DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)){ if(trig.has(m[2]) && trig.get(m[2]).file!==f) trig.delete(m[2]); }
}
const mode=process.argv[2];
const ins=[...trig.entries()].filter(([n,t])=>t.op==="INSERT");
console.log("triggers total",trig.size,"insert",ins.length);
if(mode==="list"){for(const [n,t] of ins){const b=t.body.replace(/\s+/g," ");console.log(`${t.table} | ${n} | ${t.when} | ${t.file} | ${b.slice(0,400)}`);}}

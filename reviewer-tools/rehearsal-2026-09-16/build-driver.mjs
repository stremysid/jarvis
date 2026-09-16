// Build a non-interactive PowerShell driver that runs docs/runbooks/migration-scratch-proof.md exactly as written.
// Usage: node build-driver.mjs <repo-checkout> <scratch-name> <out.ps1>
// Only deviations from the runbook text: Read-Host is answered automatically (name, or the step-2 config path),
// `cd C:\path\to\jarvis` becomes the checkout, and the final `wrangler d1 delete` gets -y (no TTY to confirm).
import fs from "node:fs";
const [repo, name, out] = process.argv.slice(2);
if (!/scratch/.test(name)) throw new Error("scratch name must contain 'scratch'");
const md = fs.readFileSync(`${repo}/docs/runbooks/migration-scratch-proof.md`, "utf8").replace(/\r\n/g, "\n");
const blocks = [...md.matchAll(/^   ```powershell\n([\s\S]*?)^   ```$/gm)].map((m) => m[1].split("\n").map((l) => l.replace(/^   /, "")).join("\n"));
const repoWin = repo.replace(/\//g, "\\");
let ps = `$global:RehearsalName = '${name}'\n$global:RehearsalConfig = $null\nfunction Read-Host { param([string]$Prompt) Write-Host "PROMPT: $Prompt"; if ($Prompt -like '*SCRATCH CONFIG OUTSIDE REPO*') { return $global:RehearsalConfig }; return $global:RehearsalName }\n`;
blocks.forEach((b, i) => {
  let body = b.split(String.raw`cd C:\path\to\jarvis`).join(`Set-Location ${repoWin}`);
  body = body.replace(/(d1 delete \$ScratchDatabase[^\n]*)/, (m) => (m.includes(" -y") ? m : `${m} -y`));
  ps += `\nWrite-Host "===== RUNBOOK STEP ${i + 2} ====="\n$ErrorActionPreference = 'Stop'\n& {\n${body}\nif ($ScratchConfig) { $global:RehearsalConfig = $ScratchConfig }\n}\n`;
});
fs.writeFileSync(out, ps);
console.log(`driver: ${blocks.length} runbook blocks -> ${out}`);

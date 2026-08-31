import { readFile, writeFile } from "node:fs/promises";
import { canonicalize, sha256Hex } from "./canonical-json.mjs";

const read = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
const output = new URL("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", import.meta.url);
const source = await read("hermes-source-lock.json");
const existing = await read("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
const canonical = `${new TextDecoder().decode(canonicalize(existing))}\n`;
const hash = await sha256Hex(canonicalize(existing));
if (process.argv.includes("--check")) {
  if (hash !== source.sbomSha256) throw new Error("SBOM hash drift");
} else {
  await writeFile(output, canonical, { encoding: "utf8", flag: "w" });
}
console.log(hash);

// Locks the script library for the app.
// Usage: node tools/encrypt-scripts.mjs <scripts.json> [setup-code-file]
// <scripts.json> is a plain list: [{ "id", "title", "body" }], sections separated by blank lines.
// The setup code (default: setup-code.txt) comes from the app's Settings screen.
// Writes scripts.enc.json, which only Sal's phone can open.

import { readFile, writeFile } from "node:fs/promises";
import { sealForSetupCode } from "../js/crypto.js";

const [, , plainPath, codePath = "setup-code.txt"] = process.argv;
if (!plainPath) {
  console.error("Usage: node tools/encrypt-scripts.mjs <scripts.json> [setup-code-file]");
  process.exit(1);
}

const scripts = JSON.parse(await readFile(plainPath, "utf8"));
if (!Array.isArray(scripts)) throw new Error("scripts.json must be a list");
for (const s of scripts) {
  if (!s.id || !s.title || typeof s.body !== "string") throw new Error("Each script needs id, title and body: " + JSON.stringify(s).slice(0, 80));
}
const code = (await readFile(codePath, "utf8")).trim();
const file = await sealForSetupCode(code, { updated: new Date().toISOString(), scripts });
await writeFile(new URL("../scripts.enc.json", import.meta.url), JSON.stringify(file) + "\n");
console.log(`Locked ${scripts.length} script(s) into scripts.enc.json`);

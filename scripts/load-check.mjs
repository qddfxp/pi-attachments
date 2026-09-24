/**
 * Loads the extension through pi's own loader (`discoverAndLoadExtensions`) to
 * prove that pi can discover it, evaluate the factory, and register the handlers
 * and commands — the same code path `pi -e` uses.
 *
 * Run: node scripts/load-check.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionsDir = join(packageRoot, "extensions");

const result = await discoverAndLoadExtensions([extensionsDir], packageRoot);

if (result.errors.length > 0) {
  console.error("load errors:");
  for (const entry of result.errors) console.error(`  ${entry.path}: ${entry.error}`);
  process.exit(1);
}

// The loader also scans the standard locations, so pick our own extension by path.
const discovered = result.extensions.map((extension) => extension.resolvedPath ?? extension.path);
const extension = result.extensions.find((entry) => /pi-attachments/.test(entry.path));
if (!extension) {
  console.error(`the loader discovered no pi-attachments extension in ${extensionsDir}`);
  console.error("discovered: " + (discovered.join(", ") || "(none)"));
  process.exit(1);
}

const handlers = [...extension.handlers.keys()].sort();
const commands = [...extension.commands.keys()].sort();
console.log(`path:      ${extension.path}`);
console.log(`handlers:  ${handlers.join(", ")}`);
console.log(`commands:  ${commands.join(", ")}`);
console.log(`tools:     ${[...extension.tools.keys()].join(", ") || "(none)"}`);

const expected = {
  handlers: ["input", "session_start"],
  commands: ["attach", "attachments"],
};
const failures = [];
for (const handler of expected.handlers) {
  if (!handlers.includes(handler)) failures.push(`missing handler: ${handler}`);
}
for (const command of expected.commands) {
  if (!commands.includes(command)) failures.push(`missing command: ${command}`);
}
if (extension.tools.size > 0) failures.push("the extension must not register tools");

if (failures.length > 0) {
  console.error("FAILED: " + failures.join("; "));
  process.exit(1);
}
console.log("OK: pi loaded the extension and registered everything it should");

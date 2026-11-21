/**
 * Prints the storage layout of every struct in the project, so the packing
 * claims in docs/GAS-EVALUATION.md can be verified rather than taken on trust.
 * Run: npx hardhat run scripts/storage-layout.js
 */
const fs = require("fs");
const path = require("path");

const dir = path.join("artifacts", "build-info");
const found = {};

for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const bi = JSON.parse(fs.readFileSync(path.join(dir, f)));
  for (const src of Object.keys(bi.output.contracts || {})) {
    for (const name of Object.keys(bi.output.contracts[src])) {
      const sl = bi.output.contracts[src][name].storageLayout;
      if (!sl || !sl.types) continue;
      for (const [k, t] of Object.entries(sl.types)) {
        if (k.includes("struct") && t.members) {
          found[`${name}.${k.replace(/^t_struct\(/, "").replace(/\)\d+_storage$/, "")}`] = t;
        }
      }
    }
  }
}

const lines = [];
for (const [key, t] of Object.entries(found).sort()) {
  const slots = new Set(t.members.map((m) => m.slot)).size;
  lines.push(`\n${key}  —  ${t.numberOfBytes} bytes, ${slots} slot(s)`);
  for (const m of t.members) {
    lines.push(
      `    slot ${String(m.slot).padStart(2)}  offset ${String(m.offset).padStart(2)}  ` +
      `${m.label.padEnd(14)}${m.type.replace(/^t_/, "")}`
    );
  }
}
console.log(lines.join("\n"));

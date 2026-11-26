// Checks that the booster's patches still fit the game's current AI worker.
//   node tools/check-anchors.cjs <worker.js>
// Required patches (patches.js) must apply at every level; speed patches
// that no longer fit are listed (the booster then just skips them).
"use strict";
const fs = require("fs");
const path = require("path");
const { LEVELS, patchWorker } = require(path.join(__dirname, "..", "patches.js"));

const src = fs.readFileSync(process.argv[2], "utf8");
let failed = false;
for (const level of Object.keys(LEVELS)) {
  const r = patchWorker(src, level);
  if (!r.ok) { failed = true; console.log(`level ${level}: FAILED - ${r.error}`); continue; }
  console.log(`level ${level}: ok; speed patches applied ${r.speedApplied.length}${r.speedSkipped.length ? `, skipped: ${r.speedSkipped.join(", ")}` : ""}`);
}
process.exitCode = failed ? 1 : 0;

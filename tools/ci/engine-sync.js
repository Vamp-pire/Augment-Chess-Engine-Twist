// extension/engine.js must equal engine-merged.js + the AugmentEngine line (see PROJECT.md).
const fs = require("fs");
const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
const a = norm(fs.readFileSync(__dirname + "/../../engine-merged.js", "utf8"));
const b = norm(fs.readFileSync(__dirname + "/../../extension/engine.js", "utf8"));
const want = a + "\nglobalThis.AugmentEngine = globalThis.__engineMerged;\n";
if (a && b !== want) { console.error("extension/engine.js is out of sync with engine-merged.js -- re-sync (PROJECT.md)"); process.exit(1); }
console.log("engine-sync ok");

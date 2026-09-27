#!/usr/bin/env node
// Downloads the live https://augmentchess.org/assets/aiWorker.js and writes an exported copy
// to .cache/real-worker.js (exports generateActions/applyAction/cloneState/setWorkerBoardDimensions/
// searchBestAction/evaluateState). Only the public worker asset is fetched, through net-guard.js
// (identifying User-Agent, hard cap of 5 requests per run, no retries).
// Usage: node fetch-real-worker.js [--force]   (skips download if cache exists unless --force)
// update-site.js reuses exportWorker/writeWorkerFiles from here.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { getDefaultNet } = require("./net-guard");
const CACHE = path.join(__dirname, ".cache");
const RAW = path.join(CACHE, "aiWorker.raw.js"), OUT = path.join(CACHE, "real-worker.js");
const WORKER_URL = "https://augmentchess.org/assets/aiWorker.js";
function exportWorker(src) { // raw worker source -> source with the exports appended
  const i = src.lastIndexOf("})();");
  if (i < 0) throw new Error("worker IIFE terminator not found; site format changed");
  const exp = "globalThis.__aiWorkerReal = { searchBestAction, generateActions, applyAction, evaluateState, cloneState, setWorkerBoardDimensions };\n  if (typeof module !== \"undefined\") module.exports = globalThis.__aiWorkerReal;\n";
  return src.slice(0, i) + exp + src.slice(i);
}
function writeWorkerFiles(src, { raw = RAW, out = OUT } = {}) {
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  fs.writeFileSync(raw, src); // raw first, like before: kept for inspection even when the export step fails
  fs.writeFileSync(out, exportWorker(src));
  return out;
}
async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (!process.argv.includes("--force") && fs.existsSync(OUT)) { console.log("cached:", OUT); return; }
  const src = new TextDecoder("utf-8").decode(await getDefaultNet().get(WORKER_URL)); // same decoding as Response.text()
  writeWorkerFiles(src);
  console.log("wrote", OUT, src.length, "bytes sha256", crypto.createHash("sha256").update(src).digest("hex"));
}
if (require.main === module) main().catch((e) => { console.error("fetch failed:", e.message); process.exit(1); });
module.exports = { WORKER_URL, RAW, OUT, exportWorker, writeWorkerFiles };

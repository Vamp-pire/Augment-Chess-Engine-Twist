#!/usr/bin/env node
// Detects a new deployment of https://augmentchess.org/ by comparing the main bundle asset name and the
// aiWorker.js SHA-256 with last-seen.json. Fetches only public assets (index.html, main-*.js, aiWorker.js).
// All requests go through net-guard.js (identifying User-Agent, hard cap of 5 requests per run, no retries).
// Exit code: 0 = CHANGED or UNCHANGED, 2 = network error.
// Usage: node check-site-update.js [--save]   (--save rewrites last-seen.json with the fresh values)
// update-site.js reuses parseIndex/buildFresh/loadSeen/saveSeen from here.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { getDefaultNet } = require("./net-guard");
const SITE = "https://augmentchess.org";
const SEEN = path.join(__dirname, "last-seen.json");

function parseIndex(htmlBuf) { // -> main bundle file name, e.g. "main-BrJfQMgo.js"
  const m = htmlBuf.toString("utf8").match(/\/assets\/(main-[A-Za-z0-9_-]+\.js)/);
  if (!m) throw new Error("main bundle not found in index.html");
  return m[1];
}
function buildFresh({ mainBundle, worker, main, now = new Date() }) { // worker/main: Buffers
  const v = main.toString("utf8").match(/UPDATE_LOG_VERSION\s*=\s*"([^"]+)"/);
  return { mainBundle, mainBundleBytes: main.length, aiWorkerSha256: crypto.createHash("sha256").update(worker).digest("hex"), aiWorkerBytes: worker.length, updateLogVersion: v ? v[1] : null, checkedAt: now.toISOString() };
}
function loadSeen(file = SEEN) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function saveSeen(fresh, file = SEEN) { fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + "\n"); }
function isChanged(old, fresh) { return !old || old.mainBundle !== fresh.mainBundle || old.aiWorkerSha256 !== fresh.aiWorkerSha256; }

async function fetchFresh(net) { // index.html -> aiWorker.js -> main bundle: exactly 3 requests
  const mainBundle = parseIndex(await net.get(SITE + "/"));
  const worker = await net.get(SITE + "/assets/aiWorker.js");
  const main = await net.get(SITE + "/assets/" + mainBundle);
  return buildFresh({ mainBundle, worker, main });
}

async function cli() {
  let fresh;
  try { fresh = await fetchFresh(getDefaultNet()); }
  catch (e) { console.error("NETWORK/PARSE ERROR:", e.message); process.exit(2); }
  const old = loadSeen();
  const changed = isChanged(old, fresh);
  if (!changed) { console.log("UNCHANGED", fresh.mainBundle, "worker", fresh.aiWorkerSha256.slice(0, 12), "log", fresh.updateLogVersion); }
  else {
    console.log("CHANGED" + (old ? "" : " (no previous last-seen.json)"));
    console.log("  main bundle :", old?.mainBundle, "->", fresh.mainBundle, `(${fresh.mainBundleBytes} bytes)`);
    console.log("  aiWorker    :", old?.aiWorkerSha256?.slice(0, 12), "->", fresh.aiWorkerSha256.slice(0, 12), `(${fresh.aiWorkerBytes} bytes)`);
    console.log("  update log  :", old?.updateLogVersion, "->", fresh.updateLogVersion);
    console.log("  next: node fetch-real-worker.js --force && run parity tests; then node check-site-update.js --save");
  }
  if (!old || process.argv.includes("--save")) { saveSeen(fresh); console.log("saved", SEEN); }
}
if (require.main === module) cli();
module.exports = { SITE, SEEN, parseIndex, buildFresh, loadSeen, saveSeen, isChanged, fetchFresh };

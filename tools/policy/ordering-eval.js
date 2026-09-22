#!/usr/bin/env node
// How good is the CURRENT hand-written move ordering (orderActions) at putting the move the
// search finally chose near the front?  Reads self-play data recorded with
// SELFPLAY_RECORD_POLICY=1 (policy.chosenRank = 1-based rank of the searched move in orderActions,
// policy.nLegal = number of legal actions).
//
//   node tools/policy/ordering-eval.js <data.jsonl|.jsonl.gz> [minDepth=3]
//
// Baseline for the learned-ordering experiment (PLAN.md, track B): a learned policy has to beat these
// numbers. "chance" is what a random ordering would give (rank uniform in 1..nLegal).
const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");
const [file, minDepthArg = "3"] = process.argv.slice(2);
if (!file) { console.log("usage: node tools/policy/ordering-eval.js <data> [minDepth]"); process.exit(1); }
const minDepth = Number(minDepthArg);

// Streamed (not fs.readFileSync + toString): large multi-hundred-MB rounds exceed Node's
// max string length when read whole. gzip -> line reader keeps memory to one line at a time.
async function loadRows() {
  const rows = [];
  const input = file.endsWith(".gz") ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    const p = r.policy;
    if (!p || !p.chosenRank || !p.nLegal) continue;
    rows.push({ rank: p.chosenRank, n: p.nLegal, depth: r.completedDepth || 0 });
  }
  return rows;
}
function report(label, set) {
  if (!set.length) { console.log(label + ": no records"); return; }
  const frac = (f) => (100 * set.filter(f).length / set.length).toFixed(1) + "%";
  const mean = (f) => (set.reduce((s, x) => s + f(x), 0) / set.length).toFixed(2);
  console.log(`${label}: n=${set.length}  top1 ${frac((x) => x.rank === 1)}  top3 ${frac((x) => x.rank <= 3)}  top5 ${frac((x) => x.rank <= 5)}  mean rank ${mean((x) => x.rank)} of ${mean((x) => x.n)} legal  mean rank/legal ${mean((x) => x.rank / x.n)}  MRR ${mean((x) => 1 / x.rank)}`);
  console.log(`   random ordering would give: top1 ${(100 * set.reduce((s, x) => s + 1 / x.n, 0) / set.length).toFixed(1)}%  top3 ${(100 * set.reduce((s, x) => s + Math.min(3, x.n) / x.n, 0) / set.length).toFixed(1)}%  MRR ${(set.reduce((s, x) => s + (Math.log(x.n) + 0.5772) / x.n, 0) / set.length).toFixed(3)}`);
}
loadRows().then((rows) => {
  report("all depths", rows);
  report(`depth >= ${minDepth}`, rows.filter((x) => x.depth >= minDepth));
});

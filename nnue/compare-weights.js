// Quick head-to-head comparison of two saved NNUE weights.json files on the
// SAME held-out validation split train.js itself would use (last ~10% of
// games, split at a game boundary -- see train.js's own comment on why not
// a raw position-index cut). Pure-JS forward pass (forward.js, no tfjs), so
// this runs in seconds even on a large data file -- meant for "did this
// weights.json actually get better, or is that just noise" right after a
// training run, without re-running training again to find out.
//
// Usage:
//   node compare-weights.js <baseline-weights.json> <candidate-weights.json> [dataFile]
//
// Reports each model's own sign-agreement accuracy (same definition
// train.js prints at the end of a run) PLUS a McNemar test on the paired
// per-position right/wrong outcomes, which is the actually-correct way to
// tell two accuracy percentages measured on the exact same examples apart
// -- e.g. "65.5% vs 66.1%" on ~1000 positions is easy to mistake for a real
// improvement when it's within noise; McNemar's b/c disagreement counts
// make that visible instead of hidden behind two rounded percentages.
const path = require("path");
const { loadData, DATA_FILE } = require("./train.js");
const { loadWeights, forward } = require("./forward.js");

function chiSquarePValue1df(chiSq) {
  // 1-df chi-square survival function == 2*(1 - Phi(sqrt(chiSq))), and for
  // the standard normal CDF Phi we use the erf identity
  // Phi(x) = 0.5*(1+erf(x/sqrt(2))). erf via Abramowitz & Stegun 7.1.26
  // (max error ~1.5e-7) -- plenty precise for a rough significance read,
  // no need to pull in a stats library for this.
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
      a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  const z = Math.sqrt(Math.max(0, chiSq));
  const phi = 0.5 * (1 + erf(z / Math.SQRT2));
  return 2 * (1 - phi);
}

async function main() {
  const [, , baselinePath, candidatePath, dataFileArg] = process.argv;
  if (!baselinePath || !candidatePath) {
    console.error("Usage: node compare-weights.js <baseline-weights.json> <candidate-weights.json> [dataFile]");
    process.exit(1);
  }
  const dataFile = dataFileArg ? path.resolve(dataFileArg) : DATA_FILE;
  console.log("data file:", dataFile);

  const { inputs, labels, pieceCounts, gameIds } = await loadData(dataFile);

  const totalGames = gameIds.length ? gameIds[gameIds.length - 1] + 1 : 0;
  const valGameStart = Math.floor(totalGames * 0.9);
  const gameBoundaryIndex = gameIds.findIndex((id) => id >= valGameStart);
  const splitAt = gameBoundaryIndex === -1 ? gameIds.length : gameBoundaryIndex;
  console.log("validation split: game", valGameStart, "of", totalGames, "-> position index", splitAt, "of", inputs.length);

  const valInputs = inputs.slice(splitAt);
  const valLabels = labels.slice(splitAt);
  const valPieceCounts = pieceCounts.slice(splitAt);

  const baseline = loadWeights(path.resolve(baselinePath));
  const candidate = loadWeights(path.resolve(candidatePath));

  let decisive = 0;
  let baseCorrect = 0, candCorrect = 0;
  let bothCorrect = 0, bothWrong = 0, onlyBaseCorrect = 0, onlyCandCorrect = 0;

  valLabels.forEach((label, i) => {
    if (label === 0) return; // only decisive positions count toward sign-agreement, same as train.js
    decisive += 1;
    const input = valInputs[i];
    const baseAgree = Math.sign(forward(baseline, input)) === Math.sign(label);
    const candAgree = Math.sign(forward(candidate, input)) === Math.sign(label);
    if (baseAgree) baseCorrect += 1;
    if (candAgree) candCorrect += 1;
    if (baseAgree && candAgree) bothCorrect += 1;
    else if (!baseAgree && !candAgree) bothWrong += 1;
    else if (baseAgree && !candAgree) onlyBaseCorrect += 1;
    else onlyCandCorrect += 1;
  });

  const pct = (n) => decisive ? ((n / decisive) * 100).toFixed(1) : "n/a";
  console.log("");
  console.log("baseline  (" + path.basename(baselinePath) + "):", pct(baseCorrect) + "%", `(${baseCorrect}/${decisive})`);
  console.log("candidate (" + path.basename(candidatePath) + "):", pct(candCorrect) + "%", `(${candCorrect}/${decisive})`);
  console.log("");
  console.log("agreement breakdown (2x2, decisive positions only):");
  console.log("  both correct:         ", bothCorrect);
  console.log("  both wrong:           ", bothWrong);
  console.log("  only baseline correct:", onlyBaseCorrect, "(candidate regressed here)");
  console.log("  only candidate correct:", onlyCandCorrect, "(candidate improved here)");

  const b = onlyBaseCorrect, c = onlyCandCorrect;
  if (b + c === 0) {
    console.log("\nMcNemar test: baseline and candidate never disagreed on a single position -- nothing to test, they're behaviorally identical on this split.");
  } else {
    // continuity-corrected McNemar statistic (safer than the plain form for smaller b+c)
    const chiSq = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
    const p = chiSquarePValue1df(chiSq);
    console.log(`\nMcNemar test: chi-sq=${chiSq.toFixed(3)}, p=${p.toFixed(4)}`);
    if (p < 0.05) {
      console.log(c > b
        ? "-> statistically significant IMPROVEMENT (candidate beats baseline, p<0.05)"
        : "-> statistically significant REGRESSION (candidate is worse than baseline, p<0.05)");
    } else {
      console.log("-> NOT statistically significant at p<0.05 -- the accuracy difference could plausibly be noise on this validation set size.");
    }
  }

  console.log("\n(endgame-only breakdown, <=12 pieces, often the noisiest slice due to small sample size)");
  let fewDecisive = 0, fewBase = 0, fewCand = 0;
  valLabels.forEach((label, i) => {
    if (label === 0 || valPieceCounts[i] > 12) return;
    fewDecisive += 1;
    if (Math.sign(forward(baseline, valInputs[i])) === Math.sign(label)) fewBase += 1;
    if (Math.sign(forward(candidate, valInputs[i])) === Math.sign(label)) fewCand += 1;
  });
  console.log("  baseline: ", fewDecisive ? `${((fewBase / fewDecisive) * 100).toFixed(1)}% (${fewBase}/${fewDecisive})` : "n/a");
  console.log("  candidate:", fewDecisive ? `${((fewCand / fewDecisive) * 100).toFixed(1)}% (${fewCand}/${fewDecisive})` : "n/a");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

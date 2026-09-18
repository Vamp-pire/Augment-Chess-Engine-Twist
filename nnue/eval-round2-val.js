// Sign-agreement accuracy comparison for multiple weight files (and the
// hand-coded evaluator) on the SAME held-out validation split of a given
// self-play dataset -- reuses train.js's own loadData()/game-boundary-split
// logic exactly, so this is the same number train.js itself would have
// printed for each candidate, not a re-derived metric that could drift.
//
// Only valid to compare NUMBERS ACROSS CANDIDATES run against the SAME
// dataFile (same split, same distribution). Do NOT compare this dataset's
// accuracy number against a different dataset's (e.g. round1 vs round2) --
// see this session's own discussion of why that comparison is invalid.
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
const { loadData, INPUT_SIZE, ORIGINAL_EVAL_WEIGHTS } = require("./train.js");
const { loadWeights, forward } = require("./forward.js");

const [, , dataFile, ...weightArgs] = process.argv;
if (!dataFile || weightArgs.length === 0) {
  console.error("Usage: node eval-round2-val.js <data.jsonl> <weightsA.json|handcoded> [weightsB.json|handcoded ...]");
  process.exit(1);
}

function scoreHandcoded(input) {
  const featureBase = INPUT_SIZE - ORIGINAL_EVAL_WEIGHTS.length;
  let sum = 0;
  for (let i = 0; i < ORIGINAL_EVAL_WEIGHTS.length; i += 1) sum += input[featureBase + i] * ORIGINAL_EVAL_WEIGHTS[i];
  return sum;
}

async function main() {
  const { inputs, labels, gameIds } = await loadData(dataFile);
  const totalGames = gameIds.length ? gameIds[gameIds.length - 1] + 1 : 0;
  const valGameStart = Math.floor(totalGames * 0.9);
  const gameBoundaryIndex = gameIds.findIndex((id) => id >= valGameStart);
  const splitAt = gameBoundaryIndex === -1 ? gameIds.length : gameBoundaryIndex;
  console.log("train/val split: game", valGameStart, "of", totalGames, "-> position index", splitAt, "of", inputs.length);

  const valInputs = inputs.slice(splitAt);
  const valLabels = labels.slice(splitAt);
  const decisiveIdx = [];
  valLabels.forEach((l, i) => { if (l !== 0) decisiveIdx.push(i); });
  console.log("decisive validation positions:", decisiveIdx.length, "of", valLabels.length);

  const correctness = {}; // arg -> Array<boolean> aligned with decisiveIdx
  for (const arg of weightArgs) {
    const scoreFn = arg === "handcoded" ? scoreHandcoded : (() => {
      const w = loadWeights(arg);
      return (input) => forward(w, input);
    })();
    const flags = [];
    for (const i of decisiveIdx) {
      const s = scoreFn(valInputs[i]);
      flags.push(Math.sign(s) === Math.sign(valLabels[i]));
    }
    correctness[arg] = flags;
    const correct = flags.filter(Boolean).length;
    const pct = (100 * correct / decisiveIdx.length).toFixed(1);
    console.log(`${arg}: ${pct}% (${correct}/${decisiveIdx.length})`);
  }

  // McNemar (continuity-corrected) between the FIRST arg (the candidate
  // being evaluated) and every other arg, on this same decisive validation
  // set -- the simple pairwise significance check the owner actually asked
  // for, not just raw accuracy percentages side by side.
  if (weightArgs.length > 1) {
    console.log("\n=== McNemar vs first arg (" + weightArgs[0] + ") ===");
    const base = correctness[weightArgs[0]];
    for (const arg of weightArgs.slice(1)) {
      const other = correctness[arg];
      let onlyBase = 0, onlyOther = 0;
      for (let i = 0; i < base.length; i += 1) {
        if (base[i] && !other[i]) onlyBase += 1;
        else if (!base[i] && other[i]) onlyOther += 1;
      }
      const b = onlyBase, c = onlyOther;
      if (b + c === 0) {
        console.log(`${weightArgs[0]} vs ${arg}: no disagreements -- always agreed`);
        continue;
      }
      const chiSq = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
      const sig = chiSq >= 3.841 ? "p<0.05" : "not significant";
      console.log(`${weightArgs[0]} vs ${arg}: b(only ${weightArgs[0]} right)=${b}, c(only ${arg} right)=${c}, chi-sq=${chiSq.toFixed(3)} (${sig})`);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e && e.stack || e); process.exit(1); });

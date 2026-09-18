globalThis.self = globalThis;
globalThis.addEventListener = () => {};
const { loadData, INPUT_SIZE, ORIGINAL_EVAL_WEIGHTS } = require("./train.js");
const { loadWeights, forward } = require("./forward.js");

const [, , dataFile, ...weightArgs] = process.argv;

function handcoded(input) {
  const base = INPUT_SIZE - ORIGINAL_EVAL_WEIGHTS.length;
  let s = 0;
  for (let i = 0; i < ORIGINAL_EVAL_WEIGHTS.length; i += 1) s += input[base + i] * ORIGINAL_EVAL_WEIGHTS[i];
  return s;
}

async function main() {
  const { inputs, labels, gameIds } = await loadData(dataFile);
  const total = gameIds.length ? gameIds[gameIds.length - 1] + 1 : 0;
  const valStart = Math.floor(total * 0.9);
  const split = gameIds.findIndex((g) => g >= valStart);
  const gameLen = {};
  gameIds.forEach((g) => { gameLen[g] = (gameLen[g] || 0) + 1; });
  const seen = {};
  const fromEnd = gameIds.map((g) => { seen[g] = (seen[g] || 0) + 1; return gameLen[g] - seen[g] + 1; });

  const buckets = [[1, 10], [11, 30], [31, 60], [61, 1e9]];
  const models = weightArgs.map((a) => a === "handcoded" ? { name: a, fn: handcoded } : (() => { const w = loadWeights(a); return { name: a.split(/[\\/]/).pop(), fn: (x) => forward(w, x) }; })());

  console.log("games:", total, "val start game:", valStart, "split idx:", split, "of", inputs.length);
  for (const [name, idxRange] of [["ALL positions", [0, inputs.length]], ["VAL only", [split, inputs.length]]]) {
    console.log("\n== " + name + " (decisive only) ==");
    for (const [lo, hi] of buckets) {
      const idx = [];
      for (let i = idxRange[0]; i < idxRange[1]; i += 1) if (labels[i] !== 0 && fromEnd[i] >= lo && fromEnd[i] <= hi) idx.push(i);
      const row = models.map((m) => {
        let c = 0;
        for (const i of idx) if (Math.sign(m.fn(inputs[i])) === Math.sign(labels[i])) c += 1;
        return `${m.name}=${(100 * c / idx.length).toFixed(1)}%`;
      });
      console.log(`plies-from-end ${lo}-${hi === 1e9 ? "+" : hi}: n=${idx.length}  ${row.join("  ")}`);
    }
  }
  let dec = 0, draws = 0;
  for (let i = 0; i < labels.length; i += 1) { if (labels[i] === 0) draws += 1; else dec += 1; }
  console.log("\nlabel mix: decisive", dec, "draw/zero", draws, "=> zero-label share", (100 * draws / labels.length).toFixed(1) + "%");
}
main().catch((e) => { console.error(e); process.exit(1); });

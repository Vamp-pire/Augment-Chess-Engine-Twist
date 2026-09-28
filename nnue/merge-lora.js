// nnue/merge-lora.js -- merges a LoRA-trained adapter (nnue/train.js run
// with LORA_BASE set, which saves a tagged "*.lora.json" sidecar -- see
// train.js's loraSidecarFromModel()) with its base weights.json into a
// normal flat weights.json that forward.js's existing loadWeights/forward
// reads with ZERO changes. That's the whole point of doing this: once
// merged, no adapter structure survives (see PLAN.md's "LoRA 도입" section,
// step 4) -- extension/engine.js and nnue/match-two-models.js don't need to
// know LoRA was ever involved.
//
// Merge rules (mirrors exactly how buildLoraModel() in train.js assembled
// the graph, undone):
//   k1_old_rows    = base k1 rows + B*A            (rebalance correction)
//   k1_new_rows    = adapter's trained new-slice kernel (if any new columns)
//   wideLayer_old  = base wideLayer rows, UNCHANGED (no low-rank correction there)
//   wideLayer_new  = adapter's trained new-slice kernel (if any new columns)
//   b1/k2/b2/deepOut = the adapter's own trained values, used directly
//
// Usage: node nnue/merge-lora.js <base-weights.json> <adapter.lora.json> <output-weights.json>
"use strict";
const fs = require("fs");
const { loadWeights } = require("./forward.js");

// B: {shape:[m,r], data}, A: {shape:[r,n], data} -> {shape:[m,n], data}, row-major (matches
// forward.js's denseLayer indexing: data[i*outDim+o]).
function matmul(B, A) {
  const [m, r] = B.shape;
  const [r2, n] = A.shape;
  if (r !== r2) throw new Error(`matmul shape mismatch: B is ${m}x${r}, A is ${r2}x${n}`);
  // Accumulate in a plain JS number (double precision) per output cell --
  // avoids compounding float32 rounding across the sum before it's ever
  // written out, since the inputs (loaded from JSON) are already plain
  // doubles anyway.
  const out = new Array(m * n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < r; k++) {
      const b = B.data[i * r + k];
      if (b === 0) continue;
      for (let j = 0; j < n; j++) out[i * n + j] += b * A.data[k * n + j];
    }
  }
  return { shape: [m, n], data: out };
}

function addFlat(a, b) {
  if (a.shape[0] !== b.shape[0] || a.shape[1] !== b.shape[1]) {
    throw new Error(`addFlat shape mismatch: ${a.shape} vs ${b.shape}`);
  }
  const data = new Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) data[i] = a.data[i] + b.data[i];
  return { shape: a.shape, data };
}

// Stacks `bottom`'s rows after `top`'s (same column count). `bottom` may be
// null (no new columns), in which case `top` is returned unchanged.
function vstack(top, bottom) {
  if (!bottom) return top;
  if (top.shape[1] !== bottom.shape[1]) throw new Error(`vstack column mismatch: ${top.shape} vs ${bottom.shape}`);
  return { shape: [top.shape[0] + bottom.shape[0], top.shape[1]], data: top.data.concat(bottom.data) };
}

// basePath/adapterPath: file paths. Returns the flat 6-tensor array
// forward.js's loadWeights expects (same order as a plain weights.json:
// [k1, b1, k2, b2, kDeepOut, kWideOut]).
function mergeLora(basePath, adapterPath) {
  const base = loadWeights(basePath); // {k1,b1,k2,b2,kDeepOut,kWideOut}, each {shape,data}
  const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8"));
  if (!adapter.lora) throw new Error(`${adapterPath} doesn't look like a LoRA sidecar (missing "lora":true tag)`);
  const t = adapter.tensors;

  if (base.k1.shape[0] !== adapter.oldSize) {
    throw new Error(`base k1 input size (${base.k1.shape[0]}) doesn't match adapter's recorded oldSize (${adapter.oldSize}) -- wrong base file for this adapter?`);
  }
  if (base.k1.shape[1] !== adapter.deepUnits) {
    throw new Error(`base k1 deep-units (${base.k1.shape[1]}) doesn't match adapter's recorded deepUnits (${adapter.deepUnits})`);
  }

  const correction = matmul(t.loraB, t.loraA); // [oldSize, deepUnits]
  const k1OldMerged = addFlat(base.k1, correction);
  const k1 = vstack(k1OldMerged, t.newDeepK); // t.newDeepK is null when adapter.newSize === 0

  const kWideOut = vstack(base.kWideOut, t.newWideK);

  // b1 was saved as a [1, deepUnits] "kernel-as-bias" (train.js's
  // buildLoraModel bias trick) -- flatten to the plain [deepUnits] bias
  // shape forward.js expects.
  const b1 = { shape: [t.b1.shape[1]], data: t.b1.data.slice() };

  return [
    k1,
    b1,
    { shape: t.k2.shape, data: t.k2.data.slice() },
    { shape: t.b2.shape, data: t.b2.data.slice() },
    { shape: t.deepOut.shape, data: t.deepOut.data.slice() },
    kWideOut
  ];
}

module.exports = { mergeLora, matmul, addFlat, vstack };

if (require.main === module) {
  const [, , basePath, adapterPath, outPath] = process.argv;
  if (!basePath || !adapterPath || !outPath) {
    console.error("usage: node nnue/merge-lora.js <base-weights.json> <adapter.lora.json> <output-weights.json>");
    process.exit(1);
  }
  const merged = mergeLora(basePath, adapterPath);
  fs.writeFileSync(outPath, JSON.stringify(merged));
  console.log("merged weights written to", outPath);
}

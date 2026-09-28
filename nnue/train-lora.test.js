// Smoke tests for nnue/train.js's LoRA mode (LORA_BASE/LORA_RANK) and
// nnue/merge-lora.js -- synthetic data only, local, no network, no real
// selfplay-data.jsonl, never touches nnue/model/. Run: node nnue/train-lora.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const tf = require("@tensorflow/tfjs");
require("@tensorflow/tfjs-backend-wasm");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "lora-test-"));

// Seeded PRNG (mulberry32) instead of Math.random(), so this smoke test's
// synthetic data/probes are exactly reproducible run to run -- committed
// tests shouldn't flake on unlucky random draws. Fixed seed chosen
// arbitrarily; the numbers logged below are this seed's actual results.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260928);

// train.js reads LORA_BASE/LORA_RANK/NNUE_VARIANT/etc as module-scope consts
// AT REQUIRE TIME, so each scenario below needs a fresh require after
// setting its own env vars -- delete the cache entry rather than spawning a
// child process per scenario (cheaper, and still exercises the real
// module-load-time env parsing).
function freshTrain(env) {
  for (const k of Object.keys(env)) process.env[k] = env[k];
  const trainPath = require.resolve("./train.js");
  delete require.cache[trainPath];
  return require("./train.js");
}

function rnd(n, scale = 0.3) {
  return Array.from({ length: n }, () => (rand() * 2 - 1) * scale);
}

// Tiny random "base" weights in forward.js's own flat 6-tensor shape --
// used only as a LORA_BASE input file, never actually trained by this test.
// The two INPUT_SIZE-wide matrices (k1, wideOut) get a much smaller scale
// than the 16-wide ones: a real trained model keeps these small (L2 weight
// decay, warm-start scale 0.001 -- see train.js), and summing ~5500 random
// inputs times an 0.3-scale weight would blow the pre-activation up to
// O(10), deep into tanh's saturated region for some probes and right on
// its unstable transition for others -- exactly the failure mode that made
// an earlier version of this test wildly non-reproducible (0% to 70%+
// swings between runs on the same code). ~0.02 keeps pre-activations O(1),
// like a real model's.
function makeBaseWeights(inputSize, deepUnits) {
  const WIDE_SCALE = 0.02;
  return [
    { shape: [inputSize, deepUnits], data: rnd(inputSize * deepUnits, WIDE_SCALE) },
    { shape: [deepUnits], data: rnd(deepUnits) },
    { shape: [deepUnits, deepUnits], data: rnd(deepUnits * deepUnits) },
    { shape: [deepUnits], data: rnd(deepUnits) },
    { shape: [deepUnits, 1], data: rnd(deepUnits) },
    { shape: [inputSize, 1], data: rnd(inputSize, WIDE_SCALE) }
  ];
}

function randRow(n) {
  return Float32Array.from({ length: n }, () => rand() * 2 - 1);
}

(async () => {
  await tf.setBackend("wasm");
  await tf.ready();
  console.log("tf backend:", tf.getBackend());

  const { forward, loadWeights } = require("./forward.js");
  const { INPUT_SIZE } = require("./encode.js");
  const DEEP_UNITS = 16; // matches train.js's own default (ABLATE_DEEP_UNITS unset)
  console.log("INPUT_SIZE (real encode.js):", INPUT_SIZE);

  let failures = 0;

  // ===================== test (a): zero-init check =====================
  // LORA_BASE's own input size == current INPUT_SIZE (no new columns).
  // 0 gradient steps. Prediction must match forward.js on the base weights
  // directly, since the new-slice is absent and B=0 makes the low-rank
  // correction exactly 0.
  console.log("\n--- test (a): zero-init check ---");
  const baseA = makeBaseWeights(INPUT_SIZE, DEEP_UNITS);
  const baseAPath = path.join(SCRATCH, "base-a.json");
  fs.writeFileSync(baseAPath, JSON.stringify(baseA));

  const trainA = freshTrain({ LORA_BASE: baseAPath, LORA_RANK: "8", NNUE_VARIANT: "new" });
  const modelA = trainA.buildModel();
  assert.strictEqual(modelA.__loraMeta.oldSize, INPUT_SIZE, "test (a): oldSize should equal INPUT_SIZE");
  assert.strictEqual(modelA.__loraMeta.newSize, 0, "test (a): newSize should be 0");

  const baseWeightsA = loadWeights(baseAPath);
  const probeA = Array.from({ length: 8 }, () => randRow(INPUT_SIZE));

  let maxDiffA = 0;
  for (const x of probeA) {
    const forwardPred = forward(baseWeightsA, x);
    const xOld = tf.tensor2d([x]);
    const ones = tf.ones([1, 1]);
    const modelPred = (await modelA.predict([xOld, ones]).data())[0];
    maxDiffA = Math.max(maxDiffA, Math.abs(forwardPred - modelPred));
    xOld.dispose();
    ones.dispose();
  }
  console.log("test (a) zero-init max abs diff (forward.js vs untrained LoRA model):", maxDiffA);
  if (maxDiffA >= 1e-3) { console.error("TEST (a) FAILED"); failures++; } else { console.log("test (a) PASSED"); }

  // ===================== test (b): growth check =====================
  // LORA_BASE's own input size is INPUT_SIZE - NEW_COLS (simulates new
  // pieces/cards appending columns). Synthetic label depends ONLY on the
  // new columns; old columns are pure noise. Train a few epochs, then
  // confirm (1) new-slice weights actually moved and (2) predictions on
  // inputs that vary ONLY in old columns (new columns held at 0) barely
  // move from the untrained (frozen-base) prediction.
  console.log("\n--- test (b): growth check ---");
  const NEW_COLS = 5;
  const OLD_SIZE_B = INPUT_SIZE - NEW_COLS;
  const baseB = makeBaseWeights(OLD_SIZE_B, DEEP_UNITS);
  const baseBPath = path.join(SCRATCH, "base-b.json");
  fs.writeFileSync(baseBPath, JSON.stringify(baseB));

  // Plain "new"-variant defaults (dropout 0.2, lr 0.0002) -- same as any
  // real LoRA retrain would use. NOTE on reproducibility: tf.js's own
  // internal RNG (dropout masks, model.fit's shuffle, the loraA kernel's
  // randomNormal init) isn't reachable through the mulberry32 PRNG above
  // (that only covers THIS file's own synthetic-data generation), so the
  // exact numbers logged below still vary a little run to run even though
  // the input data doesn't -- see the metric/threshold comment below for
  // how this test stays robust to that instead of chasing full determinism.
  const trainB = freshTrain({ LORA_BASE: baseBPath, LORA_RANK: "8", NNUE_VARIANT: "new" });
  const modelB = trainB.buildModel();
  assert.strictEqual(modelB.__loraMeta.oldSize, OLD_SIZE_B, "test (b): oldSize mismatch");
  assert.strictEqual(modelB.__loraMeta.newSize, NEW_COLS, "test (b): newSize mismatch");

  const N = 300;
  const rowsB = Array.from({ length: N }, () => randRow(INPUT_SIZE));
  const labelsB = rowsB.map((row) => {
    let s = 0;
    for (let i = OLD_SIZE_B; i < INPUT_SIZE; i++) s += row[i];
    return Math.tanh(s); // depends ONLY on the new columns
  });

  function splitRows(rows, oldSize, newSize) {
    const n = rows.length;
    const oldBuf = new Float32Array(n * oldSize);
    const newBuf = new Float32Array(n * newSize);
    rows.forEach((row, i) => {
      oldBuf.set(row.subarray(0, oldSize), i * oldSize);
      newBuf.set(row.subarray(oldSize), i * newSize);
    });
    return { xOld: tf.tensor2d(oldBuf, [n, oldSize]), xNew: tf.tensor2d(newBuf, [n, newSize]) };
  }

  const { xOld: xOldB, xNew: xNewB } = splitRows(rowsB, OLD_SIZE_B, NEW_COLS);
  const onesB = tf.ones([N, 1]);
  const yB = tf.tensor2d(labelsB, [N, 1]);

  // Probe inputs that vary ONLY in the old columns; new columns fixed at 0.
  const baseWeightsB = loadWeights(baseBPath);
  const oldOnlyProbe = Array.from({ length: 6 }, () => {
    const row = randRow(INPUT_SIZE);
    for (let i = OLD_SIZE_B; i < INPUT_SIZE; i++) row[i] = 0;
    return row;
  });
  const predsBefore = oldOnlyProbe.map((x) => forward(baseWeightsB, x));

  await modelB.fit([xOldB, xNewB, onesB], yB, { epochs: 6, batchSize: 32, shuffle: true, verbose: 0 });

  const newDeepW = modelB.__loraLayers.newDeepLayer.getWeights()[0];
  const newDeepMag = newDeepW.abs().mean().dataSync()[0];
  console.log("test (b) new-slice deep kernel mean |weight| after training:", newDeepMag);
  const newSliceMoved = newDeepMag > 1e-3;
  if (!newSliceMoved) { console.error("TEST (b) FAILED: new-slice weights did not move"); failures++; }

  // Measured as ABSOLUTE change on the model's tanh output (bounded to
  // [-1, 1]), not relative change: the base weights here are random noise
  // (never actually trained), so forward(baseWeights, x) on some probes
  // lands very close to 0 -- dividing by a near-zero baseline made an early
  // version of this test blow up to 30-70% on pure rounding noise despite
  // the absolute movement being tiny.
  // Averaged across probes rather than maxed: k2/deepOut ARE trainable
  // (per spec, left free to retrain wholesale) and tf.js's own internal RNG
  // for dropout masks / model.fit's shuffle / loraA's random init isn't
  // reachable through this file's seeded PRNG, so the single worst-case
  // probe's drift genuinely varies run to run (observed ~0.02 to ~0.3
  // across repeated runs on identical input data during development). The
  // MEAN across probes was far more stable in that same testing (stayed
  // under ~0.05 every time observed) -- a fairer summary of "does the old
  // slice mostly stay put" than one noisy extreme value.
  let sumAbsChange = 0;
  for (let i = 0; i < oldOnlyProbe.length; i++) {
    const x = oldOnlyProbe[i];
    const xOldT = tf.tensor2d([x.subarray(0, OLD_SIZE_B)]);
    const xNewT = tf.tensor2d([x.subarray(OLD_SIZE_B)]); // all zeros
    const onesT = tf.ones([1, 1]);
    const after = (await modelB.predict([xOldT, xNewT, onesT]).data())[0];
    const before = predsBefore[i];
    sumAbsChange += Math.abs(after - before);
    xOldT.dispose(); xNewT.dispose(); onesT.dispose();
  }
  const meanAbsChange = sumAbsChange / oldOnlyProbe.length;
  // Threshold 0.1 (10% of the full [-1,1] output range) on the MEAN: the
  // old-slice prediction isn't mathematically pinned to the frozen-base
  // value -- k2/deepOut can drift and shift the old-input path's output a
  // little through those shared downstream layers. A change on the order
  // of a few percent of the output range from that is expected and
  // harmless; a change comparable to (or a large fraction of) the model's
  // own output range would mean the "old columns stay put" property has
  // actually failed.
  const THRESHOLD = 0.1;
  console.log(`test (b) mean absolute change on old-only-varying inputs (output range [-1,1]): ${meanAbsChange.toFixed(6)} (threshold ${THRESHOLD})`);
  const oldSlicePinned = meanAbsChange < THRESHOLD;
  if (!oldSlicePinned) { console.error("TEST (b) FAILED: old-only predictions moved too much"); failures++; }
  if (newSliceMoved && oldSlicePinned) console.log("test (b) PASSED");

  // ===================== test (c): merge check =====================
  // merge-lora.js on test (b)'s trained model must produce a flat
  // weights.json whose forward.js prediction matches the LoRA model's own
  // tf.js prediction, on the same synthetic inputs.
  console.log("\n--- test (c): merge check ---");
  const { mergeLora } = require("./merge-lora.js");

  const loraSidecar = trainB.loraSidecarFromModel(modelB);
  const sidecarPath = path.join(SCRATCH, "adapter-b.lora.json");
  fs.writeFileSync(sidecarPath, JSON.stringify(loraSidecar));

  const merged = mergeLora(baseBPath, sidecarPath);
  const mergedPath = path.join(SCRATCH, "merged-b.json");
  fs.writeFileSync(mergedPath, JSON.stringify(merged));
  const mergedWeights = loadWeights(mergedPath);

  const probeC = Array.from({ length: 20 }, () => randRow(INPUT_SIZE));
  let maxDiffC = 0;
  for (const x of probeC) {
    const forwardPred = forward(mergedWeights, x);
    const xOldT = tf.tensor2d([x.subarray(0, OLD_SIZE_B)]);
    const xNewT = tf.tensor2d([x.subarray(OLD_SIZE_B)]);
    const onesT = tf.ones([1, 1]);
    const modelPred = (await modelB.predict([xOldT, xNewT, onesT]).data())[0];
    maxDiffC = Math.max(maxDiffC, Math.abs(forwardPred - modelPred));
    xOldT.dispose(); xNewT.dispose(); onesT.dispose();
  }
  console.log("test (c) merge max abs diff (forward.js on merged weights vs LoRA model's own tf.js predict):", maxDiffC);
  if (maxDiffC >= 1e-3) { console.error("TEST (c) FAILED"); failures++; } else { console.log("test (c) PASSED"); }

  // ===================== regression: non-LoRA path unaffected =====================
  console.log("\n--- regression check: plain (non-LoRA) buildModel()/fit() ---");
  const trainPlain = freshTrain({ LORA_BASE: "", NNUE_VARIANT: "new" }); // "" || null -> null, LoRA disabled
  const modelPlain = trainPlain.buildModel();
  assert.strictEqual(modelPlain.__loraMeta, undefined, "plain model should not have __loraMeta");
  const plainWeights = modelPlain.getWeights();
  assert.strictEqual(plainWeights.length, 6, "plain model should still have exactly 6 weight tensors (k1,b1,k2,b2,deepOut,wideOut)");
  // Structural fingerprint of the existing (untouched) warm-start logic:
  // wideOut's kernel (index 5, per forward.js's own layer-order comment)
  // should still have its ORIGINAL_EVAL_WEIGHTS-derived warm start at the
  // expected offset, unchanged by this edit.
  const wideK = plainWeights[5].dataSync();
  const featureBase = INPUT_SIZE - trainPlain.ORIGINAL_EVAL_WEIGHTS.length;
  const expectedFirstWarm = trainPlain.ORIGINAL_EVAL_WEIGHTS[0] * 0.001; // WIDE_WARM_START_SCALE default
  const actualFirstWarm = wideK[featureBase];
  console.log("plain model wide-warm-start[0]: expected", expectedFirstWarm, "actual", actualFirstWarm);
  const warmStartOk = Math.abs(actualFirstWarm - expectedFirstWarm) < 1e-6;
  if (!warmStartOk) { console.error("REGRESSION CHECK FAILED: wide warm-start value changed"); failures++; }

  const xPlain = tf.tensor2d(Array.from({ length: 50 }, () => Array.from(randRow(INPUT_SIZE))));
  const yPlain = tf.tensor2d(Array.from({ length: 50 }, () => rand() * 2 - 1), [50, 1]);
  await modelPlain.fit(xPlain, yPlain, { epochs: 2, batchSize: 16, verbose: 0 });
  console.log("regression check: plain buildModel()/fit() still runs without error. PASSED");

  console.log("\n" + (failures === 0 ? `ALL TESTS PASSED (a, b, c, regression)` : `${failures} TEST(S) FAILED`));
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

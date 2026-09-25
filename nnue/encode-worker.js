// Runs encodeBoard() for a chunk of positions off the main thread -- see
// train.js's encodeInParallel() for why: encodeBoard now calls
// evaluateStateComponents() per position (added for the 21-feature
// injection), which is real per-position work, and doing it for tens of
// thousands of positions serially on the main thread was the dominant cost
// in a retrain (confirmed 2026-09-09: a run sat with no "positions loaded"
// log for minutes before this existed).
const { parentPort, workerData } = require("worker_threads");
const { encodeBoard, INPUT_SIZE } = require("./encode.js");

const { boards, sparse } = workerData; // [{board, turn, deckSlots}, ...]
const nullFlags = new Uint8Array(boards.length);
if (sparse) {
  // SPARSE_INPUT=1: emit CSR rows for the non-terminal positions only, never
  // a dense boards.length * INPUT_SIZE buffer (see sparse.js).
  const { SparseBuilder } = require("./sparse.js");
  const builder = new SparseBuilder();
  boards.forEach((b, i) => {
    const encoded = encodeBoard(b.board, b.turn, b.deckSlots);
    if (encoded === null) {
      nullFlags[i] = 1;
      return;
    }
    builder.addDenseRow(encoded);
  });
  const { rows, offsets, indices, values } = builder.finish();
  parentPort.postMessage({ rows, offsets, indices, values, nullFlags }, [offsets.buffer, indices.buffer, values.buffer, nullFlags.buffer]);
} else {
  const out = new Float32Array(boards.length * INPUT_SIZE);
  boards.forEach((b, i) => {
    const encoded = encodeBoard(b.board, b.turn, b.deckSlots);
    if (encoded === null) {
      nullFlags[i] = 1;
      return;
    }
    out.set(encoded, i * INPUT_SIZE);
  });
  parentPort.postMessage({ out, nullFlags }, [out.buffer, nullFlags.buffer]);
}

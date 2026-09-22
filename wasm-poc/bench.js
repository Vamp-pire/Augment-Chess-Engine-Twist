'use strict';
// Benchmarks JS vs WASM implementations of positionalScoreCore, calling
// each ITERATIONS times over the SAME random board, including full
// JS<->WASM boundary crossing cost per call (memory write of the board
// into the wasm instance's memory + call), not just the wasm-side compute.

const fs = require('fs');
const path = require('path');
const { positionalScoreCoreJS } = require('./js-reference.js');

const ROWS = 8;
const COLS = 8;
const CELLS = ROWS * COLS;
const ITERATIONS = Number(process.argv[2]) || 50000;

function makeRandomBoard(seed) {
  // deterministic PRNG (mulberry32) so JS and WASM runs see identical boards
  let s = seed >>> 0;
  function rand() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const board = new Int32Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const r = rand();
    if (r < 0.55) { board[i] = 0; continue; } // empty square
    const type = 1 + Math.floor(rand() * 5); // 1..5 (skip 6/wall for realism)
    const sign = rand() < 0.5 ? -1 : 1;
    board[i] = sign * type;
  }
  return board;
}

async function main() {
  const board = makeRandomBoard(12345);

  // ---- JS baseline ----
  let jsResult = 0;
  const jsStart = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    jsResult += positionalScoreCoreJS(board, ROWS, COLS, true);
  }
  const jsEnd = process.hrtime.bigint();
  const jsMs = Number(jsEnd - jsStart) / 1e6;

  // ---- WASM ----
  const wasmPath = path.join(__dirname, 'build', 'index.wasm');
  const wasmBuffer = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
  const exports = instance.exports;
  const memory = exports.memory;

  // Allocate a fixed region for the board inside wasm linear memory.
  // Using --runtime stub means no GC/malloc exported, so we just claim
  // raw bytes at a fixed offset (grow if needed) and write via a typed view.
  const BOARD_BYTE_OFFSET = 8; // leave a few bytes at 0 alone
  const neededBytes = BOARD_BYTE_OFFSET + CELLS * 4;
  if (memory.buffer.byteLength < neededBytes) {
    const pagesNeeded = Math.ceil((neededBytes - memory.buffer.byteLength) / 65536);
    memory.grow(pagesNeeded);
  }

  let wasmResult = 0;
  const wasmStart = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    // realistic boundary cost: re-write the board into wasm memory every call
    const view = new Int32Array(memory.buffer, BOARD_BYTE_OFFSET, CELLS);
    view.set(board);
    wasmResult += exports.positionalScoreCore(BOARD_BYTE_OFFSET, ROWS, COLS, 1);
  }
  const wasmEnd = process.hrtime.bigint();
  const wasmMs = Number(wasmEnd - wasmStart) / 1e6;

  console.log(`iterations: ${ITERATIONS}`);
  console.log(`JS   result=${jsResult.toFixed(2)} time=${jsMs.toFixed(2)}ms (${(jsMs / ITERATIONS * 1000).toFixed(4)} us/call)`);
  console.log(`WASM result=${wasmResult.toFixed(2)} time=${wasmMs.toFixed(2)}ms (${(wasmMs / ITERATIONS * 1000).toFixed(4)} us/call)`);
  const matches = Math.abs(jsResult - wasmResult) < 1e-6 * Math.max(1, Math.abs(jsResult));
  console.log(`results match: ${matches}`);
  console.log(`ratio (JS time / WASM time): ${(jsMs / wasmMs).toFixed(3)}x  (>1 means WASM faster)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

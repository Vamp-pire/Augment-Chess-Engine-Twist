// Converts a real .acg game record into a sequence of {board, deckSlots,
// mover} positions, using the site's own decodeAcgRecord() + the exact
// before/after deltas it records per event -- NOT a re-parse of the human-
// readable move text, so there's no SAN-like notation guessing involved.
// Must be run with `node --import ./init.mjs --input-type=module acg-to-positions.mjs <file.acg>`
import { createRequire } from "module";
const require = createRequire(import.meta.url);

function applyFieldDelta(state, fields) {
  for (const f of fields) {
    if (f.afterExists === false) delete state[f.key];
    else state[f.key] = f.after;
  }
}

function applyBoardDelta(board, cells) {
  for (const c of cells) {
    board[c.row][c.col] = c.after || null;
  }
}

// Real site card ids are hyphenated ("mad-horse", "big-rook"); our
// CARD_POOL_TYPES/encode.js use camelCase ("madHorse", "bigRook"). Convert
// so writeCardOneHot's CARD_POOL_INDEX lookup actually matches.
function toCamel(id) {
  return String(id).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function toDeckSlots(cardState) {
  const conv = (arr) => (arr || []).map((c) => c ? {
    effect: toCamel(c.id),
    used: Boolean(c.used),
    recovering: Boolean(c.recovering)
  } : null);
  return { white: conv(cardState?.white), black: conv(cardState?.black) };
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error("usage: acg-to-positions.mjs <file.acg>"); process.exit(1); }
  const bundleFile = process.argv[3] || "./site-engine.mjs";
  const mod = await import(bundleFile);
  const fs = require("fs");
  const text = fs.readFileSync(file, "utf8");
  const decoded = await mod.decodeAcgRecord(text, mod.acgCodecOptions());
  const { baseFrame, events } = decoded.record.replay;
  const result = decoded.record.metadata.result; // "1-0" | "0-1" | "1/2-1/2" etc.

  const state = JSON.parse(JSON.stringify(baseFrame));
  const positions = [];
  for (const event of events) {
    const isMove = (event.notations || []).some((n) => n.kind === "move");
    if (isMove) {
      positions.push({
        board: JSON.parse(JSON.stringify(state.board)),
        deckSlots: toDeckSlots(state.cardState),
        mover: event.color
      });
    }
    applyFieldDelta(state, event.delta.fields);
    applyBoardDelta(state.board, event.delta.board.cells);
  }

  let winner = null;
  if (result === "1-0") winner = "white";
  else if (result === "0-1") winner = "black";
  // else draw/other -- winner stays null

  const records = positions.map((p) => ({
    board: p.board.map((row) => row.map((cell) => cell ? { t: cell.type, c: cell.color } : null)),
    deckSlots: p.deckSlots,
    turn: p.mover,
    outcome: winner === null ? 0 : winner === p.mover ? 1 : -1
  }));

  console.log(JSON.stringify({ positionCount: records.length, winner, sample: records[0] }, null, 2));
  fs.writeFileSync(file.replace(/\.acg$/, ".positions.json"), JSON.stringify(records));
  console.log("wrote", file.replace(/\.acg$/, ".positions.json"));
}
main().catch((e) => { console.error("FAILED:", e && e.stack || e); process.exit(1); });

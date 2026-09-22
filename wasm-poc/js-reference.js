'use strict';
// JS twin of assembly/index.ts's positionalScoreCore, used as the
// "pure JS baseline" in bench.js. Kept hand-in-hand with the AS version
// so the benchmark compares the SAME algorithm, not different ones.
//
// Board encoding: flat Int32Array (or plain number[]), row-major,
// 0 = empty, +typeId = white, -typeId = black.
// typeId: 1 pawn, 2 knight, 3 bishop, 4 rook, 5 queen, 6 other/wall (skipped).

function positionalScoreCoreJS(board, rows, cols, forWhite) {
  let score = 0;
  const rowMid = (rows - 1) / 2;
  const colMid = (cols - 1) / 2;
  const rowLo = Math.floor(rowMid);
  const rowHi = Math.ceil(rowMid);
  const colLo = Math.floor(colMid);
  const colHi = Math.ceil(colMid);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = board[row * cols + col];
      if (cell === 0) continue;
      const isWhite = cell > 0;
      if (isWhite !== forWhite) continue;
      const type = isWhite ? cell : -cell;
      if (type === 6) continue;

      const center = Math.max(0, rowMid - Math.abs(row - rowMid)) +
                      Math.max(0, colMid - Math.abs(col - colMid));

      const pawnHomeRow = isWhite ? rows - 2 : 1;
      const advance = isWhite ? pawnHomeRow - row : row - pawnHomeRow;

      if (type === 1) {
        score += center * 18 + Math.max(0, advance) * 18;
      } else if (type === 2) {
        const edge = (row === 0 || row === rows - 1 ? 1 : 0) + (col === 0 || col === cols - 1 ? 1 : 0);
        score += center * 36 - edge * 35;
      } else if (type === 3) {
        const diag = Math.min(row, col, rows - 1 - row, cols - 1 - col);
        score += center * 34 + diag * 8;
      } else if (type === 4 || type === 5) {
        score += center * 12;
      } else {
        score += center * 16;
      }

      for (let ci = rowLo; ci <= rowHi; ci++) {
        for (let cj = colLo; cj <= colHi; cj++) {
          const dr = ci - row;
          const dc = cj - col;
          let attacks = false;
          if (type === 1) {
            const dir = isWhite ? -1 : 1;
            attacks = dr === dir && Math.abs(dc) === 1;
          } else if (type === 2) {
            const ar = Math.abs(dr);
            const ac = Math.abs(dc);
            attacks = (ar === 2 && ac === 1) || (ar === 1 && ac === 2);
          } else {
            attacks = dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc);
          }
          if (!attacks) continue;
          if (type === 1) score += 72;
          else if (type === 2) score += 55;
          else score += 58;
        }
      }
    }
  }
  return score;
}

module.exports = { positionalScoreCoreJS };

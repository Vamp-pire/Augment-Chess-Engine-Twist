// wasm-poc: AssemblyScript port of a simplified "positional score" core,
// modeled on engine-merged.js's positionalScore()/pieceSquareBonus()/
// centerControlBonus() (see engine-merged.js around line 16093-16158).
//
// This is a DELIBERATE SUBSET, not a 1:1 port of positionalScore:
//   - No card/campaign/racing-king/critical-piece branches (those need
//     boardState-wide lookups: isWorkerKingRole, workerHasRacingKingObjective,
//     isCritical, isSquareAttacked -- expensive and deeply coupled to the
//     live game-state object, out of scope for this speed PoC).
//   - No endgame flag (isEndgame() itself walks the whole board again and
//     depends on captures/moveCount state).
//   - Only the "standard" piece kinds get scored: pawn, knight, bishop,
//     rook/queen, matching pieceSquareBonus's default-piece branches plus
//     centerControlBonus's pawn/knight/other split.
//
// Board encoding: flat i32 array written directly into wasm linear memory
// by the caller (row-major, length = rows*cols):
//   0            = empty square
//   +typeId      = white piece of that type
//   -typeId      = black piece of that type
// typeId mapping (see js-reference.js's twin):
//   1 = pawn, 2 = knight, 3 = bishop, 4 = rook, 5 = queen, 6 = other/wall(ignored)
//
// `boardPtr` is a raw byte offset into this module's memory (not a managed
// AssemblyScript reference type). This is deliberate: the module is built
// with `--runtime stub` (no GC/allocator exports), so callers write the
// board directly into memory via a typed array view and pass the offset --
// no @assemblyscript/loader needed, and no per-call allocation.

export function positionalScoreCore(
  boardPtr: usize,
  rows: i32,
  cols: i32,
  forWhite: bool
): f64 {
  let score: f64 = 0;
  const rowMid: f64 = f64(rows - 1) / 2.0;
  const colMid: f64 = f64(cols - 1) / 2.0;

  // center squares (2x2 or 1x1 depending on parity), matches centerSquares()
  const rowLo = i32(Math.floor(rowMid));
  const rowHi = i32(Math.ceil(rowMid));
  const colLo = i32(Math.floor(colMid));
  const colHi = i32(Math.ceil(colMid));

  for (let row: i32 = 0; row < rows; row++) {
    for (let col: i32 = 0; col < cols; col++) {
      const cell = load<i32>(boardPtr + usize((row * cols + col) << 2));
      if (cell == 0) continue;
      const isWhite = cell > 0;
      if (isWhite != forWhite) continue;
      const type = isWhite ? cell : -cell;
      if (type == 6) continue; // wall / unhandled type: skip like the JS guard does

      const center: f64 = Math.max(0.0, rowMid - Math.abs(f64(row) - rowMid)) +
                           Math.max(0.0, colMid - Math.abs(f64(col) - colMid));

      const pawnHomeRow: f64 = isWhite ? f64(rows - 2) : 1.0;
      const advance: f64 = isWhite ? pawnHomeRow - f64(row) : f64(row) - pawnHomeRow;

      // pieceSquareBonus core (standard-piece branches only)
      if (type == 1) {
        score += center * 18.0 + Math.max(0.0, advance) * 18.0;
      } else if (type == 2) {
        const edge = (row == 0 || row == rows - 1 ? 1 : 0) + (col == 0 || col == cols - 1 ? 1 : 0);
        score += center * 36.0 - f64(edge) * 35.0;
      } else if (type == 3) {
        const diag = Math.min(Math.min(f64(row), f64(col)), Math.min(f64(rows - 1 - row), f64(cols - 1 - col)));
        score += center * 34.0 + diag * 8.0;
      } else if (type == 4 || type == 5) {
        score += center * 12.0;
      } else {
        score += center * 16.0;
      }

      // centerControlBonus core: does this piece attack any center square?
      // Simplified reach model (no blockers/pins, matches attacksSquare only
      // for the unobstructed cases this PoC cares about):
      //   pawn: one diagonal step forward
      //   knight: L-shape
      //   everything else (bishop/rook/queen family): same row, col, or diagonal
      for (let ci: i32 = rowLo; ci <= rowHi; ci++) {
        for (let cj: i32 = colLo; cj <= colHi; cj++) {
          const dr = ci - row;
          const dc = cj - col;
          let attacks = false;
          if (type == 1) {
            const dir = isWhite ? -1 : 1;
            attacks = dr == dir && Math.abs(f64(dc)) == 1.0;
          } else if (type == 2) {
            const ar = i32(Math.abs(f64(dr)));
            const ac = i32(Math.abs(f64(dc)));
            attacks = (ar == 2 && ac == 1) || (ar == 1 && ac == 2);
          } else {
            attacks = dr == 0 || dc == 0 || Math.abs(f64(dr)) == Math.abs(f64(dc));
          }
          if (!attacks) continue;
          if (type == 1) score += 72.0;
          else if (type == 2) score += 55.0;
          else score += 58.0;
        }
      }
    }
  }
  return score;
}

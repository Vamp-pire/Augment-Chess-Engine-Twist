// CSR-style storage for encoded positions (train.js's opt-in SPARSE_INPUT=1
// path). A full-state row is INPUT_SIZE (15237) floats but only ~100-200 of
// them are ever nonzero, so holding a whole dataset densely (N * INPUT_SIZE *
// 4 bytes -- ~17GB at 139k positions) is almost entirely zeros. A sparse set
// is { rows, offsets: Int32Array(rows + 1), indices: Int32Array(nnz),
// values: Float32Array(nnz) }: row r's active features are
// indices/values[offsets[r] .. offsets[r + 1]).

class SparseBuilder {
  constructor(initialCapacity = 1 << 16) {
    this.rows = 0;
    this.nnz = 0;
    this.offsets = [0];
    this.indices = new Int32Array(initialCapacity);
    this.values = new Float32Array(initialCapacity);
  }

  addDenseRow(dense) {
    for (let i = 0; i < dense.length; i += 1) {
      const v = dense[i];
      if (v === 0) continue;
      if (this.nnz === this.indices.length) {
        const grown = this.nnz * 2;
        const idx = new Int32Array(grown);
        idx.set(this.indices);
        this.indices = idx;
        const val = new Float32Array(grown);
        val.set(this.values);
        this.values = val;
      }
      this.indices[this.nnz] = i;
      this.values[this.nnz] = v;
      this.nnz += 1;
    }
    this.rows += 1;
    this.offsets.push(this.nnz);
  }

  finish() {
    return {
      rows: this.rows,
      offsets: Int32Array.from(this.offsets),
      indices: this.indices.slice(0, this.nnz),
      values: this.values.slice(0, this.nnz)
    };
  }
}

// Concatenate sparse sets in order (worker chunks, main file + external val file).
function sparseConcat(parts) {
  let rows = 0, nnz = 0;
  for (const p of parts) { rows += p.rows; nnz += p.indices.length; }
  const offsets = new Int32Array(rows + 1);
  const indices = new Int32Array(nnz);
  const values = new Float32Array(nnz);
  let rowCursor = 0, nnzCursor = 0;
  for (const p of parts) {
    for (let r = 1; r <= p.rows; r += 1) offsets[rowCursor + r] = nnzCursor + p.offsets[r];
    indices.set(p.indices, nnzCursor);
    values.set(p.values, nnzCursor);
    rowCursor += p.rows;
    nnzCursor += p.indices.length;
  }
  return { rows, offsets, indices, values };
}

// Scatter rows into a caller-provided zeroed dense buffer of
// rowIndices.length * inputSize floats (one minibatch/chunk at a time -- the
// whole dataset is never densified). rowIndices[k] picks the source row for
// dense row k.
function sparseDensifyInto(sp, rowIndices, count, inputSize, out) {
  for (let k = 0; k < count; k += 1) {
    const r = rowIndices[k];
    const base = k * inputSize;
    for (let j = sp.offsets[r]; j < sp.offsets[r + 1]; j += 1) out[base + sp.indices[j]] = sp.values[j];
  }
}

module.exports = { SparseBuilder, sparseConcat, sparseDensifyInto };

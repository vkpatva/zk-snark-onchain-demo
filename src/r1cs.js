/**
 * r1cs.js — R1CS (Rank-1 Constraint System) definition for the circuit x*x = y.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CIRCUIT OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 * We prove knowledge of a secret x such that x^2 = y (y is the public input).
 *
 * Witness vector w = [1, x, y]
 *   w[0] = 1   (constant term — always present in R1CS)
 *   w[1] = x   (secret: the square root)
 *   w[2] = y   (public: x^2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * R1CS: A·w ∘ B·w = C·w
 * ─────────────────────────────────────────────────────────────────────────────
 * Each row of A, B, C encodes one constraint.
 * (A·w)[i] * (B·w)[i] = (C·w)[i]  for every row i.
 *
 * We use 2 constraints (m=2) to avoid the degenerate case where m=1 leads to
 * degree-0 QAP polynomials and a trivial (broken) H polynomial:
 *
 *   Constraint 1: x * x = y
 *     A[0] = [0, 1, 0]  →  A·w = x
 *     B[0] = [0, 1, 0]  →  B·w = x
 *     C[0] = [0, 0, 1]  →  C·w = y
 *     Check: x * x = y  ✓
 *
 *   Constraint 2: y * 1 = y  (dummy identity, always satisfied)
 *     A[1] = [0, 0, 1]  →  A·w = y
 *     B[1] = [1, 0, 0]  →  B·w = 1
 *     C[1] = [0, 0, 1]  →  C·w = y
 *     Check: y * 1 = y  ✓
 *
 * With m=2, the QAP evaluation points are {1, 2}, giving degree-1 polynomials
 * for each variable column and a degree-2 target polynomial t(x)=(x-1)(x-2).
 */

import { CURVE_ORDER } from "./field.js";

// ─────────────────────────────────────────────────────────────────────────────
// R1CS matrices (rows = constraints, cols = witness variables [1, x, y])
// ─────────────────────────────────────────────────────────────────────────────

/** A matrix: A[i][j] is the coefficient of w[j] in the left factor of row i. */
export const A = [
  [0n, 1n, 0n], // Constraint 1: left  = x
  [0n, 0n, 1n], // Constraint 2: left  = y
];

/** B matrix: B[i][j] is the coefficient of w[j] in the right factor of row i. */
export const B = [
  [0n, 1n, 0n], // Constraint 1: right = x
  [1n, 0n, 0n], // Constraint 2: right = 1
];

/** C matrix: C[i][j] is the coefficient of w[j] in the output of row i. */
export const C = [
  [0n, 0n, 1n], // Constraint 1: out   = y
  [0n, 0n, 1n], // Constraint 2: out   = y
];

// ─────────────────────────────────────────────────────────────────────────────
// Witness computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full witness vector w = [1, x, y] for secret input x.
 *
 * All arithmetic is done mod r so that we stay in the scalar field Fr.
 * y = x^2 mod r is the public input (verifier knows this value).
 *
 * @param {BigInt} x  The secret square root.
 * @returns {BigInt[]} Witness [1n, x mod r, x^2 mod r]
 */
export function computeWitness(x) {
  const r = CURVE_ORDER;
  const xMod = ((x % r) + r) % r;
  const y = (xMod * xMod) % r;
  return [1n, xMod, y];
}

// ─────────────────────────────────────────────────────────────────────────────
// R1CS satisfiability check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the dot product of a matrix row and the witness vector, mod r.
 * @param {BigInt[]} row  One row of A, B, or C.
 * @param {BigInt[]} w    Witness vector.
 */
function dotProduct(row, w) {
  let acc = 0n;
  for (let j = 0; j < row.length; j++) {
    acc = (acc + row[j] * w[j]) % CURVE_ORDER;
  }
  return acc;
}

/**
 * Check that the witness w satisfies all R1CS constraints.
 *
 * For each row i: (A[i]·w) * (B[i]·w) = (C[i]·w)  mod r
 *
 * @param {BigInt[]} w  Witness vector [1, x, y].
 * @returns {boolean}   true iff all constraints are satisfied.
 */
export function checkR1CS(w) {
  const numConstraints = A.length;
  for (let i = 0; i < numConstraints; i++) {
    const aw = dotProduct(A[i], w);
    const bw = dotProduct(B[i], w);
    const cw = dotProduct(C[i], w);
    const lhs = (aw * bw) % CURVE_ORDER;
    if (lhs !== cw) {
      console.error(
        `R1CS constraint ${i} FAILED: A·w=${aw}, B·w=${bw}, C·w=${cw}, (A·w)*(B·w)=${lhs}`
      );
      return false;
    }
  }
  return true;
}

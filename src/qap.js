/**
 * qap.js — Quadratic Arithmetic Program (QAP) derived from the R1CS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THEORY: R1CS → QAP CONVERSION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Given m constraints and n variables, the R1CS specifies three m×n matrices
 * A, B, C.  The QAP "lifts" these into polynomial space via Lagrange
 * interpolation.
 *
 * 1. Choose m evaluation points: H = {1, 2, ..., m}  (in Fr)
 *
 * 2. For each variable j (column index), build three polynomials:
 *      a_j(x)  that satisfies  a_j(k) = A[k-1][j]  for k = 1..m
 *      b_j(x)  that satisfies  b_j(k) = B[k-1][j]  for k = 1..m
 *      c_j(x)  that satisfies  c_j(k) = C[k-1][j]  for k = 1..m
 *    These are degree-(m-1) polynomials uniquely determined by Lagrange interp.
 *
 * 3. Combine with witness w to get:
 *      A(x) = sum_j  w[j] * a_j(x)
 *      B(x) = sum_j  w[j] * b_j(x)
 *      C(x) = sum_j  w[j] * c_j(x)
 *    At each evaluation point k: A(k)*B(k) = C(k)  iff constraint k holds.
 *
 * 4. Target polynomial: t(x) = prod_{k=1}^{m} (x - k)  (degree m)
 *    t encodes the requirement that A(x)*B(x) - C(x) vanishes at all m points.
 *
 * 5. H polynomial (quotient): H(x) = (A(x)*B(x) - C(x)) / t(x)
 *    This division must have zero remainder iff all R1CS constraints hold.
 *    If any constraint is violated, t(x) does not divide A*B - C, so H is not
 *    a polynomial (division has non-zero remainder) → proof will be invalid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUR SETUP (m=2 constraints, n=3 variables)
 * ─────────────────────────────────────────────────────────────────────────────
 * Evaluation points: {1, 2}
 * Degree of a_j, b_j, c_j: 1  (linear polynomials, fully determined by 2 pts)
 * Degree of t(x) = (x-1)(x-2): 2
 * Degree of A(x)*B(x): at most 2
 * Degree of H(x): at most 0 (constant)
 */

import {
  CURVE_ORDER,
  fieldAdd,
  fieldMul,
  fieldSub,
} from "./field.js";
import {
  polyAdd,
  polySub,
  polyMul,
  polyScale,
  polyDiv,
  lagrangeInterpolate,
} from "./polynomial.js";

// ─────────────────────────────────────────────────────────────────────────────
// r1csToQAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert R1CS matrices to QAP polynomial sets.
 *
 * @param {BigInt[][]} A_matrix  m×n matrix of BigInt
 * @param {BigInt[][]} B_matrix  m×n matrix of BigInt
 * @param {BigInt[][]} C_matrix  m×n matrix of BigInt
 * @param {number}     numConstraints  m
 * @returns {{ aPolys, bPolys, cPolys, t }}
 *   aPolys[j] = a_j polynomial (array of BigInt coefficients, index = degree)
 *   bPolys[j] = b_j polynomial
 *   cPolys[j] = c_j polynomial
 *   t          = target polynomial t(x) = prod_{k=1}^{m}(x-k)
 */
export function r1csToQAP(A_matrix, B_matrix, C_matrix, numConstraints) {
  const m = numConstraints;
  const n = A_matrix[0].length; // number of variables

  // Evaluation points H = {1, 2, ..., m} in Fr
  const evalPoints = [];
  for (let k = 1; k <= m; k++) evalPoints.push(BigInt(k));

  // Helper: interpolate column j of a matrix
  function interpolateColumn(matrix, j) {
    // points: {x: k, y: matrix[k-1][j]} for k = 1..m
    const points = evalPoints.map((xk, idx) => ({
      x: xk,
      y: matrix[idx][j],
    }));
    return lagrangeInterpolate(points);
  }

  const aPolys = [];
  const bPolys = [];
  const cPolys = [];

  for (let j = 0; j < n; j++) {
    aPolys.push(interpolateColumn(A_matrix, j));
    bPolys.push(interpolateColumn(B_matrix, j));
    cPolys.push(interpolateColumn(C_matrix, j));
  }

  // Target polynomial: t(x) = (x-1)(x-2)...(x-m)
  // Build it by multiplying linear factors one at a time.
  let t = [1n]; // start with constant polynomial 1
  for (let k = 1; k <= m; k++) {
    // Multiply by (x - k): coefficients are [-k, 1]
    const factor = [fieldSub(0n, BigInt(k)), 1n];
    t = polyMul(t, factor);
  }

  return { aPolys, bPolys, cPolys, t };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeQAPPolynomials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the witness and the QAP polynomial families, compute A(x), B(x), C(x),
 * and the quotient H(x) = (A(x)*B(x) - C(x)) / t(x).
 *
 * @param {BigInt[]}   witness   w = [1, x, y, ...]
 * @param {BigInt[][]} aPolys    output of r1csToQAP
 * @param {BigInt[][]} bPolys
 * @param {BigInt[][]} cPolys
 * @param {BigInt[]}   t         target polynomial
 * @returns {{ Ax, Bx, Cx, Hx }}  all polynomials as coefficient arrays
 */
export function computeQAPPolynomials(witness, aPolys, bPolys, cPolys, t) {
  const n = witness.length;

  // A(x) = sum_j w[j] * a_j(x)
  let Ax = [0n];
  let Bx = [0n];
  let Cx = [0n];

  for (let j = 0; j < n; j++) {
    const wj = witness[j];
    if (wj !== 0n) {
      Ax = polyAdd(Ax, polyScale(aPolys[j], wj));
      Bx = polyAdd(Bx, polyScale(bPolys[j], wj));
      Cx = polyAdd(Cx, polyScale(cPolys[j], wj));
    }
  }

  // P(x) = A(x)*B(x) - C(x)
  // This should be divisible by t(x) iff all R1CS constraints hold.
  const ABx = polyMul(Ax, Bx);
  const Px = polySub(ABx, Cx);

  // H(x) = P(x) / t(x)  — should have zero remainder
  const [Hx, remainder] = polyDiv(Px, t);

  // Verify divisibility (sanity check — non-zero remainder means witness is wrong)
  const nonZeroRemainder = remainder.some((c) => c !== 0n);
  if (nonZeroRemainder) {
    throw new Error(
      "QAP divisibility check FAILED: remainder is non-zero. " +
        "The witness does not satisfy all R1CS constraints."
    );
  }

  return { Ax, Bx, Cx, Hx };
}

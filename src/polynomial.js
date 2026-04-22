/**
 * polynomial.js — Polynomial arithmetic over the scalar field Fr.
 *
 * A polynomial f(x) = a0 + a1*x + a2*x^2 + ... + an*x^n is represented as a
 * JavaScript array of BigInt coefficients:
 *   [a0, a1, a2, ..., an]
 * where the index equals the degree of the corresponding term.
 *
 * All arithmetic is performed mod CURVE_ORDER (the BN128 scalar field order r).
 */

import {
  CURVE_ORDER,
  fieldAdd,
  fieldSub,
  fieldMul,
  fieldInv,
  fieldDiv,
  fieldPow,
} from "./field.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Remove trailing zero coefficients (normalise degree). */
function trim(poly) {
  let i = poly.length - 1;
  while (i > 0 && poly[i] === 0n) i--;
  return poly.slice(0, i + 1);
}

// ---------------------------------------------------------------------------
// Exported polynomial operations
// ---------------------------------------------------------------------------

/**
 * Add two polynomials: (f + g)(x).
 */
export function polyAdd(f, g) {
  const len = Math.max(f.length, g.length);
  const result = [];
  for (let i = 0; i < len; i++) {
    const a = i < f.length ? f[i] : 0n;
    const b = i < g.length ? g[i] : 0n;
    result.push(fieldAdd(a, b));
  }
  return trim(result);
}

/**
 * Subtract two polynomials: (f - g)(x).
 */
export function polySub(f, g) {
  const len = Math.max(f.length, g.length);
  const result = [];
  for (let i = 0; i < len; i++) {
    const a = i < f.length ? f[i] : 0n;
    const b = i < g.length ? g[i] : 0n;
    result.push(fieldSub(a, b));
  }
  return trim(result);
}

/**
 * Multiply two polynomials: (f * g)(x).
 *
 * The degree of the product equals deg(f) + deg(g), so the output array has
 * f.length + g.length - 1 entries.
 */
export function polyMul(f, g) {
  if (f.length === 0 || g.length === 0) return [0n];
  const result = new Array(f.length + g.length - 1).fill(0n);
  for (let i = 0; i < f.length; i++) {
    for (let j = 0; j < g.length; j++) {
      result[i + j] = fieldAdd(result[i + j], fieldMul(f[i], g[j]));
    }
  }
  return trim(result);
}

/**
 * Scale a polynomial by a field element: (c * f)(x).
 */
export function polyScale(f, scalar) {
  return trim(f.map((c) => fieldMul(c, scalar)));
}

/**
 * Evaluate polynomial f at a point x using Horner's method.
 *
 * Horner's scheme: f(x) = a0 + x*(a1 + x*(a2 + ... + x*an)...)
 * This requires only n multiplications and n additions for degree-n polynomial.
 */
export function polyEval(f, x) {
  if (f.length === 0) return 0n;
  let result = 0n;
  // Iterate from highest degree to lowest
  for (let i = f.length - 1; i >= 0; i--) {
    result = fieldAdd(fieldMul(result, x), f[i]);
  }
  return result;
}

/**
 * Polynomial long division: f / g → [quotient, remainder].
 *
 * Invariant: f(x) = quotient(x) * g(x) + remainder(x)
 *            deg(remainder) < deg(g)
 *
 * Algorithm: classical long division over the field Fr.
 *   1. Align leading terms.
 *   2. Subtract suitable multiple of g from f.
 *   3. Repeat until deg(remainder) < deg(g).
 */
export function polyDiv(f, g) {
  // Work on mutable copies
  let rem = [...f].map(BigInt);
  const gDeg = g.length - 1;
  const quotDeg = rem.length - 1 - gDeg;

  if (quotDeg < 0) {
    // Dividend degree < divisor degree → quotient is 0, remainder is f
    return [[0n], trim(rem)];
  }

  const quot = new Array(quotDeg + 1).fill(0n);
  const gLead = g[gDeg]; // leading coefficient of g

  for (let i = quotDeg; i >= 0; i--) {
    // Current leading coefficient of remainder at degree i + gDeg
    const coeff = fieldDiv(rem[i + gDeg], gLead);
    quot[i] = coeff;
    // Subtract coeff * x^i * g from rem
    for (let j = 0; j <= gDeg; j++) {
      rem[i + j] = fieldSub(rem[i + j], fieldMul(coeff, g[j]));
    }
  }

  return [trim(quot), trim(rem)];
}

/**
 * Lagrange interpolation over Fr.
 *
 * Given n points [{x: xi, y: yi}], returns the unique polynomial of degree
 * < n that passes through all of them.
 *
 * Formula:
 *   L(x) = sum_{i=0}^{n-1}  y_i * l_i(x)
 *
 * where the basis polynomial l_i(x) is:
 *   l_i(x) = prod_{j != i} (x - x_j) / (x_i - x_j)
 *
 * We compute the full polynomial (not just its evaluation) by building each
 * l_i(x) as a polynomial, scaling by y_i, and summing.
 */
export function lagrangeInterpolate(points) {
  const n = points.length;
  let result = [0n]; // accumulator polynomial

  for (let i = 0; i < n; i++) {
    const xi = points[i].x;
    const yi = points[i].y;

    // Build numerator polynomial: prod_{j != i} (x - x_j)
    // (x - x_j) is the polynomial [-x_j, 1] in coefficient form
    let num = [1n]; // start with constant 1
    let denom = 1n; // scalar denominator in Fr

    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const xj = points[j].x;
      // Multiply num by (x - xj)
      num = polyMul(num, [fieldSub(0n, xj), 1n]);
      // Accumulate denominator: (xi - xj)
      denom = fieldMul(denom, fieldSub(xi, xj));
    }

    // l_i(x) = num / denom  (denom is a scalar, not a polynomial)
    const denomInv = fieldInv(denom);
    const li = polyScale(num, denomInv);

    // Add y_i * l_i(x) to result
    result = polyAdd(result, polyScale(li, yi));
  }

  return trim(result);
}

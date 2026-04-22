/**
 * field.js — Finite field arithmetic for polynomial coefficients and witness values.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH FIELD?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * In BN128 / alt_bn128 (EIP-196/197):
 *
 *   G1 coordinate field prime: q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
 *     (called "p" in EIP-196, "FIELD_PRIME" in the problem statement with p≈n nomenclature confusion)
 *   G1 group order (scalar field): n = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 *     (called "r" in many references, "FIELD_PRIME" = ...617 in the problem statement)
 *
 * For KZG to work correctly:
 *   - Polynomial coefficients MUST be in Fr = Z/nZ (the SCALAR FIELD, order n).
 *   - This is because the commitment C = f(τ)·G1 computes τ as a scalar,
 *     and scalars are reduced mod n (the group order).
 *   - If coefficients are in Fq (mod q) instead of Fr (mod n), then
 *     f(τ) computed over Fq won't equal f(τ)·G1 computed over the group.
 *
 * CONCLUSION: CURVE_ORDER in this file = n = G1 group order = ...617
 *
 * The problem statement's naming "CURVE_ORDER = r = ...583" was for a
 * context where r meant "scalar field order" — but in EIP-196 the scalar
 * field order is n = ...617, not ...583.
 *
 * We use n = ...617 throughout for polynomial/witness field arithmetic.
 */

/** G1 group order n — polynomial arithmetic and witness values live in Fn = Z/nZ */
export const CURVE_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Helper: modular reduction into [0, mod)
// ---------------------------------------------------------------------------
function mod(a, m) {
  return ((a % m) + m) % m;
}

// ---------------------------------------------------------------------------
// Basic field operations (mod CURVE_ORDER = n)
// ---------------------------------------------------------------------------

/** a + b  mod n */
export function fieldAdd(a, b) {
  return mod(a + b, CURVE_ORDER);
}

/** a - b  mod n */
export function fieldSub(a, b) {
  return mod(a - b, CURVE_ORDER);
}

/** a * b  mod n */
export function fieldMul(a, b) {
  return mod(a * b, CURVE_ORDER);
}

/**
 * a^exp mod m — square-and-multiply.
 */
export function fieldPow(base, exp, m) {
  base = mod(base, m);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, m);
    base = mod(base * base, m);
    exp >>= 1n;
  }
  return result;
}

/**
 * Modular inverse using Fermat's little theorem: a^(n-2) mod n.
 * Valid because n is prime.
 */
export function fieldInv(a) {
  a = mod(a, CURVE_ORDER);
  if (a === 0n) throw new Error("fieldInv: cannot invert zero");
  return fieldPow(a, CURVE_ORDER - 2n, CURVE_ORDER);
}

/** a / b  mod n  =  a * inv(b) mod n */
export function fieldDiv(a, b) {
  return fieldMul(a, fieldInv(b));
}

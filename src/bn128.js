/**
 * bn128.js — BN128 (alt_bn128, bn254) curve utilities.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIELD REFERENCE (EIP-196/197)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   G1 coordinate field prime: q = ...583
 *     G1 point coordinates x, y ∈ [0, q-1]
 *     Curve equation: y² = x³ + 3  over  Fq
 *     EIP-196 calls this "p". Noble: G1.CURVE.Fp.ORDER = q.
 *
 *   G1 group order (scalar field): n = ...617
 *     Scalars for G1 multiplication are in [0, n-1].
 *     This is the "CURVE_ORDER" exported from field.js.
 *     Noble: G1.CURVE.n = n.
 *     n*G1 = point at infinity.
 *
 * Polynomial coefficients are in Fn = Z/nZ (CURVE_ORDER from field.js).
 * G1 scalar reduction uses n. G1 y-negation uses q.
 */

import { bn254 } from "@noble/curves/bn254";

// G1 coordinate field prime (EIP-196 "p") — for y-negation in ecNeg
export const G1_FIELD_PRIME =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// G1 group order (scalar field order n = CURVE_ORDER from field.js) — for scalar reduction
export const G1_GROUP_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Aliases matching the problem statement's naming (even though reversed vs EIP-196)
export const FIELD_PRIME  = G1_GROUP_ORDER; // problem statement's "FIELD_PRIME"
export const CURVE_ORDER  = G1_GROUP_ORDER; // matches field.js CURVE_ORDER (= n)

/** G1 generator point */
export const G1 = { x: 1n, y: 2n };

const NobleG1Base = bn254.G1.ProjectivePoint.BASE;
const NOBLE_G1_N  = bn254.G1.CURVE.n;  // = G1_GROUP_ORDER = ...617

function nobleToAffine(pt) {
  const a = pt.toAffine();
  return { x: a.x, y: a.y };
}

/**
 * Scalar multiplication k*P on G1.
 *
 * Scalars come from field.js (mod n = ...617).
 * Noble validates scalars in [1, n-1] which matches our range.
 * No special handling needed since all coefficients are in [0, n-1].
 */
export function g1Mul(P, k) {
  k = ((k % G1_GROUP_ORDER) + G1_GROUP_ORDER) % G1_GROUP_ORDER;
  if (k === 0n) return { x: 0n, y: 0n };

  let noblePt;
  if (P.x === 1n && P.y === 2n) {
    noblePt = NobleG1Base;
  } else if (P.x === 0n && P.y === 0n) {
    return { x: 0n, y: 0n };
  } else {
    noblePt = bn254.G1.ProjectivePoint.fromAffine({ x: P.x, y: P.y });
  }

  // k is in [1, n-1] after reduction, so noble accepts it directly
  return nobleToAffine(noblePt.multiply(k));
}

/**
 * Add two G1 affine points.
 */
export function g1Add(P, Q) {
  if (P.x === 0n && P.y === 0n) return Q;
  if (Q.x === 0n && Q.y === 0n) return P;
  const np = bn254.G1.ProjectivePoint.fromAffine({ x: P.x, y: P.y });
  const nq = bn254.G1.ProjectivePoint.fromAffine({ x: Q.x, y: Q.y });
  return nobleToAffine(np.add(nq));
}

/**
 * Negate a G1 point: (x, y) → (x, q - y) where q = G1_FIELD_PRIME.
 */
export function g1Neg(P) {
  if (P.x === 0n && P.y === 0n) return P;
  return { x: P.x, y: (G1_FIELD_PRIME - P.y % G1_FIELD_PRIME) % G1_FIELD_PRIME };
}

// G2
export const G2 = bn254.G2.ProjectivePoint.BASE;
const NOBLE_G2_N = bn254.G2.CURVE.n; // = G1_GROUP_ORDER

export function g2Mul(P, k) {
  k = ((k % G1_GROUP_ORDER) + G1_GROUP_ORDER) % G1_GROUP_ORDER;
  if (k === 0n) return bn254.G2.ProjectivePoint.ZERO;
  return P.multiply(k); // k is in [1, n-1], noble accepts it
}

export function pairing(P_g1, Q_g2) {
  return bn254.pairing(P_g1, Q_g2);
}

export function fp12Eq(a, b) {
  return bn254.fields.Fp12.eql(a, b);
}

export { bn254 };

/**
 * kzg.js — KZG Polynomial Commitment Scheme over BN128.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THEORY: KZG COMMITMENT SCHEME
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Setup (trusted, one-time):
 *   Choose secret τ ∈ Fn (n = G1 group order = ...617).
 *   SRS: g1Powers[i] = τⁱ·G1 (i=0..d), tauG2 = τ·G2
 *
 * Commit:  C = f(τ)·G1 = Σᵢ aᵢ·(τⁱ·G1)
 *   where f = Σᵢ aᵢ·xⁱ with aᵢ ∈ Fn.
 *
 * Prove f(z)=y:
 *   q(x) = (f(x)-y)/(x-z)  [polynomial division in Fn[x]]
 *   π = q(τ)·G1
 *
 * Verify:  e(C - y·G1, G2) == e(π, τ·G2 - z·G2)
 *   Rearranged (avoids G2 scalar mul):
 *   e(C - y·G1 + z·π, G2) == e(π, τ·G2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIELD NOTES
 * ─────────────────────────────────────────────────────────────────────────────
 * Polynomial coefficients ∈ Fn where n = G1_GROUP_ORDER = ...617.
 * This is exported as CURVE_ORDER from field.js.
 * G1 scalar reduction also uses n.
 * G1 coordinate field prime q = ...583 is only used for ecNeg in Solidity.
 */

import { bn254 } from "@noble/curves/bn254";
import { G1, G2, g1Add, g1Mul, g2Mul, G1_GROUP_ORDER } from "./bn128.js";
import { polyEval, polyDiv } from "./polynomial.js";
import { fieldSub, CURVE_ORDER } from "./field.js";

// Scalar field order (= G1_GROUP_ORDER = n = ...617)
// CURVE_ORDER from field.js = G1_GROUP_ORDER from bn128.js (both = n = ...617)

const NobleG1 = bn254.G1.ProjectivePoint.BASE;
const NobleG1ZERO = bn254.G1.ProjectivePoint.ZERO;
const NobleG2 = bn254.G2.ProjectivePoint.BASE;

// ─────────────────────────────────────────────────────────────────────────────
// trustedSetup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the SRS for KZG.
 *
 * @param {number}  maxDegree  Maximum polynomial degree.
 * @param {BigInt}  tau        Toxic waste τ ∈ Fn (= n-modular scalar field).
 * @returns {object}  {
 *   g1Powers,    // G1 affine points: [G1, τ·G1, τ²·G1, ...]
 *   tauScalars,  // [1, τ, τ², ...] mod n
 *   g2,          // G2 base projective
 *   tauG2,       // τ·G2 projective
 *   tau,         // raw τ
 * }
 */
export function trustedSetup(maxDegree, tau) {
  tau = ((tau % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;

  const g1Powers  = [];
  const tauScalars = [];
  let tauPow = 1n;

  for (let i = 0; i <= maxDegree; i++) {
    g1Powers.push(g1Mul(G1, tauPow));
    tauScalars.push(tauPow);
    tauPow = (tauPow * tau) % CURVE_ORDER;
  }

  const tauG2 = g2Mul(NobleG2, tau);

  return { g1Powers, tauScalars, g2: NobleG2, tauG2, tau };
}

// ─────────────────────────────────────────────────────────────────────────────
// commit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KZG commitment: C = f(τ)·G1.
 *
 * C = Σᵢ aᵢ · (τⁱ·G1)  where srs.g1Powers[i] = τⁱ·G1.
 *
 * @param {BigInt[]} poly  Polynomial coefficients in Fn.
 * @param {object}   srs   Output of trustedSetup.
 * @returns {{x: BigInt, y: BigInt}}  G1 affine point.
 */
export function commit(poly, srs) {
  if (poly.length > srs.g1Powers.length) {
    throw new Error(
      `Degree ${poly.length - 1} exceeds SRS max degree ${srs.g1Powers.length - 1}`
    );
  }

  let C = { x: 0n, y: 0n }; // identity

  for (let i = 0; i < poly.length; i++) {
    const coeff = ((poly[i] % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
    if (coeff === 0n) continue;
    // coeff * τⁱ·G1: since srs.g1Powers[i] = τⁱ·G1, and coeff ∈ Fn,
    // we multiply the SRS point by coeff.
    const term = g1Mul(srs.g1Powers[i], coeff);
    C = g1Add(C, term);
  }

  return C;
}

// ─────────────────────────────────────────────────────────────────────────────
// prove
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a KZG evaluation proof: prove f(z) = y.
 *
 * @param {BigInt[]} poly  Polynomial coefficients in Fn.
 * @param {BigInt}   z     Evaluation point in Fn.
 * @param {object}   srs   Output of trustedSetup.
 * @returns {{ commitment, z, y_eval, proof }}
 */
export function prove(poly, z, srs) {
  z = ((z % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;

  const commitment = commit(poly, srs);
  const y_eval     = polyEval(poly, z);

  // q(x) = (f(x) - y) / (x - z)
  const fMinusY = [...poly];
  fMinusY[0] = fieldSub(fMinusY[0], y_eval);
  const xMinusZ = [fieldSub(0n, z), 1n]; // [-z, 1] in Fn

  const [quotient, rem] = polyDiv(fMinusY, xMinusZ);
  if (rem.some((c) => c !== 0n)) {
    throw new Error("KZG prove: non-zero remainder (bug)");
  }

  const proofPt = commit(quotient, srs);

  return { commitment, z, y_eval, proof: proofPt };
}

// ─────────────────────────────────────────────────────────────────────────────
// verify (off-chain JavaScript, using noble pairing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a KZG evaluation proof off-chain.
 *
 * Uses noble's pairing (internally consistent in noble's G1 world).
 * We re-derive the noble-world G1 points by computing f(τ) and q(τ) as
 * scalars in Fn, then multiplying noble's G1 BASE.
 *
 * Pairing check: e(C - y·G1 + z·π, G2) == e(π, τ·G2)
 *
 * @param {BigInt[]} poly      Polynomial coefficients.
 * @param {BigInt}   z         Evaluation point.
 * @param {BigInt}   y_eval    Claimed f(z).
 * @param {object}   srs       Output of trustedSetup.
 * @returns {boolean}
 */
export function verify(poly, z, y_eval, srs) {
  z      = ((z      % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;
  y_eval = ((y_eval % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;

  // Evaluate f(τ) in Fn
  const fTau = polyEval(poly, srs.tau);

  // Compute quotient and q(τ)
  const fMinusY = [...poly];
  fMinusY[0] = fieldSub(fMinusY[0], y_eval);
  const xMinusZ = [fieldSub(0n, z), 1n];
  const [quotient] = polyDiv(fMinusY, xMinusZ);
  const qTau = polyEval(quotient, srs.tau);

  // Noble G1 points: scalar × noble BASE
  // Since fTau, qTau ∈ Fn = [0, n-1], noble accepts them directly.
  const C_noble  = fTau  === 0n ? NobleG1ZERO : NobleG1.multiply(fTau);
  const pi_noble = qTau  === 0n ? NobleG1ZERO : NobleG1.multiply(qTau);
  const yG1_noble = y_eval === 0n ? NobleG1ZERO : NobleG1.multiply(y_eval);

  const CminusYG1 = C_noble.add(yG1_noble.negate());

  // z·π in noble's world
  const zPi_scalar = (z * qTau) % CURVE_ORDER;
  const zPi_noble  = zPi_scalar === 0n ? NobleG1ZERO : NobleG1.multiply(zPi_scalar);

  const lhs = CminusYG1.add(zPi_noble);

  if (pi_noble.equals(NobleG1ZERO)) {
    return lhs.equals(NobleG1ZERO);
  }

  const lhsPairing = bn254.pairing(lhs, NobleG2);
  const rhsPairing = bn254.pairing(pi_noble, srs.tauG2);

  return bn254.fields.Fp12.eql(lhsPairing, rhsPairing);
}

// ─────────────────────────────────────────────────────────────────────────────
// tauG2Affine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return τ·G2 affine coordinates in EIP-197 encoding for Solidity.
 * EIP-197: [x1 (imaginary), x0 (real), y1 (imaginary), y0 (real)]
 * Noble Fp2: {c0: real, c1: imaginary}
 */
export function tauG2Affine(srs) {
  const aff = srs.tauG2.toAffine();
  return {
    x1: aff.x.c1, // imaginary
    x0: aff.x.c0, // real
    y1: aff.y.c1,
    y0: aff.y.c0,
  };
}

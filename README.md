# zk-SNARK On-Chain Demo

A complete from-scratch ZK proof system for the circuit **x * x = y** (prover knows a secret square root x; verifier checks only the public y = x²). Built with:

- **JavaScript** (Node.js ES modules, no snarkjs/circom): prover, KZG math, field arithmetic
- **Solidity ^0.8.24** (Foundry): on-chain verifier using EIP-196/197 precompiles
- **BN128 (alt_bn128)** elliptic curve
- **KZG** polynomial commitment scheme

---

## Quick Start

```bash
# 1. Install Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. Install JS dependencies
npm install

# 3. Run JS integration tests (off-chain, all test cases)
node src/deploy_and_test.js

# 4. Build and run Foundry tests (on-chain verification)
forge test -vvv

# 5. Generate a fresh proof for any x
node src/prover.js <x>
```

---

## Math Walkthrough

### 1. Circuit → R1CS

We prove knowledge of a secret `x` such that `x² = y` (public).

**Witness vector**: `w = [1, x, y]`

A Rank-1 Constraint System encodes constraints as `(A·w) ∘ (B·w) = (C·w)` where each row is one constraint and `∘` is entry-wise multiplication.

We use **2 constraints** (m=2) to avoid a degenerate degree-0 QAP:

| Constraint | Description  | A row    | B row    | C row    |
|------------|--------------|----------|----------|----------|
| 1          | `x * x = y`  | [0, 1, 0] | [0, 1, 0] | [0, 0, 1] |
| 2          | `y * 1 = y`  | [0, 0, 1] | [1, 0, 0] | [0, 0, 1] |

Constraint 2 is a dummy identity (always satisfied) included solely to make m=2 so the QAP has non-trivial degree.

**Verification**:
- Row 1: `(A·w)[0] * (B·w)[0] = x * x = y = (C·w)[0]` ✓
- Row 2: `(A·w)[1] * (B·w)[1] = y * 1 = y = (C·w)[1]` ✓

---

### 2. R1CS → QAP (Lagrange Interpolation)

The QAP "lifts" the discrete constraint rows into polynomial space.

**Evaluation points**: `H = {1, 2}` (one per constraint).

For each column j (variable index), Lagrange-interpolate three polynomials:

```
a_j(k) = A[k-1][j]   for k = 1, 2
b_j(k) = B[k-1][j]   for k = 1, 2
c_j(k) = C[k-1][j]   for k = 1, 2
```

With m=2, each is a **degree-1 (linear) polynomial** uniquely determined by two points.

**Example** — column j=1 (the `x` variable):
```
A[0][1] = 1,  A[1][1] = 0   →  a_1(k): through (1,1) and (2,0)
                                a_1(x) = -x + 2  (mod r)
B[0][1] = 1,  B[1][1] = 0   →  b_1(x) = -x + 2  (mod r)
C[0][1] = 0,  C[1][1] = 0   →  c_1(x) = 0
```

**Target polynomial**: `t(x) = (x-1)(x-2)` — encodes the evaluation set.

---

### 3. QAP Polynomials

Combine with the witness `w = [1, x, y]`:

```
A(x) = Σⱼ w[j] · a_j(x)
B(x) = Σⱼ w[j] · b_j(x)
C(x) = Σⱼ w[j] · c_j(x)
```

**Key property**: At each evaluation point `k ∈ {1,2}`:
```
A(k) * B(k) = (Σⱼ w[j]·A[k-1][j]) * (Σⱼ w[j]·B[k-1][j])
             = (A·w)[k-1] * (B·w)[k-1]
             = (C·w)[k-1]
             = C(k)
```

This means `A(x)·B(x) - C(x)` vanishes at all m evaluation points, so it is divisible by `t(x)`:

```
H(x) = (A(x)·B(x) - C(x)) / t(x)
```

**Divisibility check**: If the division has a non-zero remainder, the witness does not satisfy all constraints — proof generation fails early.

For our example with `x=3` (witness `w = [1, 3, 9]`) and `t=7`:
```
A(x) = -3x + 6  (linear polynomial in Fr)
A(42) = -3·42 + 6 = -120 = 249  (mod r, since r - 120 + 6·... — computed mod r)
```

The quotient `H(x)` is a constant polynomial `[6]` (degree 0), since `deg(A·B)=2` and `deg(t)=2`.

---

### 4. KZG Setup (Structured Reference String)

The **trusted setup** generates the Structured Reference String (SRS) using a secret `τ` (tau, "toxic waste"):

```
SRS = { g1Powers: [G1, τ·G1, τ²·G1, ..., τᵈ·G1],
        tauG2:    τ·G2 }
```

where G1 and G2 are the generators of the two BN128 pairing groups.

**Field**: Polynomial coefficients live in the scalar field `Fᵣ` where:
```
r = G1 group order = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

All scalar arithmetic (coefficients, tau, z, y_eval) is mod r.

**G1 coordinate field**: G1 point coordinates (x, y) live in a separate field with prime:
```
q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
```

This `q` is only used for negating G1 points (ecNeg in Solidity: `y' = q - y`).

> **Demo only**: `τ = 7`. In production, tau must be secret and destroyed after the ceremony.

---

### 5. KZG Commit

Given polynomial `f(x) = a₀ + a₁x + ... + aₐxᵈ` with coefficients in `Fᵣ`:

```
C = f(τ)·G1 = Σᵢ aᵢ · (τⁱ·G1)
```

The prover computes this using the SRS (never knowing τ itself in a real ceremony — here we use it directly for the demo). The commitment `C` is a single G1 point.

For our demo (`x=3`, `w=[1,3,9]`, `τ=7`):
```
A(x) = (n-3) + 6x   where n = r  (linear polynomial mod r)
A(τ) = A(7) = (n-3) + 42 = 39   (mod r)
C = 39·G1
```

---

### 6. KZG Prove

To prove `f(z) = y_eval` at a public challenge point `z`:

1. Compute `y_eval = f(z)` (the claimed evaluation)
2. Compute the **quotient polynomial**: `q(x) = (f(x) - y_eval) / (x - z)`
   - This is exact polynomial division in `Fᵣ[x]`; zero remainder is guaranteed because `f(z) = y_eval` means `(x - z)` divides `f(x) - y_eval`
3. Compute the **opening proof**: `π = q(τ)·G1` (another G1 commitment, to the quotient)

The proof is the tuple `(C, z, y_eval, π)`.

For our demo (`z=42`):
```
y_eval = A(42) = 249
q(x) = (A(x) - 249) / (x - 42) = 6   (constant quotient)
π = 6·G1
```

---

### 7. KZG Verify (Pairing Equation)

**Standard form**:
```
e(C - y_eval·G1, G2) == e(π, τ·G2 - z·G2)
```

This is correct because:
- LHS: `e(f(τ)·G1 - y·G1, G2) = e((f(τ)-y)·G1, G2)`
- RHS: `e(q(τ)·G1, (τ-z)·G2) = e(q(τ)·G1, (τ-z)·G2)`
- By the KZG identity: `f(τ) - y = q(τ)·(τ - z)`, so both sides are equal.

**EVM-friendly rearrangement** (avoids G2 scalar multiplication, which has no EVM precompile):

Starting from `e(C - y·G1, G2) == e(π, (τ-z)·G2)`:
```
e(C - y·G1, G2) == e(π, τ·G2) · e(π, -z·G2)          (bilinearity)
e(C - y·G1, G2) · e(π, z·G2) == e(π, τ·G2)
e(C - y·G1 + z·π, G2) == e(π, τ·G2)                   (bilinearity, z·π is G1 ecMul)
```

**Final check** (two pairing check via EIP-197):
```
e(lhs, G2) · e(-π, τ·G2) == 1
  where lhs = C - y_eval·G1 + z·π
```

All operations on the left side are G1 scalar multiplications and additions — available as EVM precompiles 0x06 (ecAdd) and 0x07 (ecMul).

---

### 8. On-Chain: ecPairing Precompile

**EIP-196 precompiles**:

| Address | Operation | Input               | Output  |
|---------|-----------|---------------------|---------|
| `0x06`  | ecAdd     | [x1,y1,x2,y2] (128B) | [x,y] (64B) |
| `0x07`  | ecMul     | [x,y,scalar] (96B)   | [x,y] (64B) |
| `0x08`  | ecPairing | n×[G1,G2] (n×192B)  | [0 or 1] (32B) |

**G2 point encoding (EIP-197)**: G2 coordinates are in `Fp2 = Fp[u]/(u²+1)`. Each coordinate is encoded as `[imaginary, real]` (imaginary coefficient first):
```
x = x₀ + x₁·u  →  encoded as [x₁, x₀]
y = y₀ + y₁·u  →  encoded as [y₁, y₀]
```

**Verification flow in `verifyKZG`**:

```
Step 1: yG1     = ecMul(G1gen, y_eval)
Step 2: C_yG1   = ecAdd(commitment, ecNeg(yG1))      // C - y·G1
Step 3: zPi     = ecMul(pi, z)                        // z·π
Step 4: lhs     = ecAdd(C_yG1, zPi)                   // C - y·G1 + z·π
Step 5: result  = ecPairing(lhs, G2gen, -pi, tauG2)   // check == 1
```

**Whitelist logic**: If the pairing check returns 1 (proof valid), the caller's address is added to a `mapping(address => bool) whitelist` and a `WhitelistAdded(address)` event is emitted. This demonstrates "gated access": only provers who know a valid square root get whitelisted.

---

## File Structure

```
.
├── package.json             # Node.js dependencies (@noble/curves)
├── foundry.toml             # Foundry config (src=contracts, test=contracts/test)
├── src/
│   ├── field.js             # Scalar field Fᵣ arithmetic (mod r = ...617)
│   ├── polynomial.js        # Polynomial arithmetic over Fᵣ (add, mul, div, Lagrange)
│   ├── bn128.js             # BN128 G1/G2 wrappers around @noble/curves/bn254
│   ├── r1cs.js              # R1CS matrices A, B, C and witness for x*x=y
│   ├── qap.js               # R1CS → QAP conversion (Lagrange interp + QAP polys)
│   ├── kzg.js               # KZG: trustedSetup, commit, prove, verify, tauG2Affine
│   ├── prover.js            # CLI prover: node src/prover.js <x>
│   └── deploy_and_test.js   # End-to-end JS integration test (all test cases)
├── contracts/
│   ├── Verifier.sol         # KZGVerifier contract (ecAdd/ecMul/ecPairing + whitelist)
│   └── test/
│       └── Verifier.t.sol   # Foundry test suite (11 tests)
└── README.md
```

---

## Key Constants

| Name | Value | Role |
|------|-------|------|
| `r` (group order) | `...617` | Scalar field modulus; polynomial coefficients, tau, z |
| `q` (coord prime) | `...583` | G1 coordinate field; used only for ecNeg (`y' = q - y`) |
| `τ` (tau, demo) | `7` | Trusted setup secret (NEVER reuse in production) |
| `z` (challenge) | `42` | KZG evaluation point |

---

## Security Notes

- **Demo only**: `τ = 7` is public. Real deployments require a multi-party trusted setup ceremony where no single party knows `τ`.
- The whitelist checks KZG correctness only — it verifies the prover committed to a QAP polynomial consistent with `x² = y`. It does not enforce which `y` is committed (a full ZK-SNARK would bind the public input).
- The circuit has only 2 constraints; real circuits would have thousands, requiring much larger SRS.

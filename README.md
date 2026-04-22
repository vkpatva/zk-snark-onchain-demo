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

For our example with `x=3` (witness `w = [1, 3, 9]`):

```
Column polynomial lookup (interpolated from R1CS matrix rows):
  a₀(x) = 0                   (A col-0: 0,0 at k=1,2)
  a₁(x) = -x + 2              (A col-1: 1,0 at k=1,2)
  a₂(x) =  x - 1              (A col-2: 0,1 at k=1,2)

  b₀(x) =  x - 1              (B col-0: 0,1 at k=1,2)
  b₁(x) = -x + 2              (B col-1: 1,0 at k=1,2)
  b₂(x) = 0                   (B col-2: 0,0 at k=1,2)

  c₀(x) = 0                   (C col-0: 0,0 at k=1,2)
  c₁(x) = 0                   (C col-1: 0,0 at k=1,2)
  c₂(x) = 1                   (C col-2: 1,1 at k=1,2 → constant 1)

A(x) = 1·a₀ + 3·a₁ + 9·a₂
     = 0 + 3(-x+2) + 9(x-1)
     = -3x + 6 + 9x - 9
     = 6x - 3

B(x) = 1·b₀ + 3·b₁ + 9·b₂
     = 1·(x-1) + 3·(-x+2) + 0
     = x - 1 - 3x + 6
     = -2x + 5

C(x) = 9·c₂ = 9·1 = 9   (constant)

A(x)·B(x) = (6x-3)·(-2x+5)
           = -12x² + 30x + 6x - 15
           = -12x² + 36x - 15

A(x)·B(x) - C(x) = -12x² + 36x - 15 - 9
                  = -12x² + 36x - 24

t(x) = (x-1)(x-2) = x² - 3x + 2

H(x) = (-12x² + 36x - 24) / (x² - 3x + 2) = -12   (mod r, i.e. r - 12)
```

The quotient `H(x)` is a constant polynomial `[-12 mod r]` (degree 0), since `deg(A·B) = 2 = deg(t)`.

---

### 4. KZG Setup (Structured Reference String)

**Problem it solves**: The verifier needs to check that a polynomial was evaluated at `τ` without ever knowing `τ`. The SRS bakes `τ` into elliptic curve points that can be computed *with* but not *from* — you can't extract `τ` back from `τ·G1` due to the discrete log problem.

The **trusted setup** generates the Structured Reference String (SRS) using a secret `τ` (tau, "toxic waste"):

```
SRS = { g1Powers: [G1, τ·G1, τ²·G1, ..., τᵈ·G1],
        tauG2:    τ·G2 }
```

where G1 and G2 are the generators of the two BN128 pairing groups.

**Our demo** (`τ = 7`, SRS degree = 4):
```
g1Powers[0] =  1·G1  =  G1      (τ⁰ = 1)
g1Powers[1] =  7·G1             (τ¹ = 7)
g1Powers[2] = 49·G1             (τ² = 49)
g1Powers[3] = 343·G1            (τ³ = 343)
g1Powers[4] = 2401·G1           (τ⁴ = 2401)
tauG2       =  7·G2
```

In a real ceremony, many parties each contribute a random factor so no single person knows the full `τ`. Here we use it directly for the demo.

**Understanding the two primes: `r` and `q`**

BN128 has two completely separate prime numbers that govern two different things. They look similar but play entirely different roles:

```
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617  (ends ...617)
q = 21888242871839275222246405745257275088696311157297823662689037894645226208583  (ends ...583)
```

**`r` — the scalar field order (group order)**

`r` is the number of distinct points in the G1 group — the group's "size". When you multiply a point by a scalar, the scalar is always reduced mod `r`:

```
r · G1 = point at infinity   (going all the way around the group wraps back to identity)
(r+1) · G1 = G1              (same as multiplying by 1)
```

`r` is used for: polynomial coefficients, witness values, τ, z, y_eval — everything that is a "scalar" multiplied against a curve point. All arithmetic in `field.js` is mod `r`.

**`q` — the coordinate field prime**

`q` is the prime for the actual `(x, y)` coordinates of points sitting on the curve. Every G1 point has coordinates that are integers in `[0, q-1]`. The G1 curve equation is:

```
y² = x³ + 3   (mod q)
```

`q` appears in only one place in this codebase: point negation (`ecNeg`). To negate a point you flip its y-coordinate: `y' = q - y`. The x-coordinate stays the same.

**`G1` — the generator point**

```
G1 = (x=1, y=2)
```

This is the fixed starting point on the BN128 curve defined by the standard. You can verify it satisfies the curve equation:

```
y² mod q = 4
x³ + 3   = 1 + 3 = 4   ✓
```

From G1 you can reach every other point in the group by repeated addition: `2·G1`, `3·G1`, ..., `(r-1)·G1`, `r·G1 = ∞`.

**How scalar multiplication `k·G1` actually works**

`k·G1` does NOT mean multiplying the coordinates by `k`. It means adding the point to itself `k` times using the elliptic curve point addition formula. For two distinct points P, Q:

```
Point addition (P ≠ Q):
  λ = (Qy - Py) / (Qx - Px)   mod q     ← all coordinate arithmetic is mod q
  Rx = λ² - Px - Qx            mod q
  Ry = λ(Px - Rx) - Py         mod q

Point doubling (P = Q):
  λ = 3·Px² / (2·Py)           mod q
  Rx = λ² - 2·Px               mod q
  Ry = λ(Px - Rx) - Py         mod q
```

In practice `k·G1` is computed with the double-and-add algorithm (like binary exponentiation). Example: `39·G1` for our commitment `C`:

```
39 in binary = 100111

bit 1 (LSB): accumulator = G1,    doubler = 2·G1
bit 1:       accumulator = 3·G1,  doubler = 4·G1
bit 1:       accumulator = 7·G1,  doubler = 8·G1
bit 0:       accumulator = 7·G1,  doubler = 16·G1
bit 0:       accumulator = 7·G1,  doubler = 32·G1
bit 1 (MSB): accumulator = 39·G1  ✓

Result — 39·G1 = (
  x: 12231734685659393914320260566447712574192421431051443092223777906741357260966,
  y: 17727947864982905001040320444642043959882380122793290910937606141681385178793
)
```

That large y value is an ordinary integer in `[0, q-1]` — the output of running the point doubling/addition formulas 6 times, all arithmetic mod `q`. This is the commitment `C = A(τ)·G1 = 39·G1` for our demo with `x=3`, `τ=7`.

**Summary**

| Name | Value ends in | Role | Arithmetic mod |
|------|--------------|------|----------------|
| `r`  | `...617` | Scalar field: polynomial coefficients, τ, z, y_eval | `r` |
| `q`  | `...583` | Coordinate field: G1 point (x, y) values, point negation | `q` |
| `G1` | `(1, 2)` | Fixed generator point on the BN128 curve | — |
| `k·G1` | big `(x,y)` | k additions of G1 using point doubling/addition formulas | coords mod `q`, scalar mod `r` |

> **Demo only**: `τ = 7`. In production, tau must be secret and destroyed after the ceremony.

---

### 5. KZG Commit

**Problem it solves**: The prover needs to "lock in" their polynomial `A(x)` before seeing the challenge `z`. The commitment is like a sealed envelope — it binds the prover to one specific polynomial without revealing it.

**The trick**: Evaluate the polynomial *at `τ` on the curve* using the SRS, without ever knowing `τ` directly.

For polynomial `f(x) = a₀ + a₁x + a₂x²`:
```
C = a₀·G1  +  a₁·(τ·G1)  +  a₂·(τ²·G1)
  = a₀·g1Powers[0]  +  a₁·g1Powers[1]  +  a₂·g1Powers[2]
  = (a₀ + a₁τ + a₂τ²)·G1
  = f(τ)·G1
```

The prover uses only the SRS points — never `τ` itself. The result is a single G1 point `C`.

**General formula**:
```
C = f(τ)·G1 = Σᵢ aᵢ · (τⁱ·G1)
```

**Our demo** (`x=3`, `w=[1,3,9]`, `τ=7`):
```
A(x) = 6x - 3   (derived in Section 3)
     = -3·x⁰  +  6·x¹
       a₀=-3       a₁=6

C = (-3)·g1Powers[0]  +  6·g1Powers[1]
  = (-3)·G1  +  6·(7·G1)
  = (-3 + 42)·G1
  = 39·G1
```

`C = 39·G1` is published. The verifier knows the prover committed to *some* polynomial that evaluates to `39` at `τ` (in scalar terms), but does not know the polynomial itself.

---

### 6. KZG Prove (Opening)

**Problem it solves**: The prover now claims "my committed polynomial evaluates to `249` at point `z=42`". How do you prove this without revealing the polynomial?

**Where does `z = 42` come from?**

In this demo `z = 42` is a hardcoded constant chosen arbitrarily — it has no relation to `τ = 7`. In a real interactive protocol the verifier picks a uniformly random `z ∈ Fᵣ` *after* seeing `C`, so the prover cannot cheat. In a non-interactive (Fiat-Shamir) setting `z` is derived as a hash of the commitment: `z = Hash(C)`. The smart contract does **not** generate `z` — the prover supplies it as part of the `Proof` struct and the contract only checks the pairing equation.

**The algebraic trick**: If `f(z) = y` is true, then `f(x) - y` has a root at `x = z`, which means `(x - z)` divides it exactly with zero remainder. The quotient polynomial `q(x) = (f(x) - y) / (x - z)` is the proof. If the prover lied about `y`, the division has a remainder and they cannot produce a valid `q(x)`.

**Steps**:
1. Compute `y_eval = f(z)` (the claimed evaluation)
2. Compute the quotient: `q(x) = (f(x) - y_eval) / (x - z)` — exact division in `Fᵣ[x]`
3. Commit to the quotient: `π = q(τ)·G1` (same SRS trick as Step 5)

The proof sent to the verifier is the tuple `(C, z, y_eval, π)`.

**Our demo** (`τ=7`, `z=42`):
```
y_eval = A(42) = 6·42 - 3 = 252 - 3 = 249

q(x) = (A(x) - 249) / (x - 42)
     = (6x - 3 - 249) / (x - 42)
     = (6x - 252) / (x - 42)
     = 6·(x - 42) / (x - 42)
     = 6   (constant polynomial)

π = q(τ)·G1 = q(7)·G1 = 6·G1
```

Note how `τ=7` and `z=42` play completely different roles on the same polynomial:
- `A(τ) = A(7) = 39` → builds the **commitment** `C = 39·G1` (Step 5, before `z` is known)
- `A(z) = A(42) = 249` → the **evaluation claim** `y_eval` opened here

---

### 7. KZG Verify (Pairing Equation)

**Problem it solves**: The verifier has `(C, z, y_eval, π)` — all curve points or field elements. They need to confirm the prover is honest without knowing `τ` or the polynomial itself.

**The pairing tool**: A pairing `e(P, Q)` is a bilinear map `G1 × G2 → GT`. Bilinearity means:
```
e(a·P, Q) = e(P, a·Q) = e(P,Q)^a
e(P + R, Q) = e(P,Q) · e(R,Q)
```

**The core identity being checked** (pure algebra):
```
f(τ) - y = q(τ) · (τ - z)
```

This follows directly from `q(x) = (f(x) - y) / (x - z)` evaluated at `x = τ`. The verifier wants to confirm this holds, but only has curve points — not the raw scalars.

**Standard pairing form**:
```
e(C - y_eval·G1,  G2)  ==  e(π,  τ·G2 - z·G2)

LHS = e((f(τ) - y)·G1, G2)   = e(G1, G2)^[f(τ)-y]
RHS = e(q(τ)·G1, (τ-z)·G2)  = e(G1, G2)^[q(τ)·(τ-z)]

Both sides equal iff  f(τ) - y = q(τ)·(τ-z)  ✓
```

**EVM problem**: The EVM has no precompile for G2 scalar multiplication, so `τ·G2 - z·G2 = (τ-z)·G2` cannot be computed on-chain cheaply. The contract stores `τ·G2` from the constructor but has no way to compute `z·G2` without a G2 scalar mul precompile.

**Fix — rearrange to move `z` from G2 side to G1 side** using bilinearity:
```
e(C - y·G1, G2) == e(π, τ·G2) · e(π, -z·G2)     (split RHS)
e(C - y·G1, G2) · e(π, z·G2) == e(π, τ·G2)       (move to LHS)
e(C - y·G1 + z·π, G2) == e(π, τ·G2)              (merge: z·π is just G1 ecMul)
```

Now `z·π` is a G1 scalar multiplication — cheap, available as precompile `0x07`. The contract only needs `τ·G2` (stored at deploy time) and never does G2 scalar mul at runtime.

**Final on-chain check** (EIP-197 two-pairing form):
```
e(lhs, G2) · e(-π, τ·G2) == 1
  where lhs = C - y_eval·G1 + z·π
```

**Full numeric verification** with our demo values:
```
C      = 39·G1
y_eval = 249,   so  y_eval·G1 = 249·G1
z      = 42,    π  = 6·G1,    so  z·π = 42·(6·G1) = 252·G1

lhs = 39·G1 - 249·G1 + 252·G1 = (39 - 249 + 252)·G1 = 42·G1

Check:
  e(42·G1, G2) == e(6·G1, 7·G2)
  e(G1,G2)^42  == e(G1,G2)^(6·7)
  e(G1,G2)^42  == e(G1,G2)^42   ✓
```

If the pairing check returns 1, the contract whitelists `msg.sender`. The verifier never learned `x=3` — only that the prover knows *some* `x` whose QAP polynomial commits and opens consistently.

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

### 9. What Is Actually Sent to the Blockchain

#### At deploy time (constructor args)

The deployer sends `τ·G2` — the trusted setup point — as four `uint256` values:

```
TAU_G2_X1 = 18551411094430470096460536606940536822990217226529861227533666875800903099477
TAU_G2_X0 = 15512671280233143720612069991584289591749188907863576513414377951116606878472
TAU_G2_Y1 =  1711576522631428957817575436337311654689480489843856945284031697403898093784
TAU_G2_Y0 = 13376798835316611669264291046140500151806347092962367781523498857425536295743
```

These are the coordinates of `7·G2` on the BN128 G2 curve, encoded in EIP-197 Fp2 format (`[imaginary, real]`). This is the only thing the verifier needs from the trusted setup — it never stores `τ` itself.

#### At proof time (calldata to `verifyKZG`)

The prover sends a single `Proof` struct — 4 fields, all derived from `A(x)` only:

```
Proof {
  commitment: G1Point {               // C = A(τ)·G1 = 39·G1
    x: 12231734685659393914320260566447712574192421431051443092223777906741357260966,
    y: 17727947864982905001040320444642043959882380122793290910937606141681385178793
  },
  z:      42,                         // evaluation challenge point
  y_eval: 249,                        // A(42) = 249  (the claimed opening value)
  pi: G1Point {                       // π = q(τ)·G1 = 6·G1
    x: 4503322228978077916651710446042370109107355802721800704639343137502100212473,
    y: 6132642251294427119375180147349983541569387941788025780665104001559216576968
  }
}
```

That is it — **4 values** total. No B, C, H, t, or witness ever touch the blockchain.

#### Why are B, C, H and t(x) not sent?

This is the most important design point. The contract does **not** verify the full QAP relation `A·B - C = H·t`. It only verifies that the prover's committed polynomial opens correctly at `z`. Here is why that is sufficient and why the other polynomials are not needed:

| Object | What it is | Who uses it | Sent on-chain? |
|--------|-----------|-------------|----------------|
| `A(x)` | QAP left polynomial (witness × a-column-polys) | Prover: commits to it. Contract: verifies the opening. | Only as commitment `C` and proof `π` (G1 points) |
| `B(x)` | QAP right polynomial | JS prover only — used to compute `H(x)` | No |
| `C(x)` | QAP output polynomial | JS prover only — used to compute `H(x)` | No |
| `H(x)` | Quotient `(A·B-C)/t` | JS prover only — proves QAP divisibility off-chain | No |
| `t(x)` | Target polynomial `(x-1)(x-2)` | JS prover only | No — not even stored in the contract |
| `z`    | KZG challenge point | Both — prover chooses it, contract uses it in pairing | Yes (as `uint256`) |
| `y_eval` | `A(z)` — claimed evaluation | Both | Yes (as `uint256`) |

#### Where is t(x) in the smart contract?

**`t(x)` is not in the smart contract at all.** The divisibility check `A(x)·B(x) - C(x) = H(x)·t(x)` happens entirely in JavaScript (`qap.js`) before proof generation. If the witness is invalid, `polyDiv` throws an error and the prover never produces a proof. The contract trusts that a valid KZG opening of `A(x)` is sufficient evidence — this is an intentional simplification of a full Groth16/PLONK proof system.

In a complete ZK-SNARK (e.g. Groth16), the contract would verify all three polynomials A, B, C together via three pairings. Here we verify only `A(x)` as a demonstration of the KZG mechanics.

#### Full data flow summary

```
JavaScript (off-chain)                    Blockchain (on-chain)
──────────────────────────────────────    ────────────────────────────────
1. Compute witness w = [1, x, y]
2. Build A(x), B(x), C(x) from QAP
3. Check A·B - C divisible by t(x)   ← this check happens HERE, not on-chain
4. C = A(τ)·G1          (commit)
5. y_eval = A(z)         (evaluate)
6. q(x) = (A(x)-y)/（x-z) (quotient)
7. π = q(τ)·G1           (open)
                                          Deploy: send τ·G2 (4 uint256s)
                                          Call verifyKZG(C, z, y_eval, π)
                                            Step 1: y·G1 = ecMul(G1, y_eval)
                                            Step 2: C - y·G1 = ecAdd(C, -y·G1)
                                            Step 3: z·π = ecMul(π, z)
                                            Step 4: lhs = C - y·G1 + z·π
                                            Step 5: e(lhs, G2) == e(π, τ·G2)?
                                            Step 6: if yes → whitelist msg.sender
```

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

## Smart Contract Constants Explained

The contract has two categories of constants: ones fixed by the BN128 curve standard (you look them up, you cannot derive them), and one that is computed from the trusted setup.

### `FIELD_PRIME` — the G1 coordinate field prime `q`

```solidity
uint256 constant FIELD_PRIME =
    21888242871839275222246405745257275088696311157297823662689037894645226208583;
```

This is `q` (ends `...583`) — the prime that defines the field in which G1 point coordinates live. Every `(x, y)` coordinate of every G1 point is an integer in `[0, q-1]`. It appears in exactly one place in the contract: `ecNeg`, where negating a G1 point flips y to `q - y`. The x-coordinate is unchanged.

**Source**: Fixed by the BN128 curve definition. Standardised in EIP-196. Cannot be computed — it is a chosen curve parameter.

---

### `G1X = 1`, `G1Y = 2` — the G1 generator

```solidity
uint256 constant G1X = 1;
uint256 constant G1Y = 2;
```

The G1 generator point `(1, 2)`. Every scalar multiplication in the contract (`ecMul(G1gen, scalar)`) starts from this point. You can verify it sits on the BN128 curve:

```
Curve equation: y² = x³ + 3  mod q
Check: 2² = 4,   1³ + 3 = 4   ✓
```

**Source**: Fixed by the BN128 standard. Chosen so the generator has a clean representation.

---

### `G2_X1, G2_X0, G2_Y1, G2_Y0` — the G2 generator

```solidity
G2_X1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634
G2_X0 = 10857046999023057135944570762232829481370756359578518086990519993285655852781
G2_Y1 =  4082367875863433681332203403145435568316851327593401208105741076214120093531
G2_Y0 =  8495653923123431417604973247489272438418190587263600148770280649306958101930
```

**Why four numbers for one point?**

G2 lives on a twisted curve defined over `Fp2` — an extension field where every element is a pair: `a = a₀ + a₁·u` where `u² = -1` (think of it like complex numbers, but mod a prime). Because each coordinate (x and y) is an `Fp2` element, each coordinate needs two numbers: a real part and an imaginary part.

```
G2.x = G2_X0  +  G2_X1·u      (real part  +  imaginary part·u)
G2.y = G2_Y0  +  G2_Y1·u
```

**EIP-197 encoding — imaginary first**: The precompile expects coordinates in the order `[imaginary, real]`, so `X1` (imaginary) comes before `X0` (real) in the byte layout sent to `ecPairing` at address `0x08`.

**Source**: Fixed by the BN128/EIP-197 standard. These are the standardised G2 generator coordinates the same way `(1, 2)` is the standardised G1 generator. You look them up from the EIP, you do not compute them.

---

### `TAU_G2_X1, TAU_G2_X0, TAU_G2_Y1, TAU_G2_Y0` — the trusted setup point

```solidity
uint256 public TAU_G2_X1;  // 18551411094430470096460536606940536822990217226529861227533666875800903099477
uint256 public TAU_G2_X0;  // 15512671280233143720612069991584289591749188907863576513414377951116606878472
uint256 public TAU_G2_Y1;  //  1711576522631428957817575436337311654689480489843856945284031697403898093784
uint256 public TAU_G2_Y0;  // 13376798835316611669264291046140500151806347092962367781523498857425536295743
```

These are `τ·G2` — the G2 generator multiplied by the trusted setup secret `τ = 7`. Unlike the constants above, **these are computed** by the JS trusted setup and passed in as constructor arguments at deploy time:

```js
// kzg.js — trustedSetup()
const tauG2 = g2Mul(G2, tau);         // 7 · G2  (G2 scalar multiplication)

// kzg.js — tauG2Affine()
// Extract Fp2 coordinates in EIP-197 order (imaginary first):
x1 = tauG2.toAffine().x.c1   // imaginary part of x  →  TAU_G2_X1
x0 = tauG2.toAffine().x.c0   // real part of x       →  TAU_G2_X0
y1 = tauG2.toAffine().y.c1   // imaginary part of y  →  TAU_G2_Y1
y0 = tauG2.toAffine().y.c0   // real part of y       →  TAU_G2_Y0
```

The contract stores `τ·G2` so that the pairing check `e(π, τ·G2)` in `verifyKZG` has it available. The contract never stores or knows `τ` itself — only this one curve point derived from it.

**How to recompute these values yourself:**
```bash
node src/prover.js 3
# Output section "Solidity constructor args (tau*G2):" shows all four values
```

If `τ` changes (new trusted setup), you redeploy the contract with new constructor args. The G2 generator constants above never change.

---

### Constant vs storage — why the split?

| Constant | Type | Value | Why |
|----------|------|-------|-----|
| `FIELD_PRIME` | `constant` | `q = ...583` | Same for all BN128 deployments — never changes |
| `G1X`, `G1Y` | `constant` | `1`, `2` | Same for all BN128 deployments — never changes |
| `G2_X1/X0/Y1/Y0` | `constant` | EIP-197 G2 generator | Same for all BN128 deployments — never changes |
| `TAU_G2_*` | `public` storage | `τ·G2` | Changes per trusted setup — set in constructor |

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

---

## Limitation: Only A(x) is Verified On-Chain

This demo commits to and verifies **only** the QAP polynomial `A(x)`. The polynomials `B(x)`, `C(x)`, `H(x)`, and `t(x)` are checked entirely off-chain in JavaScript (`qap.js`) and never touch the contract.

This means the on-chain whitelist proves:
> "The prover knows a polynomial that opens correctly at z=42"

But does **not** prove:
> "The prover knows a secret x such that x² = y"

A malicious prover could commit to any arbitrary polynomial and still get whitelisted, as long as they can open it at `z`. The QAP constraint `A(x)·B(x) - C(x) = H(x)·t(x)` is enforced only by the JavaScript prover, not by the contract.

### What a real ZK-SNARK (Groth16) would do

In a complete system, the prover sends commitments to all three polynomials and the contract checks the full QAP relation via pairings:

```
Sent on-chain:
  [A] = A(τ)·G1      (G1 commitment to A)
  [B] = B(τ)·G2      (G2 commitment to B — note: different group)
  [C] = C(τ)·G1      (G1 commitment to C)

Contract checks:
  e([A], [B]) == e([C], G2) · e([H·t], G2)

  where [H·t] = H(τ)·t(τ)·G1  (precomputed into the SRS at trusted setup)
```

This encodes `A(τ)·B(τ) = C(τ) + H(τ)·t(τ)` — which by the Schwartz-Zippel lemma implies the QAP polynomial identity holds everywhere, which implies all R1CS constraints are satisfied. Note that `t(x)` still never appears as a polynomial on-chain — only `t(τ)·G1` is baked into the SRS as a precomputed point.

This demo intentionally omits this to focus on teaching the KZG commitment mechanics. Extending it to full Groth16 would require committing to `B(x)` on G2, `C(x)` on G1, and adding a third pairing to the contract.

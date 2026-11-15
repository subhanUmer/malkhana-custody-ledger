# Member-wise Contribution Matrix

**Team:** Subhan Umer (i232054) · Fatima Naeem · Ahmed Bhatti

The owned packages below are real and separable, and each member's files and tests
are listed so the allocation can be checked against the repository.

## Summary

| Member | Owned work / packages | Evidence (files, tests, demo) | Effort & justification |
|---|---|---|---|
| **1. Subhan Umer** (i232054) | **Security architecture and access control.** `AccessControlBase` (roles, admin-count guard, system-wide pause, reentrancy guard); the `virtual`/`override` design that makes the registry the single role and pause authority; the `custodyWriter`/`courtWriter` capability split; threat model; all adversarial testing. | `contracts/AccessControlBase.sol`; the override blocks in `CustodyManager.sol` and `CourtOrders.sol`; `contracts/test/TestHandlers.sol` (4 attacker/handler contracts); `test/02-access-control.test.js` (26 tests); `test/03-attacks.test.js` (13 tests); `docs/SECURITY.md`; `docs/VIVA-DEFENCE.md` Q1, Q4, Q5. **Demo:** failure scenarios 6, 8, 9, 10 in README §4. | Heaviest single package, and deliberately assigned: this member's degree specialisation is cybersecurity, so the threat-modelling and attack construction are where their existing skill adds most. **39 of the 50 tests are theirs**, including all five attack scenarios, each built as a working attacker contract. Security is *not* wholly siloed here, see the note below. |
| **2. Fatima Naeem** | **Core contracts and custody workflow.** `EvidenceRegistry` (packed `Evidence` struct, write-once `itemHash`, rolling `custodyRoot`, append-only attachments); `CustodyManager` two-phase handover; `CourtOrders` judicial lifecycle; deployment and role wiring. | `contracts/EvidenceRegistry.sol`; `contracts/CustodyManager.sol`; `contracts/CourtOrders.sol`; `scripts/deploy.js`; `test/01-lifecycle.test.js` (6 tests, incl. state-machine and boundary validation). **Demo:** workflow steps 1, 2, 3, 5, 7 in README §4. | Owns the largest body of Solidity and the state machine that every other package depends on. The two-phase handover (custody cannot be *pushed*) and the write-once `itemHash` are this member's design decisions, and both are load-bearing security controls, which is how security work stays shared across all three of us. |
| **3. Ahmed Bhatti** | **Off-chain system, frontend and gas optimisation.** Indexer with event-driven re-index and independent custody-root verification; hand-built IPFS CIDv1; content-addressed store with verify-on-read; the full web UI; the entire gas measurement methodology and baseline contracts. | `offchain/cid.js` (self-testing against the public IPFS vector); `offchain/store.js`; `offchain/indexer.js`; `web/` (3 files); `contracts/baseline/` (3 contracts); `scripts/gas-benchmark.js`; `scripts/storage-layout.js`; `test/04-integrity.test.js` (5 tests); `docs/GAS-EVALUATION.md`. **Demo:** steps 4 and the tamper-detection curl in README §4. | Two substantial packages justify the single owner: the off-chain layer and the gas work are the *same* argument from two directions, moving the custody trail into events is simultaneously the biggest gas saving (−83.5% on `attachDocument`) and the reason the indexer must prove itself. Owning both is why the trade-off is coherent. Also owns the integrity tests that prove the off-chain copy cannot be silently edited. |

## Why security is not siloed in one member

The brief warns against assigning all security or integration work to one person.
The split here is deliberate:

- **Subhan** owns adversarial security: authorisation, privilege separation,
  reentrancy, the threat model, and attack construction.
- **Fatima** owns *preventive* security built into the data model: the
  write-once `itemHash` (defeats evidence substitution), the two-phase handover
  (defeats the unilateral custody dump), contract-issued ids and
  `block.timestamp`-only timestamps (defeat backdating). These are controls, not
  plumbing, and the member who wrote them must defend them.
- **Ahmed** owns *integrity* security at the chain↔off-chain boundary: the
  custody-root replay, divergence localisation, and verify-on-read content
  addressing.

Each member therefore has security work they can explain from first principles,
and no member can answer the whole security section alone.

## Shared tasks and each member's distinct part

| Shared task | Subhan | Fatima | Ahmed |
|---|---|---|---|
| `docs/ARCHITECTURE.md` | trust-boundary section (§6) and the inheritance rationale (§3) | contract interaction diagram and lifecycle state machine (§3, §4) | component diagram and on-chain/off-chain data map (§2, §5) |
| `docs/REPORT.md` | security and threat-model chapters | problem justification, use case, contract implementation | off-chain design, optimisation, results |
| `README.md` | security notes (§8) | demo runbook (§4) | setup, reproduction commands (§3, §5) |
| Live demo | drives the failure and attack scenarios | drives the happy-path workflow | drives the verification panel and off-chain tamper detection |

## Individual defence preparation

Each member must be able to answer, unaided, for their own package:
what it does, why it is built that way, what it would cost to remove, and what
its weakest point is. `docs/VIVA-DEFENCE.md` is organised by question rather
than by member, so all three should read it in full, but the mapping is:

- **Q1, Q4, Q5, Q13** to **Subhan** (justification, capability split, inheritance, failures)
- **Q2, Q3, Q7, Q9, Q10** to **Fatima** (deployment target, consensus, data placement, gas economics, keys)
- **Q6, Q8, Q11, Q12** to **Ahmed** (gas method, indexer trust, IPFS, retrospective)

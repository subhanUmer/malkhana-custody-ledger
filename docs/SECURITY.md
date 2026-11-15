# Security Package

## 1. Threat model

### 1.1 Assets

| # | Asset | Why it matters |
|---|---|---|
| A1 | **Integrity of the custody record** | This is what makes evidence admissible. If the record can be rewritten, the item is worthless in court. |
| A2 | **The item↔record binding** (`itemHash`) | Stops a different object being presented as the seized one. |
| A3 | **Attribution**, who held it, when | Determines whose conduct is in question when an item is damaged, lost or substituted. |
| A4 | **Availability of the record** | A record that cannot be read at trial is as bad as one that was altered. |
| A5 | **The evidence bundle** (photos, memos, PFSA report) | The supporting documentation. |

### 1.2 Actors and their authority

| Actor | Authorised to | Trust assumption |
|---|---|---|
| **Investigating Officer** (`ROLE_IO`) | register a seizure; hold and hand over | semi-trusted, may wish to conceal a procedural lapse |
| **Malkhana Officer** (`ROLE_MALKHANA`) | accept, hold, hand over, attach documents | **the primary adversary**, holds the item and, historically, the register |
| **Forensic Analyst** (`ROLE_FORENSIC`) | accept for analysis, attach report, return | semi-trusted |
| **Court** (`ROLE_COURT`) | freeze, resolve, produce, dispose | trusted within the model; the only holder of terminal powers |
| **Admin** (`ROLE_ADMIN`) | grant/revoke roles, authorise writer contracts, pause | trusted; should be a multisig in production (see §4) |
| **Defence / public** | read and verify | untrusted, and deliberately given the means to verify |
| **Indexer operator** | run the off-chain service | **untrusted**, holds no keys |

### 1.3 Trust boundaries

Three boundaries are crossed in this system, each with its own control:

1. **Wallet to contract.** Crossed by a signed transaction. Controlled by
   role-based authorisation on every state-changing function.
2. **Contract to contract.** Crossed by `CustodyManager`/`CourtOrders` calling
   `EvidenceRegistry`. Controlled by the separate `custodyWriter` and
   `courtWriter` mappings, which key on contract identity and never on caller role.
3. **Chain to off-chain service.** Crossed by events. Controlled by the rolling
   `custodyRoot`: the off-chain copy proves itself or is reported unverified.

### 1.4 Threats

| # | Threat | Asset | Actor |
|---|---|---|---|
| T1 | Substitute the physical item and update the record to match | A2 | Malkhana Officer |
| T2 | Backdate or insert a custody entry to close a gap | A1, A3 | any role holder |
| T3 | Declare a handover that never happened, shifting blame | A3 | IO or Malkhana Officer |
| T4 | Delete or reorder entries in the off-chain copy | A1 | indexer operator |
| T5 | Escalate privilege, award oneself judicial power | A1 | any role holder |
| T6 | Bypass the workflow contracts and write to the registry directly | A1 | any address or contract |
| T7 | Reentrancy via the external disposal handler | A1 | compromised third-party contract |
| T8 | Dispose of evidence to destroy it before trial | A1, A4 | malicious court key |
| T9 | Act with a role after suspension | A3 | suspended officer |
| T10 | Brick the system by removing the last admin | A4 | admin (accident or malice) |
| T11 | Denial of service via an unbounded loop or a reverting third party | A4 | external contract |
| T12 | Leak personal data onto an immutable public ledger | none | design error |

## 2. Mitigation mapping

Every row names the test that proves it. All 50 tests pass, so run `npx hardhat test`.

| Threat | Control | Where | Proving test |
|---|---|---|---|
| T1 | `itemHash` is **write-once**, no function anywhere accepts it after registration | `EvidenceRegistry` | `A1 · never lets the recorded item hash change` and `A1 · exposes no function at all that can write an item hash` |
| T1 | Evidence ids are issued by the contract; the caller cannot choose or collide with one | `registerEvidence` | `A1 · cannot re-register over an existing id` |
| T1 | Attachments are **append-only**, emitted as events, never stored, so nothing can be overwritten | `attachDocument` | `2.5 · refuses an attachment from anyone but the current holder` |
| T2 | All timestamps taken from `block.timestamp`; **no writer accepts a caller-supplied time** | all contracts | `A5 · takes every timestamp from the block, never from the caller` |
| T2 | Sequence numbers are contract-issued and chained into `custodyRoot` | `_write()` | `4 · detects an omitted custody step` |
| T3 | **Two-phase handover.** Custody stays with the sender until the receiver accepts | `CustodyManager` | `A2 · keeps the sender on record as holder until the receiver actually accepts` |
| T3 | The receiver may reject, and the rejection is attributed to them on-chain | `rejectTransfer` | `A2 · lets the accused receiver refuse, and the refusal is recorded against them` |
| T4 | Rolling `custodyRoot`, omission, alteration and reordering all diverge | `EvidenceRegistry` + indexer | `4 · detects an omitted / substituted actor / reordered trail` (3 tests) |
| T4 | Content store re-hashes every file on read; a tampered file returns HTTP 409 | `offchain/store.js` | verified live: tampered file to `409 INTEGRITY_FAILURE` |
| T5 | Only `ROLE_ADMIN` may grant any role | `AccessControlBase.grantRole` | `2.6 · refuses role grants by a non-admin, blocking self-escalation` |
| T5 | Workflow contracts have **no** writable role table, `grantRole` reverts | overrides | `2.6 · refuses role writes on the workflow contracts` |
| T6 | `applyCustody` / `applyCourtAction` gated on **contract identity**, not caller role | `custodyWriter`/`courtWriter` | `A4 · refuses direct custody writes from an unauthorized contract` and `· even from a court-roled human account` |
| T6 | A compromised workflow contract can be revoked in one call | `setCustodyWriter` | `A4 · lets the admin revoke a compromised workflow contract` |
| T7 | **Checks-Effects-Interactions**, the record is Disposed *before* the handler is called | `orderDisposal` | `A3 · completes the disposal exactly once and rejects every reentrant call` |
| T7 | `nonReentrant` guard, as an independent second control | `AccessControlBase` | same test, where the attacker is **granted `ROLE_COURT`** so authorisation cannot mask the result |
| T7 | Terminal-state check, a Disposed record refuses everything | `applyCourtAction` | `2.4 · refuses every further action once a record is disposed` |
| T8 | Disposal is restricted to `ROLE_COURT` and is the only terminal transition | `CourtOrders` | `2.3 · refuses dispute, production and disposal by a non-court role` |
| T8 | Court freeze (`Disputed`) blocks all ordinary custody movement | `applyCustody` | `1 · freezes and unfreezes a record under court order` |
| T9 | Role is re-checked at **acceptance** time, not at initiation | `_statusForReceiver` | `A2 · blocks acceptance by an officer whose role was revoked while in transit` |
| T10 | `_adminCount` guard, the last admin cannot be removed | `revokeRole` | `2.6 · refuses to remove the last admin, which would brick the system` |
| T10 | Admin handover is still possible once a second admin exists | `grantRole` | `2.6 · allows admin handover once a second admin exists` |
| T11 | **No loops anywhere.** Every function is O(1); the trail lives in events | all contracts | by construction, see `docs/GAS-EVALUATION.md` |
| T11 | External call wrapped in `try/catch`, a broken handler cannot block a court order | `orderDisposal` | `A3 · still records the disposal when the external handler reverts` |
| T11 | System-wide emergency pause, with reads left open | `AccessControlBase` | `2.7 · freezes writes across all three contracts but leaves reads open` |
| T12 | No personal data on-chain: FIR hashed to `bytes32`, officers are addresses, narrative never stored | design | see `docs/ARCHITECTURE.md` §5 |

### Input and state validation (applied throughout)

- Zero-address rejected on every address parameter (`ZeroAddress`).
- Empty `itemHash` and empty attachment digest rejected (`EmptyHash`).
- Unknown evidence id rejected on read and write (`UnknownEvidence`).
- Transfer-to-self rejected (`CannotTransferToSelf`).
- Double-pending transfer rejected (`TransferAlreadyPending`).
- Accept/reject with nothing pending rejected (`NoPendingTransfer`).
- Dispute raised twice rejected (`AlreadyDisputed`). Resolving a dispute that was never raised rejected (`NotDisputed`). Restoring a record *into* `Disputed` rejected (`CannotRestoreToDisputed`).

## 3. Test evidence

```
npx hardhat test
  1. Evidence lifecycle (normal operation) ........................  6 passing
  2. Authorization and boundary conditions (negative tests) ....... 26 passing
  3. Attack and misuse scenarios .................................. 13 passing
  4. Custody-trail integrity ......................................  5 passing
                                                                    ─────────
                                                                    50 passing
```

**26 of the 50 tests are negative tests**, since they assert that an unauthorised or
invalid action is *refused*, by the specific custom error. Five project-specific
attack scenarios (A1 to A5) are implemented as working attacker contracts in
`contracts/test/TestHandlers.sol`, not as narrative description.

A note on the reentrancy test: the attacking handler is deliberately **granted
`ROLE_COURT`** before the attack. Without that, the role check would reject it
and the test would prove nothing about the reentrancy guard. Giving the attacker
full judicial authority isolates the control actually under test.

## 4. Known limitations

These are real and we state them.

1. **The chain cannot see the physical world.** It records that officer X
   *asserted* custody at time T. It cannot confirm the sealed bag still holds the
   original pistol. The `itemHash` binds the record to a *photographed, sealed*
   item at registration, so defeating it requires substitution *before* the first
   registration, which is outside this system's reach. Tamper-evident seals and
   the existing physical process remain necessary.
2. **Key compromise equals impersonation.** If an officer's private key is
   stolen, the thief is that officer as far as the chain is concerned. Mitigating
   this needs hardware-backed keys and an out-of-band revocation process. The
   `revokeRole` path exists but someone must notice first.
3. **The admin role is powerful.** It can grant any role, authorise writer
   contracts and pause the system. The `LastAdmin` guard prevents bricking, but a
   malicious admin could grant themselves `ROLE_COURT`. **Production should make
   admin an n-of-m multisig held by separate institutions** (e.g. provincial
   police HQ, the judiciary and PFSA), so no single body can self-authorise.
   This is not implemented here and is the single largest gap.
4. **`block.timestamp` is validator-influenced.** On a PoA chain a validator can
   nudge it by a few seconds. That is far too small to matter for custody
   timelines, and on a permissioned chain the validator is a named institution,
   so the manipulation is attributable. It is not a usable backdating vector.
5. **The disposal handler is called, even if guarded.** `try/catch` plus
   `nonReentrant` plus the terminal-state check mean it cannot corrupt state, but
   a malicious handler still receives execution and could, for example, burn gas.
   The admin can unset it.
6. **Availability of the off-chain service.** If the indexer is down, the trail
   is not *lost*, since it is in the events, but it is not conveniently readable.
   Anyone can run their own indexer, and the verification logic is 40 lines.
7. **No formal verification or external audit.** The controls are argued and
   tested, not proved.
8. **The gas figures are from the Hardhat EVM.** They are comparable to each
   other under identical settings, which is what the optimisation claim needs,
   but a production chain's absolute figures will differ.

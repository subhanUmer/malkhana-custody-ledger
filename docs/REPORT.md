# Technical Report: Malkhana Custody Ledger

Blockchain Empowerment Project, Fall 2026

## 1. Problem justification

### 1.1 The existing process

A malkhana is the store room inside a police station where seized property is
kept. Under Police Rules 1934, rule 22.70, anything taken during an
investigation has to be entered in Register No. XIX and deposited there. A
Malkhana Officer, called the moharrir, holds the keys and writes the register.

Every later movement is supposed to be written in the same book. An item goes to
the Punjab Forensic Science Agency for analysis, comes back, goes to court
for production, and is finally disposed of. Each of those steps is one line in a
paper register.

That register sits inside the police station, in the custody of the same officer
who holds the evidence it describes.

### 1.2 Why that is a problem

The chain of custody is what makes a physical item admissible in court. So when
an accused claims the evidence was tampered with or swapped, the document that
answers the claim was written by the institution the claim is against.

Three things follow from this.

1. Whoever is best placed to change the record is the same person holding both the
   record and the item, which makes the custodian the adversary.
2. Nothing independently fixes the time of an entry. A line written later can go
   into an earlier space and the paper will not show it.
3. Nobody outside can check it. Access runs through the police, so a defence
   lawyer asking whether the trail they were handed is the complete trail has no
   way of answering that question except by trusting the people who wrote it.

### 1.3 Why blockchain, stated honestly

A normal database would do most of this. Put the custody log in PostgreSQL, add
append-only audit triggers and signed backups, and you get most of the
operational benefit at a fraction of the complexity. We say so here because the
opposite claim is easy to make and it is not true.

What a police-run database cannot give is the one property the problem actually
needs. A custodian must not be able to rewrite the record without anyone noticing, and
an opposing party has to be able to check it without asking that custodian's
permission first. Moving from
paper to Postgres changes the medium. It does not change who controls it, since
the database administrator works for the same organisation as the moharrir.

So the case for a chain here rests on the fact that several institutions who do
not trust each other have to share one record. Police, PFSA, prosecution,
defence and the judiciary all need it, and none of them should own it. Take that
condition away and this design collapses into an expensive database, which is
the test we would apply to any other proposed use case.

One thing we do not claim. The chain cannot see the physical world. It records
that an officer said they had custody at a given time, and tamper-evident seals
and the existing physical process are still needed.

## 2. Use case and workflows

The brief asks for at least two roles and at least three meaningful workflows.

There are four roles plus an administrator: Investigating Officer, Malkhana
Officer, Forensic Analyst at PFSA, and the Court.

There are five workflows.

| Workflow | State change |
|---|---|
| Registration of a seizure | creates the record, and the item hash becomes immutable |
| Two-phase custody handover | goes to InTransit, then to a status taken from the receiver's role; can be rejected or cancelled |
| Document attachment | append-only, current holder only |
| Judicial freeze and resolution | Disputed blocks all ordinary movement until the court lifts it |
| Production and final disposal | terminal state, and an external handler is notified |

What decentralisation buys is that the custody record survives the distrust of
every party to the case. A defence lawyer stops being a petitioner and becomes
someone who can verify. Architecture sections 1 and 6 go into this.

## 3. Architecture

Full diagrams are in `docs/ARCHITECTURE.md`. In short there are four contracts.

1. `EvidenceRegistry` holds the record itself and is the single authority for
   roles.
2. `CustodyManager` runs the two-phase handover. On the registry it is
   authorised as a custody writer only.
3. `CourtOrders` does freeze, produce and dispose. It is authorised as a court
   writer only, and it is the one contract allowed to touch a frozen or terminal
   record.
4. `AccessControlBase` is abstract. It carries the roles, the system pause and
   the reentrancy guard.

### 3.1 Inheritance, and why it is meaningful

All three working contracts need the same role checks, the same pause and the
same reentrancy guard, so that behaviour sits once in the abstract base.

Then there is the override. A plain base class would give every contract its own
role table, which means an officer would have to be granted the same role three
separate times, and three tables can drift apart. Hence `hasRole()` and
`paused()` are declared virtual, and the two workflow contracts override them in
order to read the registry instead. That leaves one role authority and one
emergency stop for the whole system.

A leftover table that still looks writable would be a trap. So `grantRole`,
`revokeRole`, `pause` and `unpause` are overridden in those contracts to revert.

### 3.2 Why the split is capability separation

The two writer authorisations are separate mappings on the registry. That is the
whole point of splitting the contracts.

`CustodyManager` handles the everyday handovers, which are the most frequent
operations, and it is structurally incapable of freezing or destroying anything.
If it were compromised tomorrow, evidence still could not be disposed of through
it, and the admin can revoke it in one call.

One test checks that the boundary is drawn on contract identity and not on
caller role. An account holding ROLE_COURT, calling `applyCourtAction` directly,
is still rejected.

## 4. Hybrid on-chain and off-chain design

### 4.1 Data placement

On the chain: evidence id, the hashed FIR number, the write-once item hash, the
current holder, status, step count, a rolling custody root and a 32-byte digest
of the evidence bundle.

Off the chain: the full custody trail, which lives in events, the bundle files
themselves, and the full IPFS CIDv1 string, which is recomputed from the digest.

Nowhere at all: names, CNICs, complainant details, case narrative. An immutable
ledger is the worst possible home for personal data, because you cannot delete
it afterwards.

### 4.2 The off-chain component

`offchain/indexer.js` subscribes to the registry events, rebuilds each record's
timeline, serves a REST API and hosts the frontend. `offchain/store.js` is a
content-addressed file store, meaning each file is named by its own hash.
`offchain/cid.js` builds real IPFS CIDv1 identifiers by hand, and it checks
itself against the published test vector for the string "hello world".

### 4.3 How trust and integrity are handled

Our indexer is not trusted. It holds no keys and cannot write anything to the
chain. What backs up the data it serves is a rolling hash kept on the chain:

```
custodyRoot[n] = keccak256(abi.encode(custodyRoot[n-1], id, actor,
                                      newHolder, newStatus, action, timestamp))
```

The indexer replays every event and recomputes that chain. If a step is left
out, altered or put in the wrong order, the recomputed value stops matching, and
the API then answers `verified: false` and names the first step where the two
diverged. `test/04-integrity.test.js` proves all three detections. Our interface
shows the on-chain root and the replayed root next to each other.

Our content store works on the same idea, since every file is re-hashed when it
is read, so a file that was altered on disk comes back as HTTP 409 and not as
data.

### 4.4 Failure conditions

If the chain is unreachable the API reports `degraded: true` and serves the last
good index with that flag set. If events were missed the record is served as
UNVERIFIED. If a file is lost the record still verifies and `bundle.held` is
false, since the digest on the chain is unaffected. If a file is altered the read
returns 409. If the disposal handler reverts the court order is still recorded
and `DisposalNotificationFailed` is emitted. An attempt to remove the last admin
reverts with `LastAdmin`.

## 5. Gas measurement and optimisation

The generated sheet is `docs/GAS-EVALUATION.md`.

### 5.1 Method, and the trap we avoided

Our optimised design makes cross-contract calls, and those calls cost extra gas.
Measuring it against one large single contract would therefore have compared
architectures instead of optimisations, and it would have flattered us for a
reason that has nothing to do with the work.

So the baseline copies the optimised architecture and call graph exactly, under
the same compiler settings, which are solc 0.8.28 with the optimiser on, 200
runs and evmVersion paris. Only four patterns differ between them. Every figure
below is the mean of five runs on five separate records.

### 5.2 Results

| Operation | Baseline | Optimised | Change |
|---|---:|---:|---:|
| `registerEvidence` | 507,082 | 175,836 | −65.32% |
| `initiateTransfer` | 261,565 | 81,445 | −68.86% |
| `acceptTransfer` | 196,011 | 56,668 | −71.08% |
| handover, both phases | 457,576 | 138,113 | −69.81% |
| `attachDocument` | 178,724 | 29,489 | −83.50% |
| `EvidenceRegistry` deployment | 1,754,440 | 1,350,129 | −23.04% |

Storage layout can be checked with `scripts/storage-layout.js`. Evidence went
from 10 slots to 6, Pending from 3 slots to 1, and CustodyEntry from 6 stored
slots per step down to none, since it is an event now.

### 5.3 Which change actually did it

Optimisations 2 and 3 account for nearly all of the saving. Both remove storage
writes, and a cold storage slot costs 20,000 gas, so nothing else is close.

Struct packing is real but smaller, worth roughly 80,000 gas on registration.

Custom errors do almost nothing on the success path. Their honest evidence is
the 23.04% drop in deployment cost and not the per-operation figures. Saying all
four contributed equally would be false.

### 5.4 Trade-offs accepted

Field order in the Evidence struct is load-bearing now, so reordering the
declaration silently adds two slots. Our trail depends on the indexer now, which
is why the custody root exists. A block explorer shows a digest where it used to
show a readable CID. Custom errors need the ABI in order to decode into a name,
where a require string is readable in any raw trace.

## 6. Security

The full package is `docs/SECURITY.md`. It covers five assets, seven actors,
three trust boundaries and twelve threats, and every threat is mapped to a
control and to a named test.

Controls applied are role-based authorisation on every writer, capability
separation through two writer mappings, checks-effects-interactions together
with a separate reentrancy guard on the only external call, a write-once item
hash, contract-issued ids and timestamps, the two-phase handover, enforcement of
frozen and terminal states, a system-wide pause that leaves reads open, the last
admin guard, a try/catch around the external handler, and no loops anywhere.

Five attack scenarios are written as working attacker contracts and not as
description. They are evidence substitution, the unilateral custody dump,
reentrancy through a compromised disposal handler, workflow bypass, and
backdating.

One of those is worth a note. Our attacking handler is deliberately given
ROLE_COURT before the attack runs, because without it the role check would stop
the handler at the door and the test would then prove nothing at all about the
reentrancy guard it was written to exercise.

## 7. Test results

```
npx hardhat test

  1. Evidence lifecycle (normal operation) ........................  6 passing
  2. Authorisation and boundary conditions (negative tests) ....... 26 passing
  3. Attack and misuse scenarios .................................. 13 passing
  4. Custody-trail integrity ......................................  5 passing
                                                                    ---------
                                                                    50 passing
```

26 of the 50 are negative tests, meaning they assert that something is refused
with a specific named error. Normal, boundary and failure cases are all covered.

We checked the off-chain side by hand as well. A file was uploaded, retrieved,
tampered with on disk and then requested again, and that second request came
back 409 INTEGRITY_FAILURE. A missing file returns 404. Opening the frontend in
a browser rendered both the record detail and the timeline with no console
errors.

## 8. Limitations

`docs/SECURITY.md` section 4 has the full list. The ones that matter most:

Our chain records assertions and not reality, so it cannot confirm that a sealed
bag still holds the original item.

Key management is unsolved here. Whoever holds an officer's key is that officer
as far as the chain is concerned.

Admin is a single powerful key and it could grant itself ROLE_COURT. In
production that should be an n-of-m multisig held by separate institutions, and
the fact that it is not one here is the largest real gap in the design.

There is no formal verification and no external audit. Gas figures come from the
Hardhat EVM, so they are valid for comparison but not as absolute costs. No
audited access-control library was used, which was deliberate so that the
inheritance work is ours, although OpenZeppelin would be the safer choice in
production.

## 9. Deployment target and consensus

The development chain is the Hardhat Network on chain id 31337. It auto-mines,
so it has no consensus mechanism at all. We state that plainly because it is a
development convenience and dressing it up would not survive a question.

Production would be a permissioned EVM chain, specifically Hyperledger Besu
running QBFT, which is a Byzantine fault tolerant form of Proof of Authority.
Four reasons.

1. Finality is immediate and deterministic. A court cannot rest a ruling on a
   block that will probably not be reverted.
2. Validators are institutions that are already accountable, so the Sybil costs
   that PoW and PoS pay for are wasted here.
3. There is no token and no mining economics.
4. Safety holds at the familiar 3f + 1 bound from the Byzantine Generals
   problem.

A sensible validator set would be the provincial police headquarters, PFSA, the
National Police Bureau and a judicial node.

## 10. Member-wise workload justification

`docs/CONTRIBUTION-MATRIX.md` has the full matrix, the shared-task split and the
per-member viva mapping.

Subhan owns the security architecture and all adversarial testing,
which is 39 of the 50 tests. Fatima owns the core contracts and the custody
state machine, including two controls that are load-bearing for security. Ahmed
owns the off-chain system, the frontend and the whole gas methodology including
the baseline contracts. Security work is spread across all three of us on
purpose, so that no single member can answer the security section alone.

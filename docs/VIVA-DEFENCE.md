# Viva defence: expected questions and honest answers

Ordered roughly by how likely they are to be asked first.


## Q1. "Does this *really* need a blockchain?"

**The honest starting point: mostly, no.** A PostgreSQL table with append-only
audit triggers, write-ahead logging and signed WORM backups would deliver about
80% of what this system does, at a fraction of the complexity. Anyone who claims
otherwise is overselling. Say that first, because it buys credibility for the rest.

**What a database cannot give you is this one property:**

> In malkhana, the custodian *is* the adversary.

Register No. XIX is a paper book kept by the Malkhana Officer, inside the police
station, alongside the evidence. When an accused alleges tampering, the record
offered to rebut the allegation was written and is held by the very institution
accused of the tampering. A police-run database changes the medium, not the
problem, since the DBA works for the same organisation as the custodian.

So the requirement is not "store a log". It is: **a custody record that the
custodian cannot silently rewrite and that the defence can verify without the
custodian's permission.** That needs (a) writes that are authenticated per-actor
and ordered by someone other than the police, and (b) read access that does not
route through the police.

**The honest test, so when would I say "use a database"?** If one organisation
owns the whole process end to end and nobody downstream needs to distrust it,
use a database. Blockchain earns its place here only because several
mutually-distrusting institutions, meaning police, PFSA, prosecution, defence
and judiciary, must share one record that none of them controls. Drop that
condition and the design collapses into an expensive database.


## Q2. "Can you use Ethereum for this?"

Separate two things: **Ethereum the technology** from **Ethereum mainnet the
public network**.

**Mainnet: no.** Three blocking reasons.
1. **Cost in real money.** Gas is paid in ETH at market price. A provincial
   police force cannot budget custody entries against a volatile asset.
2. **Publicity.** Everything on mainnet is public forever. Even with FIR numbers
   hashed, transaction graphs and timing leak case activity, so when evidence moved,
   how often, in which cases.
3. **Jurisdiction.** Criminal evidence records for Pakistani courts should not
   have their canonical ordering decided by an anonymous global validator set.

**EVM-as-technology: yes, and that is what this project uses.** We wrote
Solidity, so the contracts are portable to any EVM chain. Production deployment
would be a **permissioned EVM chain, Hyperledger Besu**, with validator nodes
run by named institutions. Same contracts, same tooling, same ABI. Only the
network underneath changes.

Our development chain is the **Hardhat Network** (chainId 31337). It is a
development convenience, see Q3.


## Q3. "What consensus mechanism does your system use?"

**Be upfront: our development chain does not have one.** The Hardhat Network
auto-mines one block per transaction with a single sealer. There is no
agreement problem because there is one node. Saying "we use PoW" or "we use PoS"
here would be wrong, and it is the kind of claim that invites a follow-up you
cannot answer.

**For production: QBFT (or IBFT 2.0), a Byzantine-fault-tolerant Proof of
Authority family.** Reasons, in order of weight:

1. **Immediate finality.** This is the decisive one. PoW gives probabilistic
   finality; Ethereum PoS gives economic finality after roughly 13 minutes. A
   court cannot rest a ruling on "this block is *very unlikely* to be reverted".
   QBFT commits a block with **immediate, deterministic finality**, so once
   committed, it is final, with no reorg possible by construction.
2. **Validators are known institutions, so Sybil resistance is free.** PoW burns
   electricity and PoS locks capital purely to make identity expensive. In a
   consortium the identities are already established and legally accountable, so
   both costs are pure waste.
3. **No token, no mining cost.** Gas still exists as a metering and DoS bound,
   but the gas price is set to zero. Nobody buys ETH to log a custody transfer.
4. **It is Byzantine fault tolerant, and the bound is one from our syllabus.**
   QBFT tolerates `f` faulty validators out of **`3f + 1`** total, which is the same
   Byzantine Generals bound from Lecture 4. With 4 validators it survives 1
   malicious or crashed node; with 7, two.

**Suggested validator set** (one institution per validator keeps the fault
assumption meaningful): Punjab Police HQ, Sindh Police HQ, PFSA, the National
Police Bureau, and a judicial/registrar node. Seven validators tolerate two
compromised institutions.

**Follow-up you should expect, "isn't PoA centralised?"** Yes, deliberately.
PoA trades open participation for finality and throughput. That trade is correct
here because the participants are *supposed* to be a known, accountable set, and
you do not want anonymous validators ordering criminal evidence records. In this
design the decentralisation sits at the institutional layer and not at the
consensus layer. No single institution controls the record. One police force
cannot rewrite history, because the judiciary and PFSA nodes would not accept
the block.


## Q4. "Why three contracts? Isn't that just splitting files?"

The brief warns about exactly that, so the answer is about **capability
separation**, not file count.

The registry authorises workflow contracts through two *separate* mappings:

- `CustodyManager` is a **`custodyWriter`** only. It handles the high-frequency
  day-to-day handovers, and it is structurally incapable of freezing or
  disposing of evidence. If it were compromised tomorrow, evidence still could
  not be destroyed through it.
- `CourtOrders` is a **`courtWriter`** only. It holds the dangerous powers and
  is the only contract that can touch a frozen or terminal record.
- `EvidenceRegistry` holds the record and the role authority, and outlives both.

A test proves the separation: a `ROLE_COURT` *human account* calling
`applyCourtAction` directly is still rejected, because authorisation is on
**contract identity**, not caller role.


## Q5. "Where is the inheritance, and why is it meaningful?"

`AccessControlBase` is abstract and inherited by all three contracts. It carries
role checks, the emergency pause and the reentrancy guard, behaviour all three
genuinely need.

The meaningful part is the **override**. A naive base class gives each contract
its own role table, so every officer would be granted their role three times,
with three chances to drift. So `hasRole()` and `paused()` are `virtual`, and
the two workflow contracts override them to read the registry:

```solidity
function hasRole(bytes32 role, address account) public view override returns (bool) {
    return registry.hasRole(role, account);
}
```

One role authority, one pause switch. And because a leftover writable table
would be a trap, `grantRole`, `revokeRole`, `pause` and `unpause` are overridden
to **revert** (`RolesManagedByRegistryError`). That is inheritance used to share
behaviour and redirect a hook.


## Q6. "How did you measure gas? How do I know the comparison is fair?"

This is the question where most projects fall over, so the method matters.

**The trap we avoided:** the optimised design makes cross-contract calls
(`CustodyManager` calls into `EvidenceRegistry`), and those calls *cost* extra gas. Comparing it
against a single fat baseline contract would have measured *architecture*, not
optimisation, and would have flattered us for the wrong reason.

**So the baseline mirrors the optimised architecture exactly**, with the same
contract split, same call graph, same compiler settings (0.8.28, optimiser on,
runs 200, evmVersion paris). Only four things differ: struct packing,
events-vs-storage for the trail, digest-vs-string for the CID, and custom errors
vs `require` strings.

Headline results (mean of 5 runs on 5 separate records):

| Operation | Baseline | Optimised | Change |
|---|---:|---:|---:|
| `registerEvidence` | 507,082 | 175,836 | **−65.32%** |
| handover (initiate + accept) | 457,576 | 138,113 | **−69.81%** |
| `attachDocument` | 178,724 | 29,489 | **−83.50%** |

**And be ready for "which change actually did it?"**, because claiming all four
contributed equally is false:
- Optimisations 2 and 3 dominate. Both remove `SSTORE`s at 20,000 gas per cold slot.
- Struct packing is real but smaller, 4 slots, roughly 80,000 gas on registration.
- **Custom errors contribute almost nothing on the success path.** Their honest
  evidence is the −23.04% *deployment* cost, not the per-operation figures.

Cross-checked against `hardhat-gas-reporter` independently; both agree
(`registerEvidence` min 172,419).


## Q7. "What is on-chain and what is off-chain, and why?"

On-chain: evidence id, hashed FIR, **write-once `itemHash`**, current holder,
status, step count, the rolling `custodyRoot`, and the 32-byte `cidDigest`.

Off-chain: the full custody trail (in events, rebuilt by the indexer), the
evidence bundle files, and the full IPFS CIDv1 string (recomputed from the digest).

**Nowhere at all:** officer names, CNICs, complainant details, case narrative.
The brief forbids personal data on-chain, and an immutable public ledger is the
worst possible place for it, since you cannot delete it later.


## Q8. "If the indexer is off-chain, why should I believe it?"

You should not, and the design assumes you do not.

Every custody step extends a rolling hash held **on-chain**:

```
custodyRoot[n] = keccak256(abi.encode(custodyRoot[n-1], id, actor,
                                      newHolder, newStatus, action, timestamp))
```

The indexer replays every event and recomputes that chain. If an entry is
omitted, altered or reordered, its computed root diverges from the on-chain
value, and the API returns `verified: false` with `divergedAtSeq` naming the
first bad step. All three detections are proven in `test/04-integrity.test.js`.

The indexer holds no keys and can write nothing. Anyone, the defence included,
can run their own against the same public events, and the verification logic is
about 40 lines.

**Demo this live.** The UI shows the on-chain root and the replayed root side by
side.


## Q9. "Who pays for gas?"

On a permissioned Besu chain the gas price is configured to **zero**. Gas
remains as a metering and denial-of-service bound, since it stops an unbounded
computation from hanging validators, but no one buys a token to file a custody
entry. The institutions bear their own node running costs, as they already do
for any shared system.


## Q10. "What if an officer loses their private key, or it is stolen?"

Honestly: whoever holds the key *is* that officer as far as the chain is
concerned. `revokeRole` exists, but someone has to notice first.

Production needs hardware-backed keys (smartcard or HSM), and an out-of-band
process for suspension. Key management is the weakest link in any such system
and we are not claiming to have solved it. It is listed in
`docs/SECURITY.md` §4 as a known limitation.


## Q11. "Why not use real IPFS?"

We implement genuine **CIDv1** content addressing. Our `offchain/cid.js` builds
the multihash and base32 encoding by hand and is verified against the public
`"hello world"` test vector. Files are stored under their own CID and re-hashed
on every read; a file altered on disk returns HTTP 409 and not data.

What we do not run is an IPFS *daemon* participating in the public DHT. That
would be actively wrong here, because criminal evidence bundles must not be
globally retrievable. A consortium deployment would use IPFS in **private
network mode** with the same CIDs.


## Q12. "What was hardest, and what would you do differently?"

Hardest: making the gas comparison honest. The first instinct is to benchmark
against a single fat contract, which would have produced a bigger number and
meant nothing.

What we would change, in order:
1. **Make admin an n-of-m multisig across institutions.** Currently a single
   admin key can grant `ROLE_COURT`. That is the largest real gap.
2. Add a per-case index so a trial can be pulled up by FIR without scanning.
3. Formal verification of the state machine transitions.


## Q13. "Show me a failure."

Pick any of these in the live demo:
- Connect as the Forensic Analyst and try to register evidence to `Unauthorized`.
- As a non-holder, initiate a transfer to `NotCurrentHolder`.
- Have the court freeze an item, then try to move it to `RecordFrozen`.
- Dispose an item, then try anything at all to `RecordTerminal`.
- Pause the system as admin to every write refused, every read still works.

The UI decodes the contract's own custom-error name into the transaction log, so
the examiner sees the exact revert reason, not "transaction failed".

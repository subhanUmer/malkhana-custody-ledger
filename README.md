# Malkhana Custody Ledger

A decentralized application for the chain of custody of seized evidence in
Pakistani criminal cases, the digital counterpart to **Register No. XIX** kept
under **Police Rules 1934, r. 22.70**.

Blockchain Empowerment Project · Fall 2026

| Deliverable | Where |
|---|---|
| Architecture, diagrams, trust boundaries, data map | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Gas evaluation sheet (generated) | [`docs/GAS-EVALUATION.md`](docs/GAS-EVALUATION.md) · [`docs/gas-evaluation.csv`](docs/gas-evaluation.csv) |
| Threat model, mitigations, test evidence, limitations | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Technical report | [`docs/REPORT.md`](docs/REPORT.md) |
| Contribution matrix | [`docs/CONTRIBUTION-MATRIX.md`](docs/CONTRIBUTION-MATRIX.md) |
| Viva preparation | [`docs/VIVA-DEFENCE.md`](docs/VIVA-DEFENCE.md) |


## 1. What it does

Four roles move one physical item through a custody lifecycle, and every step is
recorded in a way the custodian cannot later rewrite:

```
Investigating Officer  >>  Malkhana Officer  >>  Forensic Analyst (PFSA)  >>  Court
        seizes               stores                  analyses              disposes
```

Five workflows: **registration**, **two-phase custody handover**, **document
attachment**, **judicial freeze and resolution**, and **final disposal**.

The design point: **in malkhana, the custodian is the adversary.** Register
No. XIX is a paper book kept by the same officer whose conduct is questioned
when an item is challenged, and the defence cannot verify it. This system makes
the record one that no single party can silently alter and that anyone can
verify independently.

## 2. Requirements

- **Node.js 20+** (developed on v20.19.5) and npm
- A Chromium or Firefox browser with **MetaMask**
- No global installs needed, since Hardhat is a project dependency

Pinned versions (installed by `npm install`):

```
hardhat 2.29.2            @nomicfoundation/hardhat-ethers 3.1.3
ethers 6.17.0             @nomicfoundation/hardhat-chai-matchers 2.1.2
chai 4.5.0                @nomicfoundation/hardhat-network-helpers 1.1.2
hardhat-gas-reporter 1.0.10   express 5.3.0
solc 0.8.28 (optimizer on, runs 200, evmVersion paris)
```

## 3. Setup

```bash
cd malkhana-dapp
npm install
npx hardhat compile
npx hardhat test          # 50 tests
```

## 4. Running the demo

Three terminals.

**Terminal 1: local chain**
```bash
npx hardhat node
```
Leave it running. It prints 20 funded accounts with their private keys. These
are **public, well-known development keys**, so never use them on a real network.

**Terminal 2: deploy**
```bash
SEED=true npx hardhat run scripts/deploy.js --network localhost
```
Deploys the three contracts, wires the `custodyWriter`/`courtWriter`
authorisations, grants the four roles to accounts #1 to #4, writes
`deployments/localhost.json`, and seeds one evidence record.

**Terminal 3: off-chain indexer and web UI**
```bash
npm run indexer
```
Serves on <http://127.0.0.1:3001>. Set `PORT=<n>` if 3001 is taken.

**Browser**: open <http://127.0.0.1:3001>, then in MetaMask:

1. Add a network: RPC `http://127.0.0.1:8545`, **chain ID 31337**, symbol ETH.
2. Import the account for the role you want to act as (private keys are printed
   by `npx hardhat node`):

| Account | Role | Address |
|---|---|---|
| #0 | `ROLE_ADMIN` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| #1 | `ROLE_IO` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| #2 | `ROLE_MALKHANA` | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| #3 | `ROLE_FORENSIC` | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| #4 | `ROLE_COURT` | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |

3. Click **Connect wallet**. The header shows the roles that account holds; the
   action panel changes with the role and the record's state.

### Suggested demo sequence

| # | As | Do | What to point out |
|---|---|---|---|
| 1 | IO (#1) | Register an item, attaching a photo or memo file | Only the **32-byte digest** goes on-chain; the CID is rebuilt off-chain |
| 2 | IO (#1) | Initiate transfer to the Malkhana Officer | Status is `InTransit` but **the holder is still the IO**, so custody cannot be pushed |
| 3 | Malkhana (#2) | Accept custody | Resulting status derives from the **receiver's** role |
| 4 | Malkhana (#2) | Open the record detail | **On-chain root and replayed root shown side by side**, which is the integrity proof |
| 5 | Malkhana (#2) | Hand over to Forensic; accept as #3; attach a PFSA report | Attachments are append-only events |
| 6 | Court (#4) | Raise a dispute, then try to transfer as the holder | Fails with **`RecordFrozen`** |
| 7 | Court (#4) | Resolve the dispute, order production, then order disposal | Terminal state |
| 8 | anyone | Try any action on the disposed record | Fails with **`RecordTerminal`** |
| 9 | Admin (#0) | Pause the system | All writes refused, **reads still work** |
| 10 | any | Attempt an action your role lacks | The transaction log shows the contract's own error name, e.g. `Unauthorized` |

For the off-chain integrity failure, tamper with a stored file and re-request it:

```bash
printf 'TAMPERED' >> offchain/store/<cid>
curl -i 127.0.0.1:3001/api/file/<cid>     # HTTP 409 INTEGRITY_FAILURE
```

## 5. Reproducing the evidence

```bash
npx hardhat test                                 # 50 tests (26 negative)
npx hardhat run scripts/gas-benchmark.js         # regenerates docs/GAS-EVALUATION.md
npx hardhat run scripts/storage-layout.js        # proves the struct packing claim
REPORT_GAS=true npx hardhat test                 # independent gas-reporter cross-check
node offchain/cid.js                             # CIDv1 self-test vs public vector
```

## 6. Layout

```
contracts/
  AccessControlBase.sol      abstract: roles, pause, reentrancy guard
  EvidenceRegistry.sol       the record + the role authority
  CustodyManager.sol         two-phase handover        (custodyWriter)
  CourtOrders.sol            freeze / produce / dispose (courtWriter)
  baseline/                  unoptimized twins, for the gas comparison only
  test/TestHandlers.sol      attacker + handler contracts used by the tests
offchain/
  cid.js                     IPFS CIDv1, hand-built, self-testing
  store.js                   content-addressed store, verifies on read
  indexer.js                 event listener + verifier + REST API + web host
web/                         frontend (plain HTML + ethers.js, no build step)
scripts/
  deploy.js                  deploy, wire, grant roles, optional seed
  gas-benchmark.js           baseline vs optimized measurement
  storage-layout.js          storage slot evidence
test/                        50 tests across 4 suites
docs/                        architecture, gas, security, report, viva, matrix
```

## 7. API

| Route | Purpose |
|---|---|
| `GET /api/health` | chain reachability, last indexed block, degraded flag |
| `GET /api/config` | deployed addresses, role addresses, role hashes |
| `GET /api/evidence` | all records with status and verification verdict |
| `GET /api/evidence/:id` | one record: timeline, attachments, verification, bundle status |
| `GET /api/case/:caseId` | every item in one FIR |
| `POST /api/upload` | store a bundle (raw bytes, `X-Filename` header) to `{digest, cid}` |
| `GET /api/file/:cid` | retrieve, re-verifying content (409 if tampered) |
| `POST /api/reindex` | force a re-index |

## 8. Security notes

- The accounts above are **public development keys**. Never fund them.
- No private keys or seed phrases are committed. `.gitignore` excludes `.env`,
  `deployments/localhost.json`, `offchain/store/` and build output.
- No personal data is written on-chain. FIR numbers are hashed, officers appear
  only as addresses. See `docs/ARCHITECTURE.md` §5.

## 9. Attribution

Third-party code: **Hardhat**, **ethers.js**, **Express**, **chai**, and the
Hardhat plugin set listed in §2, used as libraries under their own licences.

Everything in `contracts/`, `offchain/`, `web/`, `scripts/`, `test/` and `docs/`
is original work for this project. No audited access-control library
(e.g. OpenZeppelin) was used, so `AccessControlBase` is written from scratch and
the inheritance and override behaviour required by criterion B is our own and
can be defended in the viva. In production, an audited library would be the
safer choice; that trade-off is stated in `docs/SECURITY.md` §4.

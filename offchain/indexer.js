/**
 * Off-chain indexer, content store API and static web host.
 *
 * Why this exists (criterion C): gas optimization 2 moved the custody trail off
 * the chain into events, and optimization 3 replaced the on-chain IPFS CID with
 * a 32-byte digest. Neither is readable from contract storage any more, so this
 * service rebuilds both - and, critically, PROVES its reconstruction by
 * replaying the rolling custody hash and comparing it to the on-chain
 * `custodyRoot`. If the two disagree the record is reported as unverifiable
 * rather than served as if it were sound.
 *
 * Trust model: this service is NOT trusted. It holds no keys and can write
 * nothing to the chain. Every figure it serves carries a verification verdict
 * that any client can recompute independently from the same public events.
 *
 * Run: node offchain/indexer.js    (after scripts/deploy.js)
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const store = require("./store");
const { cidFromDigest } = require("./cid");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT || 3001);
const NETWORK = process.env.NETWORK || "localhost";
const ROOT = path.join(__dirname, "..");

const STATUS = ["None", "Seized", "Deposited", "InTransit", "AtForensic", "InCourt", "Disposed", "Disputed"];

function loadArtifact(name) {
  const p = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadDeployment() {
  const p = path.join(ROOT, "deployments", `${NETWORK}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`no deployment found at ${p} - run scripts/deploy.js first`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Recomputes one step of the contract's rolling custody hash. */
function custodyStep(prevRoot, id, actor, newHolder, newStatus, action, at) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "uint8", "bytes32", "uint64"],
      [prevRoot, id, actor, newHolder, newStatus, action, at]
    )
  );
}

const decodeB32 = (b) => {
  try { return ethers.decodeBytes32String(b); } catch { return b; }
};

class Indexer {
  constructor() {
    this.deployment = loadDeployment();
    this.provider = new ethers.JsonRpcProvider(RPC);
    const regArt = loadArtifact("EvidenceRegistry");
    this.registry = new ethers.Contract(
      this.deployment.contracts.EvidenceRegistry, regArt.abi, this.provider);
    this.records = new Map();
    this.lastIndexedBlock = 0;
    this.chainOk = false;
    this.lastError = null;
  }

  async rebuild() {
    try {
      const head = await this.provider.getBlockNumber();

      const [registered, custody, attached] = await Promise.all([
        this.registry.queryFilter(this.registry.filters.EvidenceRegistered(), 0, head),
        this.registry.queryFilter(this.registry.filters.CustodyRecorded(), 0, head),
        this.registry.queryFilter(this.registry.filters.DocumentAttached(), 0, head),
      ]);

      const records = new Map();

      for (const e of registered) {
        const id = e.args.id.toString();
        records.set(id, {
          id: Number(e.args.id),
          caseId: decodeB32(e.args.caseId),
          caseIdRaw: e.args.caseId,
          registeredBy: e.args.registeredBy,
          itemHash: e.args.itemHash,
          cidDigest: e.args.cidDigest,
          cid: /^0x0+$/.test(e.args.cidDigest) ? null : cidFromDigest(e.args.cidDigest),
          seizedAt: Number(e.args.seizedAt),
          registeredInBlock: e.blockNumber,
          timeline: [],
          attachments: [],
        });
      }

      for (const e of custody) {
        const r = records.get(e.args.id.toString());
        if (!r) continue;
        r.timeline.push({
          seq: Number(e.args.seq),
          actor: e.args.actor,
          newHolder: e.args.newHolder,
          status: STATUS[Number(e.args.newStatus)] || String(e.args.newStatus),
          statusCode: Number(e.args.newStatus),
          action: decodeB32(e.args.action),
          actionRaw: e.args.action,
          at: Number(e.args.occurredAt),
          atISO: new Date(Number(e.args.occurredAt) * 1000).toISOString(),
          custodyRoot: e.args.custodyRoot,
          block: e.blockNumber,
          txHash: e.transactionHash,
        });
      }

      for (const e of attached) {
        const r = records.get(e.args.id.toString());
        if (!r) continue;
        const digest = e.args.cidDigest;
        r.attachments.push({
          by: e.args.by,
          docType: decodeB32(e.args.docType),
          cidDigest: digest,
          cid: cidFromDigest(digest),
          at: Number(e.args.occurredAt),
          atISO: new Date(Number(e.args.occurredAt) * 1000).toISOString(),
          content: store.statusForDigest(digest),
          txHash: e.transactionHash,
        });
      }

      // Verify every record against the chain, and record the current head state.
      for (const r of records.values()) {
        r.timeline.sort((a, b) => a.seq - b.seq);
        r.verification = await this.verify(r);
        r.bundle = store.statusForDigest(r.cidDigest);
        try {
          const onChain = await this.registry.getEvidence(r.id);
          r.current = {
            holder: onChain.holder,
            status: STATUS[Number(onChain.status)],
            statusCode: Number(onChain.status),
            custodyCount: Number(onChain.custodyCount),
            updatedAt: Number(onChain.updatedAt),
          };
        } catch (e) {
          r.current = null;
        }
      }

      this.records = records;
      this.lastIndexedBlock = head;
      this.chainOk = true;
      this.lastError = null;
      return records.size;
    } catch (e) {
      // Failure condition: the chain is unreachable. Serve the last good index
      // but mark the service degraded rather than pretending it is current.
      this.chainOk = false;
      this.lastError = e.message;
      throw e;
    }
  }

  /**
   * Replays the event stream and compares the recomputed rolling hash with the
   * on-chain custodyRoot. Also reports the first step where they diverge, so a
   * gap is localisable instead of merely detectable.
   */
  async verify(record) {
    let root = ethers.ZeroHash;
    let divergedAt = null;
    const expectedSeqs = [];

    for (const step of record.timeline) {
      root = custodyStep(root, record.id, step.actor, step.newHolder,
                         step.statusCode, step.actionRaw, step.at);
      if (divergedAt === null && root !== step.custodyRoot) divergedAt = step.seq;
      expectedSeqs.push(step.seq);
    }

    let onChainRoot = null;
    try {
      onChainRoot = await this.registry.custodyRootOf(record.id);
    } catch (e) { /* leaves onChainRoot null */ }

    // A missing sequence number means the indexer never saw a step at all.
    const gaps = [];
    for (let i = 1; i <= expectedSeqs.length; i++) {
      if (!expectedSeqs.includes(i)) gaps.push(i);
    }

    const matches = onChainRoot !== null && root === onChainRoot;
    return {
      verified: matches && gaps.length === 0,
      computedRoot: root,
      onChainRoot,
      steps: record.timeline.length,
      divergedAtSeq: divergedAt,
      missingSeqs: gaps,
      note: matches
        ? "replayed custody trail matches the on-chain root"
        : "replayed trail does NOT match the on-chain root - treat this record as unverified",
    };
  }

  watch() {
    // Event-driven: re-index whenever the registry writes anything.
    const refresh = async () => {
      try {
        const n = await this.rebuild();
        console.log(`[indexer] re-indexed ${n} record(s) @ block ${this.lastIndexedBlock}`);
      } catch (e) {
        console.error(`[indexer] re-index failed: ${e.message}`);
      }
    };
    this.registry.on("EvidenceRegistered", refresh);
    this.registry.on("CustodyRecorded", refresh);
    this.registry.on("DocumentAttached", refresh);
    console.log("[indexer] listening for registry events");
  }
}

async function main() {
  const idx = new Indexer();
  const app = express();

  app.use(express.json());

  try {
    const n = await idx.rebuild();
    console.log(`[indexer] initial backfill: ${n} record(s) @ block ${idx.lastIndexedBlock}`);
  } catch (e) {
    console.error(`[indexer] initial backfill failed: ${e.message}`);
    console.error("[indexer] is the node running and has scripts/deploy.js been run?");
  }
  idx.watch();

  // ------------------------------------------------------------------ API
  app.get("/api/health", (req, res) => {
    res.json({
      ok: idx.chainOk,
      degraded: !idx.chainOk,
      rpc: RPC,
      network: idx.deployment.network,
      chainId: idx.deployment.chainId,
      lastIndexedBlock: idx.lastIndexedBlock,
      records: idx.records.size,
      lastError: idx.lastError,
    });
  });

  app.get("/api/config", (req, res) => res.json(idx.deployment));

  app.get("/api/evidence", (req, res) => {
    const list = [...idx.records.values()].map((r) => ({
      id: r.id, caseId: r.caseId, registeredBy: r.registeredBy,
      seizedAt: r.seizedAt, current: r.current,
      verified: r.verification?.verified ?? false,
      steps: r.timeline.length, attachments: r.attachments.length,
      bundleHeld: r.bundle?.held ?? false,
    })).sort((a, b) => a.id - b.id);
    res.json({ count: list.length, degraded: !idx.chainOk, evidence: list });
  });

  app.get("/api/evidence/:id", (req, res) => {
    const r = idx.records.get(String(Number(req.params.id)));
    if (!r) return res.status(404).json({ error: "unknown evidence id" });
    res.json({ degraded: !idx.chainOk, ...r });
  });

  app.get("/api/case/:caseId", (req, res) => {
    const list = [...idx.records.values()].filter((r) => r.caseId === req.params.caseId);
    res.json({ caseId: req.params.caseId, count: list.length, evidence: list });
  });

  // Store an evidence bundle; returns the digest the caller then puts on-chain.
  app.post("/api/upload",
    express.raw({ type: "*/*", limit: "25mb" }),
    (req, res) => {
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: "empty body - send the file as raw bytes" });
      }
      const name = req.get("X-Filename") || "evidence-bundle";
      const addr = store.put(req.body, name);
      res.json({ ...addr, originalName: name,
        note: "put `digest` on-chain; the CID is recomputable from it off-chain" });
    });

  app.get("/api/file/:cid", (req, res) => {
    try {
      const buf = store.get(req.params.cid);
      const m = store.meta(req.params.cid);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition",
        `attachment; filename="${(m && m.originalName) || req.params.cid}"`);
      res.send(buf);
    } catch (e) {
      const code = e.code === "INTEGRITY_FAILURE" ? 409 : 404;
      res.status(code).json({ error: e.message, code: e.code || "NOT_FOUND" });
    }
  });

  app.post("/api/reindex", async (req, res) => {
    try {
      const n = await idx.rebuild();
      res.json({ ok: true, records: n, block: idx.lastIndexedBlock });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // ---------------------------------------------------------- static web
  // Served locally so the demo never depends on a CDN being reachable.
  app.use("/vendor", express.static(path.join(ROOT, "node_modules", "ethers", "dist")));
  app.use("/artifacts", express.static(path.join(ROOT, "artifacts")));
  app.use("/deployments", express.static(path.join(ROOT, "deployments")));
  app.use("/", express.static(path.join(ROOT, "web")));

  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`[indexer] API + web on http://127.0.0.1:${PORT}`);
  });
  server.on("error", (e) => {
    console.error(`[indexer] listen failed on port ${PORT}: ${e.code || e.message}`);
    console.error("[indexer] set PORT=<free port> and retry");
    process.exit(1);
  });
}

module.exports = { Indexer, custodyStep };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { Status, b32, deployFixture, registerItem, handover, custodyStep } = require("./helpers");

/// Replays the event stream exactly as the off-chain indexer does.
async function replay(registry, id) {
  const events = await registry.queryFilter(registry.filters.CustodyRecorded(id));
  const steps = events
    .map((e) => ({
      seq: Number(e.args.seq),
      actor: e.args.actor,
      newHolder: e.args.newHolder,
      newStatus: e.args.newStatus,
      action: e.args.action,
      at: e.args.occurredAt,
      onChainRoot: e.args.custodyRoot,
    }))
    .sort((a, b) => a.seq - b.seq);

  let root = ethers.ZeroHash;
  for (const s of steps) {
    root = custodyStep(root, id, s.actor, s.newHolder, s.newStatus, s.action, s.at);
  }
  return { steps, root };
}

describe("4. Custody-trail integrity (on-chain root vs off-chain replay)", function () {
  it("reconstructs the same custody root the contract computed", async function () {
    const { registry, custody, courtOrders, io, malkhana, forensic, court } =
      await loadFixture(deployFixture);

    const id = await registerItem(registry, io);
    await handover(custody, io, malkhana, id);
    await handover(custody, malkhana, forensic, id);
    await handover(custody, forensic, malkhana, id);
    await courtOrders.connect(court).orderProduction(id);

    const { steps, root } = await replay(registry, id);
    const onChain = await registry.custodyRootOf(id);

    expect(root).to.equal(onChain);
    expect(steps.length).to.equal(Number((await registry.getEvidence(id)).custodyCount));

    // Every intermediate root must also match, so corruption is localisable to
    // the exact step where the replay first diverges.
    let running = ethers.ZeroHash;
    for (const s of steps) {
      running = custodyStep(running, id, s.actor, s.newHolder, s.newStatus, s.action, s.at);
      expect(running, `step ${s.seq}`).to.equal(s.onChainRoot);
    }
  });

  it("detects an omitted custody step", async function () {
    const { registry, custody, io, malkhana, forensic } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);
    await handover(custody, io, malkhana, id);
    await handover(custody, malkhana, forensic, id);

    const { steps } = await replay(registry, id);
    const onChain = await registry.custodyRootOf(id);

    // Drop the middle step, as a tampered off-chain mirror would.
    const tampered = steps.filter((s) => s.seq !== 3);
    let root = ethers.ZeroHash;
    for (const s of tampered) {
      root = custodyStep(root, id, s.actor, s.newHolder, s.newStatus, s.action, s.at);
    }
    expect(root).to.not.equal(onChain);
  });

  it("detects a substituted actor in a custody step", async function () {
    const { registry, custody, io, malkhana, outsider } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);
    await handover(custody, io, malkhana, id);

    const { steps } = await replay(registry, id);
    const onChain = await registry.custodyRootOf(id);

    let root = ethers.ZeroHash;
    for (const s of steps) {
      const actor = s.seq === 2 ? outsider.address : s.actor; // forge who acted
      root = custodyStep(root, id, actor, s.newHolder, s.newStatus, s.action, s.at);
    }
    expect(root).to.not.equal(onChain);
  });

  it("detects a reordered trail", async function () {
    const { registry, custody, io, malkhana, forensic } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);
    await handover(custody, io, malkhana, id);
    await handover(custody, malkhana, forensic, id);

    const { steps } = await replay(registry, id);
    const onChain = await registry.custodyRootOf(id);

    const swapped = [...steps];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];

    let root = ethers.ZeroHash;
    for (const s of swapped) {
      root = custodyStep(root, id, s.actor, s.newHolder, s.newStatus, s.action, s.at);
    }
    expect(root).to.not.equal(onChain);
  });

  it("keeps separate trails for separate items", async function () {
    const { registry, custody, io, malkhana } = await loadFixture(deployFixture);
    const a = await registerItem(registry, io, "FIR-1", "item-a");
    const b = await registerItem(registry, io, "FIR-1", "item-b");
    await handover(custody, io, malkhana, a);

    const ra = await replay(registry, a);
    const rb = await replay(registry, b);

    expect(ra.root).to.equal(await registry.custodyRootOf(a));
    expect(rb.root).to.equal(await registry.custodyRootOf(b));
    expect(ra.root).to.not.equal(rb.root);
    expect(ra.steps.length).to.equal(3);
    expect(rb.steps.length).to.equal(1);
  });
});

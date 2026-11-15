const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { Status, ROLES, b32, deployFixture, registerItem, handover } = require("./helpers");

describe("1. Evidence lifecycle (normal operation)", function () {
  it("walks a full case: seizure -> malkhana -> forensic -> malkhana -> court -> disposal", async function () {
    const { registry, custody, courtOrders, io, malkhana, forensic, court } =
      await loadFixture(deployFixture);

    const id = await registerItem(registry, io);
    expect(id).to.equal(1n);

    let e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.Seized);
    expect(e.holder).to.equal(io.address);
    expect(e.registeredBy).to.equal(io.address);
    expect(e.custodyCount).to.equal(1n);

    // IO deposits into the malkhana
    await handover(custody, io, malkhana, id);
    e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.Deposited);
    expect(e.holder).to.equal(malkhana.address);
    expect(e.custodyCount).to.equal(3n); // init + accept

    // Malkhana releases to PFSA for analysis
    await handover(custody, malkhana, forensic, id);
    e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.AtForensic);
    expect(e.holder).to.equal(forensic.address);

    // Analyst attaches the report, then returns the item
    await expect(
      registry.connect(forensic).attachDocument(
        id, b32("PFSA_REPORT"), ethers.keccak256(ethers.toUtf8Bytes("report.pdf"))
      )
    ).to.emit(registry, "DocumentAttached");

    await handover(custody, forensic, malkhana, id);
    e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.Deposited);

    // Court orders production, then final disposal
    await courtOrders.connect(court).orderProduction(id);
    e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.InCourt);
    expect(e.holder).to.equal(court.address);

    await courtOrders.connect(court).orderDisposal(id);
    e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.Disposed);
  });

  it("keeps custody with the sender while a transfer is only pending", async function () {
    const { registry, custody, io, malkhana } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);

    await custody.connect(io).initiateTransfer(id, malkhana.address);

    const e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.InTransit);
    // The IO still physically holds the item, so the record must still say so.
    expect(e.holder).to.equal(io.address);

    const pending = await custody.pendingTransfer(id);
    expect(pending.to).to.equal(malkhana.address);
  });

  it("lets the receiver reject, returning the record to its previous state", async function () {
    const { registry, custody, io, malkhana } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);

    await custody.connect(io).initiateTransfer(id, malkhana.address);
    await expect(custody.connect(malkhana).rejectTransfer(id))
      .to.emit(custody, "TransferRejected");

    const e = await registry.getEvidence(id);
    expect(e.status).to.equal(Status.Seized);
    expect(e.holder).to.equal(io.address);
    expect((await custody.pendingTransfer(id)).to).to.equal(ethers.ZeroAddress);
  });

  it("lets the sender cancel before acceptance", async function () {
    const { registry, custody, io, malkhana } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);

    await custody.connect(io).initiateTransfer(id, malkhana.address);
    await expect(custody.connect(io).cancelTransfer(id))
      .to.emit(custody, "TransferCancelled");

    expect((await registry.getEvidence(id)).status).to.equal(Status.Seized);
  });

  it("freezes and unfreezes a record under court order", async function () {
    const { registry, custody, courtOrders, io, malkhana, court } = await loadFixture(deployFixture);
    const id = await registerItem(registry, io);
    await handover(custody, io, malkhana, id);

    await courtOrders.connect(court).raiseDispute(id, b32("TAMPER_ALLEGED"));
    expect((await registry.getEvidence(id)).status).to.equal(Status.Disputed);

    // While frozen, ordinary custody movement is refused.
    await expect(custody.connect(malkhana).initiateTransfer(id, io.address))
      .to.be.revertedWithCustomError(registry, "RecordFrozen");

    await courtOrders.connect(court).resolveDispute(id, malkhana.address, Status.Deposited);
    expect((await registry.getEvidence(id)).status).to.equal(Status.Deposited);

    // ...and movement works again afterwards.
    await custody.connect(malkhana).initiateTransfer(id, io.address);
    expect((await registry.getEvidence(id)).status).to.equal(Status.InTransit);
  });

  it("tracks several items in one case independently", async function () {
    const { registry, custody, io, malkhana } = await loadFixture(deployFixture);
    const a = await registerItem(registry, io, "FIR-115/2026", "pistol");
    const b = await registerItem(registry, io, "FIR-115/2026", "cartridge");

    expect(a).to.equal(1n);
    expect(b).to.equal(2n);

    await handover(custody, io, malkhana, a);

    expect((await registry.getEvidence(a)).status).to.equal(Status.Deposited);
    expect((await registry.getEvidence(b)).status).to.equal(Status.Seized);
    expect(await registry.evidenceCount()).to.equal(2n);
  });
});

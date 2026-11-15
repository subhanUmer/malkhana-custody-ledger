const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { Status, ROLES, b32, deployFixture, registerItem, handover } = require("./helpers");

describe("3. Attack and misuse scenarios", function () {
  // ---------------------------------------------------------------- A1
  describe("A1. Evidence substitution after deposit", function () {
    it("never lets the recorded item hash change, even by the current holder", async function () {
      const { registry, custody, courtOrders, io, malkhana, court } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io, "FIR-115/2026", "sealed-pistol-01");
      const original = (await registry.getEvidence(id)).itemHash;

      await handover(custody, io, malkhana, id);

      // The custodian attaches documents, moves the item and survives a dispute.
      await registry.connect(malkhana).attachDocument(id, b32("NOTE"), b32("cid1"));
      await registry.connect(malkhana).attachDocument(id, b32("NOTE"), b32("cid2"));
      await courtOrders.connect(court).raiseDispute(id, b32("SUBSTITUTION_ALLEGED"));
      await courtOrders.connect(court).resolveDispute(id, malkhana.address, Status.Deposited);

      expect((await registry.getEvidence(id)).itemHash).to.equal(original);
    });

    it("exposes no function at all that can write an item hash after registration", async function () {
      const { registry } = await loadFixture(deployFixture);
      const writers = registry.interface.fragments
        .filter((f) => f.type === "function" && (f.stateMutability === "nonpayable" || f.stateMutability === "payable"))
        .map((f) => f.name);

      // registerEvidence is the only writer that ever accepts an item hash.
      expect(writers).to.include("registerEvidence");
      for (const name of writers.filter((n) => n !== "registerEvidence")) {
        const frag = registry.interface.getFunction(name);
        const takesHash = frag.inputs.some((i) => /itemHash/i.test(i.name));
        expect(takesHash, `${name} must not accept an item hash`).to.equal(false);
      }
    });

    it("cannot re-register over an existing id - ids are issued by the contract, not the caller", async function () {
      const { registry, io } = await loadFixture(deployFixture);
      const a = await registerItem(registry, io, "FIR-1", "item-a");
      const b = await registerItem(registry, io, "FIR-1", "item-b");

      // The caller never supplies an id, so collision is structurally impossible.
      expect(b).to.equal(a + 1n);
      const frag = registry.interface.getFunction("registerEvidence");
      expect(frag.inputs.some((i) => /^id$/i.test(i.name))).to.equal(false);
    });
  });

  // ---------------------------------------------------------------- A2
  describe("A2. Unilateral custody dump ('I handed it over, they lost it')", function () {
    it("keeps the sender on record as holder until the receiver actually accepts", async function () {
      const { registry, custody, io, forensic } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      await custody.connect(io).initiateTransfer(id, forensic.address);

      // The IO cannot shed responsibility by merely declaring a handover.
      const e = await registry.getEvidence(id);
      expect(e.holder).to.equal(io.address);
      expect(e.status).to.equal(Status.InTransit);
    });

    it("lets the accused receiver refuse, and the refusal is recorded against them", async function () {
      const { registry, custody, io, forensic } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      await custody.connect(io).initiateTransfer(id, forensic.address);
      const tx = await custody.connect(forensic).rejectTransfer(id);
      const receipt = await tx.wait();

      // The rejection is attributable on-chain to the forensic analyst.
      const logs = receipt.logs
        .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
        .filter((l) => l && l.name === "CustodyRecorded");
      expect(logs.length).to.equal(1);
      expect(logs[0].args.actor).to.equal(forensic.address);
      expect(logs[0].args.action).to.equal(b32("TRANSFER_REJECT"));

      expect((await registry.getEvidence(id)).holder).to.equal(io.address);
    });

    it("blocks acceptance by an officer whose role was revoked while in transit", async function () {
      const { registry, custody, admin, io, forensic } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await custody.connect(io).initiateTransfer(id, forensic.address);

      // The analyst is suspended before they take the item.
      await registry.connect(admin).revokeRole(ROLES.FORENSIC, forensic.address);

      await expect(custody.connect(forensic).acceptTransfer(id))
        .to.be.revertedWithCustomError(custody, "ReceiverNotAuthorized");

      // The item is not stranded: the sender can withdraw the offer.
      await custody.connect(io).cancelTransfer(id);
      expect((await registry.getEvidence(id)).status).to.equal(Status.Seized);
    });
  });

  // ---------------------------------------------------------------- A3
  describe("A3. Reentrancy through a compromised disposal handler", function () {
    it("completes the disposal exactly once and rejects every reentrant call", async function () {
      const { registry, custody, courtOrders, admin, io, malkhana, court } =
        await loadFixture(deployFixture);

      const idA = await registerItem(registry, io, "FIR-1", "item-a");
      const idB = await registerItem(registry, io, "FIR-1", "item-b");
      await handover(custody, io, malkhana, idA);
      await handover(custody, io, malkhana, idB);

      const Attacker = await ethers.getContractFactory("ReentrantDisposalHandler");
      const attacker = await Attacker.deploy(await courtOrders.getAddress(), await registry.getAddress());
      await attacker.setOtherId(idB);

      await courtOrders.connect(admin).setDisposalHandler(await attacker.getAddress());
      // Deliberately give the attacker full judicial authority, so the role
      // check cannot be what defeats it. This isolates the reentrancy guard.
      await registry.connect(admin).grantRole(ROLES.COURT, await attacker.getAddress());

      const before = (await registry.getEvidence(idA)).custodyCount;
      await courtOrders.connect(court).orderDisposal(idA);
      const after = await registry.getEvidence(idA);

      expect(await attacker.attempts()).to.equal(1n);
      expect(await attacker.reenteredSameId()).to.equal(false);
      expect(await attacker.reenteredOtherId()).to.equal(false);
      expect(await attacker.reenteredDispute()).to.equal(false);

      // Exactly one custody step was written - no double accounting.
      expect(after.custodyCount).to.equal(before + 1n);
      expect(after.status).to.equal(Status.Disposed);

      // The second record was never touched.
      expect((await registry.getEvidence(idB)).status).to.equal(Status.Deposited);
    });

    it("still records the disposal when the external handler reverts", async function () {
      const { registry, custody, courtOrders, admin, io, malkhana, court } =
        await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await handover(custody, io, malkhana, id);

      const Broken = await ethers.getContractFactory("RevertingDisposalHandler");
      const broken = await Broken.deploy();
      await courtOrders.connect(admin).setDisposalHandler(await broken.getAddress());

      // A lawful court order must not be blocked by a third-party outage.
      await expect(courtOrders.connect(court).orderDisposal(id))
        .to.emit(courtOrders, "DisposalNotificationFailed");

      expect((await registry.getEvidence(id)).status).to.equal(Status.Disposed);
    });

    it("notifies a well-behaved handler on disposal", async function () {
      const { registry, custody, courtOrders, admin, io, malkhana, court } =
        await loadFixture(deployFixture);
      const id = await registerItem(registry, io, "FIR-115/2026", "pistol");
      await handover(custody, io, malkhana, id);

      const Good = await ethers.getContractFactory("BenignDisposalHandler");
      const good = await Good.deploy();
      await courtOrders.connect(admin).setDisposalHandler(await good.getAddress());

      await courtOrders.connect(court).orderDisposal(id);
      expect(await good.callCount()).to.equal(1n);
      expect(await good.lastEvidenceId()).to.equal(id);
      expect(await good.lastCaseId()).to.equal(b32("FIR-115/2026"));
    });
  });

  // ---------------------------------------------------------------- A4
  describe("A4. Bypassing the workflow contracts", function () {
    it("refuses direct custody writes from an unauthorized contract", async function () {
      const { registry, io, malkhana } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      const Attacker = await ethers.getContractFactory("DirectWriteAttacker");
      const attacker = await Attacker.deploy(await registry.getAddress());

      await expect(attacker.tryApplyCustody(id, malkhana.address))
        .to.be.revertedWithCustomError(registry, "NotCustodyWriter");
      await expect(attacker.tryApplyCourtAction(id, malkhana.address))
        .to.be.revertedWithCustomError(registry, "NotCourtWriter");
    });

    it("refuses direct custody writes even from a court-roled human account", async function () {
      const { registry, io, court, malkhana } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      // Holding ROLE_COURT is not the same as being the CourtOrders contract.
      await expect(
        registry.connect(court).applyCourtAction(
          id, court.address, malkhana.address, Status.Disposed, b32("FORGED")
        )
      ).to.be.revertedWithCustomError(registry, "NotCourtWriter");
    });

    it("lets the admin revoke a compromised workflow contract", async function () {
      const { registry, custody, admin, io, malkhana } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      await registry.connect(admin).setCustodyWriter(await custody.getAddress(), false);

      await expect(custody.connect(io).initiateTransfer(id, malkhana.address))
        .to.be.revertedWithCustomError(registry, "NotCustodyWriter");
    });
  });

  // ---------------------------------------------------------------- A5
  describe("A5. Backdating a custody entry", function () {
    it("takes every timestamp from the block, never from the caller", async function () {
      const { registry, io } = await loadFixture(deployFixture);

      // No state-changing function accepts a caller-supplied time.
      const writers = registry.interface.fragments.filter(
        (f) => f.type === "function" && f.stateMutability === "nonpayable"
      );
      for (const f of writers) {
        for (const inp of f.inputs) {
          expect(/time|date|at$|timestamp/i.test(inp.name),
            `${f.name} must not accept a caller-supplied timestamp (${inp.name})`).to.equal(false);
        }
      }

      const tx = await registry.connect(io).registerEvidence(b32("FIR-1"), b32("h"), b32("c"));
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const e = await registry.getEvidence(1);

      expect(e.seizedAt).to.equal(BigInt(block.timestamp));
      expect(e.updatedAt).to.equal(BigInt(block.timestamp));
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { Status, ROLES, b32, deployFixture, registerItem, handover } = require("./helpers");

describe("2. Authorization and boundary conditions (negative tests)", function () {
  describe("2.1 registration", function () {
    it("refuses registration by someone with no role", async function () {
      const { registry, outsider } = await loadFixture(deployFixture);
      await expect(
        registry.connect(outsider).registerEvidence(b32("FIR-1"), b32("h"), b32("c"))
      ).to.be.revertedWithCustomError(registry, "Unauthorized");
    });

    it("refuses registration by a Malkhana Officer - only an IO may seize", async function () {
      const { registry, malkhana } = await loadFixture(deployFixture);
      await expect(
        registry.connect(malkhana).registerEvidence(b32("FIR-1"), b32("h"), b32("c"))
      ).to.be.revertedWithCustomError(registry, "Unauthorized");
    });

    it("refuses an empty item hash", async function () {
      const { registry, io } = await loadFixture(deployFixture);
      await expect(
        registry.connect(io).registerEvidence(b32("FIR-1"), ethers.ZeroHash, b32("c"))
      ).to.be.revertedWithCustomError(registry, "EmptyHash");
    });

    it("refuses to read an id that was never registered", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.getEvidence(999))
        .to.be.revertedWithCustomError(registry, "UnknownEvidence");
    });
  });

  describe("2.2 custody transfer", function () {
    it("refuses a transfer initiated by anyone but the current holder", async function () {
      const { registry, custody, io, malkhana, outsider } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(custody.connect(outsider).initiateTransfer(id, malkhana.address))
        .to.be.revertedWithCustomError(custody, "NotCurrentHolder");
    });

    it("refuses acceptance by anyone but the named receiver", async function () {
      const { registry, custody, io, malkhana, forensic } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await custody.connect(io).initiateTransfer(id, malkhana.address);
      await expect(custody.connect(forensic).acceptTransfer(id))
        .to.be.revertedWithCustomError(custody, "NotIntendedReceiver");
    });

    it("refuses acceptance when nothing is pending", async function () {
      const { registry, custody, io, malkhana } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(custody.connect(malkhana).acceptTransfer(id))
        .to.be.revertedWithCustomError(custody, "NoPendingTransfer");
    });

    it("refuses a second transfer while one is already pending", async function () {
      const { registry, custody, io, malkhana, forensic } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await custody.connect(io).initiateTransfer(id, malkhana.address);
      await expect(custody.connect(io).initiateTransfer(id, forensic.address))
        .to.be.revertedWithCustomError(custody, "TransferAlreadyPending");
    });

    it("refuses a transfer to self", async function () {
      const { registry, custody, io } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(custody.connect(io).initiateTransfer(id, io.address))
        .to.be.revertedWithCustomError(custody, "CannotTransferToSelf");
    });

    it("refuses a transfer to the zero address", async function () {
      const { registry, custody, io } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(custody.connect(io).initiateTransfer(id, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(custody, "ZeroAddress");
    });

    it("refuses a transfer to an address holding no custody-capable role", async function () {
      const { registry, custody, io, outsider } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(custody.connect(io).initiateTransfer(id, outsider.address))
        .to.be.revertedWithCustomError(custody, "ReceiverNotAuthorized");
    });

    it("refuses a cancel by anyone but the holder", async function () {
      const { registry, custody, io, malkhana, outsider } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await custody.connect(io).initiateTransfer(id, malkhana.address);
      await expect(custody.connect(outsider).cancelTransfer(id))
        .to.be.revertedWithCustomError(custody, "NotCurrentHolder");
    });
  });

  describe("2.3 judicial actions", function () {
    it("refuses dispute, production and disposal by a non-court role", async function () {
      const { registry, courtOrders, io, malkhana } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      await expect(courtOrders.connect(malkhana).raiseDispute(id, b32("x")))
        .to.be.revertedWithCustomError(courtOrders, "Unauthorized");
      await expect(courtOrders.connect(malkhana).orderProduction(id))
        .to.be.revertedWithCustomError(courtOrders, "Unauthorized");
      await expect(courtOrders.connect(malkhana).orderDisposal(id))
        .to.be.revertedWithCustomError(courtOrders, "Unauthorized");
    });

    it("refuses to resolve a dispute that was never raised", async function () {
      const { registry, courtOrders, io, court } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(courtOrders.connect(court).resolveDispute(id, io.address, Status.Seized))
        .to.be.revertedWithCustomError(courtOrders, "NotDisputed");
    });

    it("refuses to raise a dispute twice", async function () {
      const { registry, courtOrders, io, court } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await courtOrders.connect(court).raiseDispute(id, b32("a"));
      await expect(courtOrders.connect(court).raiseDispute(id, b32("b")))
        .to.be.revertedWithCustomError(courtOrders, "AlreadyDisputed");
    });

    it("refuses to resolve a dispute back into the disputed state", async function () {
      const { registry, courtOrders, io, court } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await courtOrders.connect(court).raiseDispute(id, b32("a"));
      await expect(courtOrders.connect(court).resolveDispute(id, io.address, Status.Disputed))
        .to.be.revertedWithCustomError(courtOrders, "CannotRestoreToDisputed");
    });
  });

  describe("2.4 terminal state", function () {
    it("refuses every further action once a record is disposed", async function () {
      const { registry, custody, courtOrders, io, malkhana, court } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await handover(custody, io, malkhana, id);
      await courtOrders.connect(court).orderDisposal(id);

      await expect(custody.connect(court).initiateTransfer(id, malkhana.address))
        .to.be.revertedWithCustomError(registry, "RecordTerminal");
      await expect(courtOrders.connect(court).orderProduction(id))
        .to.be.revertedWithCustomError(registry, "RecordTerminal");
      await expect(courtOrders.connect(court).orderDisposal(id))
        .to.be.revertedWithCustomError(registry, "RecordTerminal");
      await expect(registry.connect(court).attachDocument(id, b32("X"), b32("c")))
        .to.be.revertedWithCustomError(registry, "RecordTerminal");
    });
  });

  describe("2.5 attachments", function () {
    it("refuses an attachment from anyone but the current holder", async function () {
      const { registry, custody, io, malkhana, forensic } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await handover(custody, io, malkhana, id);

      await expect(registry.connect(forensic).attachDocument(id, b32("REPORT"), b32("cid")))
        .to.be.revertedWithCustomError(registry, "NotHolder");
      await expect(registry.connect(io).attachDocument(id, b32("REPORT"), b32("cid")))
        .to.be.revertedWithCustomError(registry, "NotHolder");
    });

    it("refuses an empty attachment digest", async function () {
      const { registry, io } = await loadFixture(deployFixture);
      const id = await registerItem(registry, io);
      await expect(registry.connect(io).attachDocument(id, b32("REPORT"), ethers.ZeroHash))
        .to.be.revertedWithCustomError(registry, "EmptyHash");
    });
  });

  describe("2.6 role administration", function () {
    it("refuses role grants by a non-admin, blocking self-escalation", async function () {
      const { registry, malkhana } = await loadFixture(deployFixture);
      // A Malkhana Officer trying to award themselves judicial power.
      await expect(registry.connect(malkhana).grantRole(ROLES.COURT, malkhana.address))
        .to.be.revertedWithCustomError(registry, "Unauthorized");
    });

    it("refuses to remove the last admin, which would brick the system", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      expect(await registry.adminCount()).to.equal(1n);
      await expect(registry.connect(admin).revokeRole(ROLES.ADMIN, admin.address))
        .to.be.revertedWithCustomError(registry, "LastAdmin");
    });

    it("allows admin handover once a second admin exists", async function () {
      const { registry, admin, outsider } = await loadFixture(deployFixture);
      await registry.connect(admin).grantRole(ROLES.ADMIN, outsider.address);
      expect(await registry.adminCount()).to.equal(2n);

      await registry.connect(outsider).revokeRole(ROLES.ADMIN, admin.address);
      expect(await registry.adminCount()).to.equal(1n);
      expect(await registry.hasRole(ROLES.ADMIN, admin.address)).to.equal(false);
    });

    it("refuses role writes on the workflow contracts - the registry is the only authority", async function () {
      const { custody, courtOrders, admin, outsider } = await loadFixture(deployFixture);
      await expect(custody.connect(admin).grantRole(ROLES.IO, outsider.address))
        .to.be.revertedWithCustomError(custody, "RolesManagedByRegistryError");
      await expect(courtOrders.connect(admin).revokeRole(ROLES.IO, outsider.address))
        .to.be.revertedWithCustomError(courtOrders, "RolesManagedByRegistryError");
    });

    it("refuses pause on the workflow contracts - the stop is system-wide", async function () {
      const { custody, courtOrders, admin } = await loadFixture(deployFixture);
      await expect(custody.connect(admin).pause())
        .to.be.revertedWithCustomError(custody, "PauseManagedByRegistry");
      await expect(courtOrders.connect(admin).unpause())
        .to.be.revertedWithCustomError(courtOrders, "PauseManagedByRegistry");
    });
  });

  describe("2.7 emergency pause", function () {
    it("freezes writes across all three contracts but leaves reads open", async function () {
      const { registry, custody, courtOrders, admin, io, malkhana, court } =
        await loadFixture(deployFixture);
      const id = await registerItem(registry, io);

      await registry.connect(admin).pause();
      expect(await custody.paused()).to.equal(true);
      expect(await courtOrders.paused()).to.equal(true);

      await expect(registry.connect(io).registerEvidence(b32("F"), b32("h"), b32("c")))
        .to.be.revertedWithCustomError(registry, "ContractPaused");
      await expect(custody.connect(io).initiateTransfer(id, malkhana.address))
        .to.be.revertedWithCustomError(custody, "ContractPaused");
      await expect(courtOrders.connect(court).orderProduction(id))
        .to.be.revertedWithCustomError(courtOrders, "ContractPaused");

      // Reads must keep working so an active investigation stays inspectable.
      expect((await registry.getEvidence(id)).status).to.equal(Status.Seized);

      await registry.connect(admin).unpause();
      await custody.connect(io).initiateTransfer(id, malkhana.address);
      expect((await registry.getEvidence(id)).status).to.equal(Status.InTransit);
    });

    it("refuses pause by a non-admin", async function () {
      const { registry, court } = await loadFixture(deployFixture);
      await expect(registry.connect(court).pause())
        .to.be.revertedWithCustomError(registry, "Unauthorized");
    });
  });
});

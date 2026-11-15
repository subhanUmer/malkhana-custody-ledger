const { ethers } = require("hardhat");

// Mirrors EvidenceRegistry.Status
const Status = {
  None: 0n, Seized: 1n, Deposited: 2n, InTransit: 3n,
  AtForensic: 4n, InCourt: 5n, Disposed: 6n, Disputed: 7n,
};

const b32 = (s) => ethers.encodeBytes32String(s);
const ROLE = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const ROLES = {
  ADMIN: ROLE("ROLE_ADMIN"),
  IO: ROLE("ROLE_IO"),
  MALKHANA: ROLE("ROLE_MALKHANA"),
  FORENSIC: ROLE("ROLE_FORENSIC"),
  COURT: ROLE("ROLE_COURT"),
};

/// Recomputes the on-chain rolling custody hash, so tests prove the off-chain
/// indexer can independently reconstruct and verify the trail.
function custodyStep(prevRoot, id, actor, newHolder, newStatus, action, at) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "address", "uint8", "bytes32", "uint64"],
      [prevRoot, id, actor, newHolder, newStatus, action, at]
    )
  );
}

const ZERO_ROOT = ethers.ZeroHash;

async function deployFixture() {
  const [admin, io, malkhana, forensic, court, outsider, io2] = await ethers.getSigners();

  const Registry = await ethers.getContractFactory("EvidenceRegistry");
  const registry = await Registry.deploy(admin.address);

  const Custody = await ethers.getContractFactory("CustodyManager");
  const custody = await Custody.deploy(await registry.getAddress(), admin.address);

  const Court = await ethers.getContractFactory("CourtOrders");
  const courtOrders = await Court.deploy(await registry.getAddress(), admin.address);

  // Narrow, separate authorization: only CustodyManager may move custody, and
  // only CourtOrders may freeze or terminally dispose.
  await registry.connect(admin).setCustodyWriter(await custody.getAddress(), true);
  await registry.connect(admin).setCourtWriter(await courtOrders.getAddress(), true);

  await registry.connect(admin).grantRole(ROLES.IO, io.address);
  await registry.connect(admin).grantRole(ROLES.IO, io2.address);
  await registry.connect(admin).grantRole(ROLES.MALKHANA, malkhana.address);
  await registry.connect(admin).grantRole(ROLES.FORENSIC, forensic.address);
  await registry.connect(admin).grantRole(ROLES.COURT, court.address);

  return { registry, custody, courtOrders, admin, io, io2, malkhana, forensic, court, outsider };
}

/// Registers one item and returns its id.
async function registerItem(registry, io, caseId = "FIR-115/2026", item = "sealed-pistol-01") {
  const tx = await registry.connect(io).registerEvidence(
    b32(caseId), ethers.keccak256(ethers.toUtf8Bytes(item)), ethers.keccak256(ethers.toUtf8Bytes(item + "-bundle"))
  );
  await tx.wait();
  return await registry.evidenceCount();
}

/// Completes a two-phase handover.
async function handover(custody, from, to, id) {
  await custody.connect(from).initiateTransfer(id, to.address);
  await custody.connect(to).acceptTransfer(id);
}

module.exports = { Status, ROLES, b32, deployFixture, registerItem, handover, custodyStep, ZERO_ROOT };

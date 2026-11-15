/**
 * Deploys the three contracts, wires the narrow writer authorizations, assigns
 * roles to the local development accounts and writes deployments/<network>.json
 * for the indexer and the frontend to read.
 *
 * Run:  npx hardhat run scripts/deploy.js --network localhost
 *       SEED=true npx hardhat run scripts/deploy.js --network localhost
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROLE = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const ROLES = {
  ADMIN: ROLE("ROLE_ADMIN"), IO: ROLE("ROLE_IO"), MALKHANA: ROLE("ROLE_MALKHANA"),
  FORENSIC: ROLE("ROLE_FORENSIC"), COURT: ROLE("ROLE_COURT"),
};

async function main() {
  const signers = await ethers.getSigners();
  const [admin, io, malkhana, forensic, court] = signers;

  console.log(`network: ${network.name}`);
  console.log(`admin:    ${admin.address}`);
  console.log(`IO:       ${io.address}`);
  console.log(`malkhana: ${malkhana.address}`);
  console.log(`forensic: ${forensic.address}`);
  console.log(`court:    ${court.address}\n`);

  const registry = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(admin.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();

  const custody = await (await ethers.getContractFactory("CustodyManager"))
    .deploy(registryAddr, admin.address);
  await custody.waitForDeployment();
  const custodyAddr = await custody.getAddress();

  const courtOrders = await (await ethers.getContractFactory("CourtOrders"))
    .deploy(registryAddr, admin.address);
  await courtOrders.waitForDeployment();
  const courtAddr = await courtOrders.getAddress();

  console.log(`EvidenceRegistry: ${registryAddr}`);
  console.log(`CustodyManager:   ${custodyAddr}`);
  console.log(`CourtOrders:      ${courtAddr}\n`);

  // Narrow authorization: each workflow contract gets exactly the power it needs.
  await (await registry.setCustodyWriter(custodyAddr, true)).wait();
  await (await registry.setCourtWriter(courtAddr, true)).wait();
  console.log("wired custody + court writers");

  for (const [name, role, signer] of [
    ["IO", ROLES.IO, io],
    ["MALKHANA", ROLES.MALKHANA, malkhana],
    ["FORENSIC", ROLES.FORENSIC, forensic],
    ["COURT", ROLES.COURT, court],
  ]) {
    await (await registry.grantRole(role, signer.address)).wait();
    console.log(`granted ROLE_${name} -> ${signer.address}`);
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      EvidenceRegistry: registryAddr,
      CustodyManager: custodyAddr,
      CourtOrders: courtAddr,
    },
    roles: {
      ROLE_ADMIN: admin.address,
      ROLE_IO: io.address,
      ROLE_MALKHANA: malkhana.address,
      ROLE_FORENSIC: forensic.address,
      ROLE_COURT: court.address,
    },
    roleHashes: ROLES,
  };

  fs.mkdirSync("deployments", { recursive: true });
  const file = path.join("deployments", `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);

  if (process.env.SEED === "true") {
    console.log("\nseeding demo data...");

    const { address: contentAddress } = require("../offchain/cid");

    const bundle = Buffer.from("FIR-115/2026 seizure memo: one sealed 9mm pistol, recovered 2026-11-02");
    const { digest } = contentAddress(bundle);

    const tx = await registry.connect(io).registerEvidence(
      ethers.encodeBytes32String("FIR-115/2026"),
      ethers.keccak256(Buffer.from("sealed-pistol-9mm-serial-AX8841")),
      digest
    );
    await tx.wait();
    const id = await registry.evidenceCount();
    console.log(`  registered evidence #${id}`);

    await (await custody.connect(io).initiateTransfer(id, malkhana.address)).wait();
    await (await custody.connect(malkhana).acceptTransfer(id)).wait();
    console.log(`  deposited #${id} into the malkhana`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

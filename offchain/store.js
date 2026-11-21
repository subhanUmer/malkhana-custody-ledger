/**
 * Content-addressed evidence store.
 *
 * Files are named by their own CID, so the name IS the integrity check. On every
 * read the bytes are re-hashed and compared against the CID that was asked for;
 * a mismatch throws rather than returning data. That is the property the chain
 * cannot give us on its own - the contract stores only a 32-byte digest, and
 * this is what proves a given file is the file that digest commits to.
 */
const fs = require("fs");
const path = require("path");
const { address, cidFromDigest } = require("./cid");

const DIR = path.join(__dirname, "store");

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

/** Stores a buffer under its own CID. Returns { digest, cid, size }. */
function put(buf, originalName = "") {
  ensureDir();
  const addr = address(buf);
  const file = path.join(DIR, addr.cid);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);

  // Sidecar metadata, kept separate so it can never affect the content hash.
  const meta = path.join(DIR, addr.cid + ".meta.json");
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(meta, JSON.stringify(
      { cid: addr.cid, digest: addr.digest, size: addr.size, originalName,
        storedAt: new Date().toISOString() }, null, 2));
  }
  return addr;
}

/** Reads a file by CID, verifying the content still hashes to that CID. */
function get(cid) {
  const file = path.join(DIR, cid);
  if (!fs.existsSync(file)) {
    const err = new Error(`content not held in store: ${cid}`);
    err.code = "NOT_IN_STORE";
    throw err;
  }
  const buf = fs.readFileSync(file);
  const actual = address(buf).cid;
  if (actual !== cid) {
    // The stored bytes were altered on disk after they were written.
    const err = new Error(`integrity failure: ${cid} now hashes to ${actual}`);
    err.code = "INTEGRITY_FAILURE";
    throw err;
  }
  return buf;
}

function meta(cid) {
  const file = path.join(DIR, cid + ".meta.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function has(cid) {
  return fs.existsSync(path.join(DIR, cid));
}

/** Given the on-chain digest, report whether we actually hold the content. */
function statusForDigest(digestHex) {
  if (!digestHex || /^0x0+$/.test(digestHex)) return { cid: null, held: false, reason: "no digest recorded" };
  const cid = cidFromDigest(digestHex);
  if (!has(cid)) {
    return { cid, held: false, reason: "on-chain digest exists but the content is not in this store" };
  }
  try {
    get(cid);
    return { cid, held: true, verified: true };
  } catch (e) {
    return { cid, held: true, verified: false, reason: e.message };
  }
}

module.exports = { put, get, meta, has, statusForDigest, DIR };

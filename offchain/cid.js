/**
 * IPFS CIDv1 construction, written out by hand so there is no dependency to
 * explain and nothing hidden behind a library call.
 *
 * A CIDv1 for raw content hashed with sha2-256 is just five things glued
 * together and base32-encoded:
 *
 *   0x01   CID version 1
 *   0x55   multicodec "raw" (the bytes are the content, not a DAG node)
 *   0x12   multihash function code: sha2-256
 *   0x20   digest length: 32 bytes
 *   ...    the 32-byte sha2-256 digest
 *
 * That 36-byte string is then base32-encoded (RFC 4648, lowercase, unpadded)
 * and prefixed with "b", the multibase tag for base32lower. Which is why every
 * such CID begins "bafkrei".
 *
 * This matters for the project because the contract stores ONLY the 32-byte
 * digest (gas optimization 3). The full CID is rebuilt here, off-chain.
 */
const crypto = require("crypto");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** sha2-256 digest of a buffer, as a 0x-prefixed hex string. */
function sha256Hex(buf) {
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

/** Builds the CIDv1 string from a 32-byte sha2-256 digest. */
function cidFromDigest(digestHex) {
  const hex = digestHex.replace(/^0x/, "");
  if (hex.length !== 64) throw new Error("digest must be 32 bytes");
  const digest = Buffer.from(hex, "hex");
  const prefixed = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return "b" + base32Encode(prefixed);
}

/** Recovers the 32-byte digest from a CIDv1 string. */
function digestFromCid(cid) {
  if (!cid.startsWith("b")) throw new Error("only base32 (b-prefixed) CIDs are supported");
  const bytes = base32Decode(cid.slice(1));
  if (bytes[0] !== 0x01) throw new Error("not a CIDv1");
  if (bytes[1] !== 0x55) throw new Error("not the raw codec");
  if (bytes[2] !== 0x12 || bytes[3] !== 0x20) throw new Error("not a 32-byte sha2-256 multihash");
  return "0x" + bytes.subarray(4, 36).toString("hex");
}

/** Content address a buffer: returns both the digest the contract stores and the CID. */
function address(buf) {
  const digest = sha256Hex(buf);
  return { digest, cid: cidFromDigest(digest), size: buf.length };
}

module.exports = { address, cidFromDigest, digestFromCid, sha256Hex, base32Encode, base32Decode };

// --------------------------------------------------------------- self-test
if (require.main === module) {
  // Public IPFS test vector: the raw bytes "hello world".
  const expected = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";
  const got = address(Buffer.from("hello world")).cid;

  const digest = sha256Hex(Buffer.from("hello world"));
  const expectedDigest = "0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

  const roundTrip = digestFromCid(expected);

  const checks = [
    ["sha2-256 digest of 'hello world'", digest, expectedDigest],
    ["CIDv1 of 'hello world'", got, expected],
    ["CID -> digest round trip", roundTrip, expectedDigest],
    ["CID length", String(got.length), "59"],
  ];

  let ok = true;
  for (const [label, actual, want] of checks) {
    const pass = actual === want;
    ok = ok && pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}\n      got  ${actual}\n      want ${want}`);
  }
  process.exit(ok ? 0 : 1);
}

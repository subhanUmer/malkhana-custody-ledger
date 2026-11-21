/* Malkhana Custody Ledger - browser client.
 *
 * Reads go through the off-chain indexer (which rebuilds the custody trail from
 * events and proves it against the on-chain rolling root). Writes go straight
 * to the contracts through the user's wallet - the indexer holds no keys and
 * can never write on anyone's behalf.
 */
"use strict";

const API = "";                       // same origin as the indexer
const STATUS = ["None", "Seized", "Deposited", "InTransit", "AtForensic",
                "InCourt", "Disposed", "Disputed"];

const state = {
  cfg: null, abis: {}, provider: null, signer: null, me: null,
  roles: {}, contracts: {}, selectedId: null, pendingUpload: null, paused: false, listSig: null,
};

const $ = (id) => document.getElementById(id);
const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "-";
const when = (sec) => new Date(sec * 1000).toLocaleString();

// ------------------------------------------------------------------ bootstrap
async function loadAbi(name) {
  const r = await fetch(`${API}/artifacts/contracts/${name}.sol/${name}.json`);
  if (!r.ok) throw new Error(`cannot load ABI for ${name}`);
  return (await r.json()).abi;
}

async function boot() {
  try {
    state.cfg = await (await fetch(`${API}/api/config`)).json();
  } catch {
    banner("bad", "Cannot reach the indexer API. Start it with <span class='mono'>npm run indexer</span>.");
    return;
  }
  for (const n of ["EvidenceRegistry", "CustodyManager", "CourtOrders"]) {
    state.abis[n] = await loadAbi(n);
  }
  await refreshHealth();
  await refreshList();
  setInterval(refreshHealth, 8000);
  setInterval(refreshList, 6000);
}

function banner(kind, html) {
  const d = document.createElement("div");
  d.className = `banner ${kind}`;
  d.innerHTML = html;
  $("banners").appendChild(d);
}

async function refreshHealth() {
  try {
    const h = await (await fetch(`${API}/api/health`)).json();
    $("health").innerHTML = h.ok
      ? `indexer ok &middot; block ${h.lastIndexedBlock} &middot; ${h.records} record(s)`
      : `<span style="color:var(--bad)">indexer degraded: ${h.lastError || "chain unreachable"}</span>`;
  } catch {
    $("health").innerHTML = `<span style="color:var(--bad)">indexer unreachable</span>`;
  }
}

// -------------------------------------------------------------------- wallet
async function connect() {
  if (!window.ethereum) {
    banner("bad", "No wallet found. Install MetaMask and add the local network (chainId 31337, RPC http://127.0.0.1:8545).");
    return;
  }
  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.me = await state.signer.getAddress();

  const net = await state.provider.getNetwork();
  if (Number(net.chainId) !== state.cfg.chainId) {
    banner("warn", `Wallet is on chainId ${net.chainId} but the contracts are deployed on ${state.cfg.chainId}. Switch network in MetaMask.`);
  }

  const c = state.cfg.contracts;
  state.contracts.registry = new ethers.Contract(c.EvidenceRegistry, state.abis.EvidenceRegistry, state.signer);
  state.contracts.custody  = new ethers.Contract(c.CustodyManager,  state.abis.CustodyManager,  state.signer);
  state.contracts.court    = new ethers.Contract(c.CourtOrders,     state.abis.CourtOrders,     state.signer);

  await detectRoles();
  window.ethereum.on("accountsChanged", () => location.reload());
  window.ethereum.on("chainChanged", () => location.reload());

  await refreshList();
  if (state.selectedId) await selectRecord(state.selectedId);
}

async function detectRoles() {
  const r = state.contracts.registry;
  const names = ["ADMIN", "IO", "MALKHANA", "FORENSIC", "COURT"];
  const held = [];
  for (const n of names) {
    const has = await r.hasRole(state.cfg.roleHashes[n], state.me);
    state.roles[n] = has;
    if (has) held.push(n);
  }
  state.paused = await r.paused();

  $("whoami").innerHTML =
    `${short(state.me)} ` +
    (held.length
      ? held.map((n) => `<span class="pill info">${n}</span>`).join(" ")
      : `<span class="pill bad">no role</span>`) +
    (state.paused ? ` <span class="pill warn">SYSTEM PAUSED</span>` : "");
  $("connect").textContent = "Connected";
  $("connect").disabled = true;

  $("btnRegister").disabled = !state.roles.IO;
  $("btnPause").disabled = !state.roles.ADMIN;
  $("btnUnpause").disabled = !state.roles.ADMIN;

  if (!held.length) {
    banner("warn", `This account holds no role. Use one of the seeded accounts from <span class="mono">deployments/${state.cfg.network}.json</span>.`);
  }
}

// ------------------------------------------------------- transaction logging
function logEntry(title) {
  const empty = $("log").querySelector(".empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "entry pending";
  el.innerHTML = `<div><strong>${title}</strong> &mdash; submitting&hellip;</div>`;
  $("log").prepend(el);
  return el;
}

/** Turns an ethers error into the contract's own custom-error name where possible. */
function describeError(e) {
  if (e?.revert?.name) {
    const args = (e.revert.args || []).map(String).join(", ");
    return `${e.revert.name}${args ? `(${args})` : ""}`;
  }
  if (e?.reason) return e.reason;
  if (e?.shortMessage) return e.shortMessage;
  if (e?.info?.error?.message) return e.info.error.message;
  return e?.message || "unknown error";
}

/** Runs a contract write, reporting pending / confirmed / reverted in the log. */
async function send(title, fn) {
  const el = logEntry(title);
  try {
    const tx = await fn();
    el.innerHTML = `<div><strong>${title}</strong> &mdash; pending</div>
      <div class="meta">${tx.hash}</div>`;
    const rc = await tx.wait();
    el.className = "entry ok";
    el.innerHTML = `<div><strong>${title}</strong> &mdash; confirmed in block ${rc.blockNumber}</div>
      <div class="meta">gas used ${rc.gasUsed.toString()} &middot; ${tx.hash}</div>`;
    // Give the indexer a moment to pick up the event, then refresh.
    setTimeout(async () => {
      await fetch(`${API}/api/reindex`, { method: "POST" }).catch(() => {});
      await refreshList();
      if (state.selectedId) await selectRecord(state.selectedId);
      await detectRoles();
    }, 400);
    return rc;
  } catch (e) {
    el.className = "entry bad";
    el.innerHTML = `<div><strong>${title}</strong> &mdash; rejected</div>
      <div class="meta">${describeError(e)}</div>`;
    return null;
  }
}

// ------------------------------------------------------------ evidence list
async function refreshList() {
  let data;
  try {
    data = await (await fetch(`${API}/api/evidence`)).json();
  } catch { return; }

  // Only rebuild the table when something actually changed. Polling that
  // replaces the DOM every few seconds flickers and drops the user's
  // selection mid-interaction.
  const sig = JSON.stringify(data.evidence) + "|" + state.selectedId;
  if (sig === state.listSig) return;
  state.listSig = sig;

  const tb = $("evidenceRows");
  tb.innerHTML = "";
  $("evidenceEmpty").style.display = data.count ? "none" : "block";

  for (const e of data.evidence) {
    const tr = document.createElement("tr");
    if (e.id === state.selectedId) tr.className = "sel";
    tr.innerHTML = `
      <td class="mono">${e.id}</td>
      <td>${e.caseId}</td>
      <td><span class="pill ${e.current?.status === "Disputed" ? "warn"
          : e.current?.status === "Disposed" ? "muted" : "info"}">${e.current?.status || "?"}</span></td>
      <td class="mono">${short(e.current?.holder)}</td>
      <td class="mono">${e.steps}</td>
      <td><span class="pill ${e.verified ? "ok" : "bad"}">${e.verified ? "verified" : "UNVERIFIED"}</span></td>`;
    tr.onclick = () => selectRecord(e.id);
    tb.appendChild(tr);
  }
}

async function selectRecord(id) {
  state.selectedId = id;
  const r = await (await fetch(`${API}/api/evidence/${id}`)).json();
  renderDetail(r);
  renderTrail(r);
  await renderActions(r);
  await refreshList();
}

function renderDetail(r) {
  const v = r.verification || {};
  $("detail").innerHTML = `
    <dl class="kv">
      <dt>Evidence id</dt><dd class="mono">${r.id}</dd>
      <dt>Case</dt><dd>${r.caseId}</dd>
      <dt>Status</dt><dd>${r.current?.status || "?"}</dd>
      <dt>Current holder</dt><dd class="mono">${r.current?.holder || "-"}</dd>
      <dt>Registered by</dt><dd class="mono">${r.registeredBy}</dd>
      <dt>Seized at</dt><dd>${when(r.seizedAt)}</dd>
      <dt>Item hash</dt><dd class="mono">${r.itemHash}</dd>
      <dt>Bundle CID</dt><dd class="mono">${r.cid || "none"}</dd>
      <dt>Bundle held</dt><dd>${r.bundle?.held
        ? `<span class="pill ok">in store</span> <a href="${API}/api/file/${r.cid}">download</a>`
        : `<span class="pill warn">not in store</span> <span class="hint">${r.bundle?.reason || ""}</span>`}</dd>
      <dt>Trail verified</dt><dd>
        <span class="pill ${v.verified ? "ok" : "bad"}">${v.verified ? "verified" : "UNVERIFIED"}</span>
        <div class="hint">${v.note || ""}</div>
        ${v.divergedAtSeq ? `<div class="hint">first divergence at step ${v.divergedAtSeq}</div>` : ""}
      </dd>
      <dt>On-chain root</dt><dd class="mono">${v.onChainRoot || "-"}</dd>
      <dt>Replayed root</dt><dd class="mono">${v.computedRoot || "-"}</dd>
    </dl>
    ${r.attachments?.length ? `<h2 style="margin-top:14px">Attachments</h2>` +
      r.attachments.map((a) => `
        <div class="entry">
          <div><strong>${a.docType}</strong> by <span class="mono">${short(a.by)}</span></div>
          <div class="meta">${a.cid} &middot; ${a.content?.held
            ? `<a href="${API}/api/file/${a.cid}">download</a>` : "not in store"}</div>
        </div>`).join("") : ""}`;
}

function renderTrail(r) {
  if (!r.timeline?.length) { $("trail").innerHTML = `<div class="empty">No custody steps.</div>`; return; }
  $("trail").innerHTML = `<ul class="timeline">` + r.timeline.map((s) => `
    <li>
      <div><strong>${s.action}</strong> &rarr; <span class="pill info">${s.status}</span></div>
      <div>actor <span class="mono">${short(s.actor)}</span>
           &middot; holder <span class="mono">${short(s.newHolder)}</span></div>
      <div class="when">step ${s.seq} &middot; ${when(s.at)} &middot; block ${s.block}</div>
      <div class="when mono">root ${s.custodyRoot.slice(0, 18)}&hellip;</div>
    </li>`).join("") + `</ul>`;
}

// ----------------------------------------------------------------- actions
function recipientOptions() {
  const roles = state.cfg.roles;
  return Object.entries(roles)
    .filter(([k, a]) => k !== "ROLE_ADMIN" && a.toLowerCase() !== (state.me || "").toLowerCase())
    .map(([k, a]) => `<option value="${a}">${k.replace("ROLE_", "")} - ${short(a)}</option>`)
    .join("");
}

async function renderActions(r) {
  const box = $("actions");
  if (!state.signer) { box.innerHTML = `<div class="empty">Connect a wallet to act.</div>`; return; }

  const me = state.me.toLowerCase();
  const holder = (r.current?.holder || "").toLowerCase();
  const status = r.current?.status;
  const id = r.id;

  let pending = { to: ethers.ZeroAddress };
  try { pending = await state.contracts.custody.pendingTransfer(id); } catch {}
  const pendingTo = (pending.to || ethers.ZeroAddress).toLowerCase();
  const hasPending = pendingTo !== ethers.ZeroAddress.toLowerCase();

  const parts = [];

  if (state.paused) {
    parts.push(`<div class="banner warn">System is paused. All writes are refused; reads remain available.</div>`);
  }
  if (status === "Disposed") {
    parts.push(`<div class="banner warn">This record is disposed. It is terminal and can never change again.</div>`);
  }

  // --- holder actions
  if (holder === me && !hasPending && status !== "Disposed" && status !== "Disputed") {
    parts.push(`
      <div class="row">
        <div>
          <label>Hand over to</label>
          <select id="selTo">${recipientOptions()}</select>
        </div>
        <button id="aInit">Initiate transfer</button>
      </div>
      <p class="hint">Two-phase: custody stays with you until the receiver accepts.</p>
      <div class="row">
        <div><label>Attach document (e.g. PFSA report)</label><input id="docFile" type="file"></div>
        <div><label>Type</label><input id="docType" value="PFSA_REPORT" maxlength="31"></div>
        <button id="aAttach">Attach</button>
      </div>`);
  }

  // --- receiver actions
  if (hasPending && pendingTo === me) {
    parts.push(`
      <div class="banner warn">A transfer of item #${id} is awaiting your acceptance.</div>
      <div class="row">
        <button id="aAccept">Accept custody</button>
        <button id="aReject" class="ghost">Reject</button>
      </div>`);
  }

  // --- sender cancel
  if (hasPending && holder === me) {
    parts.push(`<div class="row"><button id="aCancel" class="ghost">Cancel pending transfer</button>
      <div class="hint">Awaiting <span class="mono">${short(pending.to)}</span></div></div>`);
  }

  // --- court actions
  if (state.roles.COURT && status !== "Disposed") {
    parts.push(`<h2 style="margin-top:14px">Judicial</h2><div class="row">`);
    if (status !== "Disputed") {
      parts.push(`<button id="aDispute" class="warn">Raise dispute (freeze)</button>
        <button id="aProduce" class="ghost">Order production</button>
        <button id="aDispose" class="danger">Order disposal</button>`);
    } else {
      parts.push(`
        <div><label>Restore holder</label><select id="selRestore">${recipientOptions()}</select></div>
        <div><label>Restore status</label>
          <select id="selRestoreStatus">
            <option value="2">Deposited</option>
            <option value="1">Seized</option>
            <option value="4">AtForensic</option>
            <option value="5">InCourt</option>
          </select></div>
        <button id="aResolve">Resolve dispute</button>`);
    }
    parts.push(`</div>`);
  }

  if (parts.length === 0 || (parts.length && !parts.some((p) => p.includes("<button")))) {
    parts.push(`<div class="empty">No actions available to this account for record #${id}.</div>`);
  }

  box.innerHTML = parts.join("");
  wireActions(id, pending);
}

function wireActions(id, pending) {
  const C = state.contracts;
  const b32 = (s) => ethers.encodeBytes32String(s);

  const on = (elId, fn) => { const el = $(elId); if (el) el.onclick = fn; };

  on("aInit", () => send(`Initiate transfer of #${id}`,
    () => C.custody.initiateTransfer(id, $("selTo").value)));

  on("aAccept", () => send(`Accept custody of #${id}`,
    () => C.custody.acceptTransfer(id)));

  on("aReject", () => send(`Reject transfer of #${id}`,
    () => C.custody.rejectTransfer(id)));

  on("aCancel", () => send(`Cancel transfer of #${id}`,
    () => C.custody.cancelTransfer(id)));

  on("aDispute", () => send(`Raise dispute on #${id}`,
    () => C.court.raiseDispute(id, b32("TAMPER_ALLEGED"))));

  on("aProduce", () => send(`Order production of #${id}`,
    () => C.court.orderProduction(id)));

  on("aDispose", () => {
    if (!confirm(`Order final disposal of item #${id}?\n\nThis is terminal and cannot be undone.`)) return;
    send(`Order disposal of #${id}`, () => C.court.orderDisposal(id));
  });

  on("aResolve", () => send(`Resolve dispute on #${id}`,
    () => C.court.resolveDispute(id, $("selRestore").value, Number($("selRestoreStatus").value))));

  on("aAttach", async () => {
    const f = $("docFile").files[0];
    if (!f) { alert("Choose a file to attach."); return; }
    const up = await uploadFile(f);
    await send(`Attach ${$("docType").value} to #${id}`,
      () => C.registry.attachDocument(id, b32($("docType").value), up.digest));
  });
}

// ------------------------------------------------------------------ uploads
async function uploadFile(file) {
  const buf = await file.arrayBuffer();
  const r = await fetch(`${API}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": file.name },
    body: buf,
  });
  if (!r.ok) throw new Error("upload failed");
  return await r.json();
}

// ----------------------------------------------------------------- register
async function register() {
  const caseId = $("caseId").value.trim();
  const desc = $("itemDesc").value.trim();
  if (!caseId || !desc) { alert("Case number and item description are both required."); return; }

  let digest = ethers.ZeroHash;
  const f = $("bundle").files[0];
  if (f) {
    const up = await uploadFile(f);
    digest = up.digest;
    $("uploadInfo").innerHTML =
      `stored ${up.size} bytes &middot; CID <strong>${up.cid}</strong><br>on-chain digest ${up.digest}`;
  }

  const itemHash = ethers.keccak256(ethers.toUtf8Bytes(desc));
  await send(`Register "${desc.slice(0, 32)}"`,
    () => state.contracts.registry.registerEvidence(
      ethers.encodeBytes32String(caseId), itemHash, digest));
}

// --------------------------------------------------------------------- wire
$("connect").onclick = connect;
$("btnRegister").onclick = register;
$("btnPause").onclick = () => send("Pause system", () => state.contracts.registry.pause());
$("btnUnpause").onclick = () => send("Unpause system", () => state.contracts.registry.unpause());

boot();

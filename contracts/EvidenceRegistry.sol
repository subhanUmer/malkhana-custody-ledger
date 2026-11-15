// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlBase} from "./AccessControlBase.sol";

/// @title  EvidenceRegistry
/// @notice The single source of truth for every seized item and who holds it.
/// @dev    Deliberately does NOT contain workflow logic. CustodyManager owns the
///         transfer workflow and CourtOrders owns judicial actions; both call in
///         here through narrow, separately-authorized entry points. Splitting it
///         this way means the record keeper can outlive a change in workflow
///         rules, and a bug in a workflow contract cannot rewrite history.
contract EvidenceRegistry is AccessControlBase {
    enum Status {
        None,       // 0 - never registered
        Seized,     // 1 - IO holds it at/after the scene
        Deposited,  // 2 - lodged in the malkhana
        InTransit,  // 3 - transfer initiated, awaiting the receiver's acceptance
        AtForensic, // 4 - with the PFSA analyst
        InCourt,    // 5 - produced before the court
        Disposed,   // 6 - terminal: destroyed / returned / auctioned
        Disputed    // 7 - frozen by court order pending enquiry
    }

    /// @dev Field order is chosen for storage packing, not readability:
    ///      slot 0 = holder(160) + seizedAt(64) + status(8)        = 232 bits
    ///      slot 1 = registeredBy(160) + updatedAt(64) + custodyCount(32) = 256 bits
    ///      slots 2-5 = the four bytes32 values
    ///      Total 6 slots. See docs/GAS-EVALUATION.md for the unpacked baseline.
    struct Evidence {
        address holder;
        uint64  seizedAt;
        Status  status;
        address registeredBy;
        uint64  updatedAt;
        uint32  custodyCount;
        bytes32 caseId;      // FIR number, hashed
        bytes32 itemHash;    // sha256 of the sealed-item photo/document bundle - WRITE ONCE
        bytes32 cidDigest;   // sha2-256 digest of the IPFS bundle; full CIDv1 rebuilt off-chain
        bytes32 custodyRoot; // rolling hash over the whole custody trail
    }

    uint256 private _count;
    mapping(uint256 => Evidence) private _evidence;

    /// @dev Contracts permitted to move custody (CustodyManager).
    mapping(address => bool) public custodyWriter;
    /// @dev Contracts permitted to act on frozen or terminal records (CourtOrders).
    mapping(address => bool) public courtWriter;

    error UnknownEvidence(uint256 id);
    error NotCustodyWriter(address caller);
    error NotCourtWriter(address caller);
    error RecordFrozen(uint256 id);
    error RecordTerminal(uint256 id);
    error ItemHashAlreadySet(uint256 id);
    error EmptyHash();
    error NotHolder(address caller, address holder);

    event EvidenceRegistered(
        uint256 indexed id,
        bytes32 indexed caseId,
        address indexed registeredBy,
        bytes32 itemHash,
        bytes32 cidDigest,
        uint64  seizedAt
    );

    /// @notice One of these per custody step. The off-chain indexer replays the
    ///         whole stream and recomputes `custodyRoot`; if its computed root
    ///         does not match the on-chain value, the off-chain copy is corrupt
    ///         or incomplete and the API reports the evidence as unverifiable.
    event CustodyRecorded(
        uint256 indexed id,
        uint32  indexed seq,
        address indexed actor,
        address newHolder,
        Status  newStatus,
        bytes32 action,
        uint64  occurredAt,
        bytes32 custodyRoot
    );

    /// @notice Append-only attachment (forensic report, court order scan). Stored
    ///         as an event only - no storage write - because attachments are
    ///         read by humans through the indexer, never by contract logic.
    event DocumentAttached(
        uint256 indexed id,
        address indexed by,
        bytes32 indexed docType,
        bytes32 cidDigest,
        uint64  occurredAt
    );

    event CustodyWriterSet(address indexed writer, bool allowed);
    event CourtWriterSet(address indexed writer, bool allowed);

    constructor(address admin) AccessControlBase(admin) {}

    // ------------------------------------------------------- authorization
    modifier onlyCustodyWriter() {
        if (!custodyWriter[msg.sender]) revert NotCustodyWriter(msg.sender);
        _;
    }

    modifier onlyCourtWriter() {
        if (!courtWriter[msg.sender]) revert NotCourtWriter(msg.sender);
        _;
    }

    function setCustodyWriter(address writer, bool allowed) external onlyRole(ROLE_ADMIN) {
        if (writer == address(0)) revert ZeroAddress();
        custodyWriter[writer] = allowed;
        emit CustodyWriterSet(writer, allowed);
    }

    function setCourtWriter(address writer, bool allowed) external onlyRole(ROLE_ADMIN) {
        if (writer == address(0)) revert ZeroAddress();
        courtWriter[writer] = allowed;
        emit CourtWriterSet(writer, allowed);
    }

    // ---------------------------------------------------------- registration
    /// @notice Lodge a newly seized item. Only an Investigating Officer may do
    ///         this, and the IO becomes the first custodian - which matches the
    ///         real sequence, where the IO holds the item before it reaches the
    ///         malkhana.
    function registerEvidence(
        bytes32 caseId,
        bytes32 itemHash,
        bytes32 cidDigest
    ) external whenNotPaused onlyRole(ROLE_IO) returns (uint256 id) {
        if (itemHash == bytes32(0)) revert EmptyHash();

        id = ++_count;
        uint64 now64 = uint64(block.timestamp);

        bytes32 root = keccak256(
            abi.encode(bytes32(0), id, msg.sender, msg.sender, Status.Seized, bytes32("SEIZED"), now64)
        );

        _evidence[id] = Evidence({
            holder:       msg.sender,
            seizedAt:     now64,
            status:       Status.Seized,
            registeredBy: msg.sender,
            updatedAt:    now64,
            custodyCount: 1,
            caseId:       caseId,
            itemHash:     itemHash,
            cidDigest:    cidDigest,
            custodyRoot:  root
        });

        emit EvidenceRegistered(id, caseId, msg.sender, itemHash, cidDigest, now64);
        emit CustodyRecorded(id, 1, msg.sender, msg.sender, Status.Seized, bytes32("SEIZED"), now64, root);
    }

    // ------------------------------------------------------------- custody
    /// @notice Record one custody step. Callable only by CustodyManager.
    /// @dev    Refuses to touch a frozen or terminal record - those can only be
    ///         moved by CourtOrders via `applyCourtAction`.
    function applyCustody(
        uint256 id,
        address actor,
        address newHolder,
        Status  newStatus,
        bytes32 action
    ) external whenNotPaused onlyCustodyWriter {
        Evidence storage e = _evidence[id];
        Status current = e.status;

        if (current == Status.None) revert UnknownEvidence(id);
        if (current == Status.Disposed) revert RecordTerminal(id);
        if (current == Status.Disputed) revert RecordFrozen(id);
        if (newHolder == address(0)) revert ZeroAddress();

        _write(e, id, actor, newHolder, newStatus, action);
    }

    /// @notice Judicial action. Callable only by CourtOrders, and the only path
    ///         that may freeze, unfreeze or finally dispose of a record.
    function applyCourtAction(
        uint256 id,
        address actor,
        address newHolder,
        Status  newStatus,
        bytes32 action
    ) external whenNotPaused onlyCourtWriter {
        Evidence storage e = _evidence[id];
        Status current = e.status;

        if (current == Status.None) revert UnknownEvidence(id);
        if (current == Status.Disposed) revert RecordTerminal(id);
        if (newHolder == address(0)) revert ZeroAddress();

        _write(e, id, actor, newHolder, newStatus, action);
    }

    /// @dev Single write path for both entry points: bumps the sequence, extends
    ///      the rolling hash and emits the trail event. Keeping it in one place
    ///      means the custody root can never be updated inconsistently.
    function _write(
        Evidence storage e,
        uint256 id,
        address actor,
        address newHolder,
        Status  newStatus,
        bytes32 action
    ) private {
        uint64 now64 = uint64(block.timestamp);
        uint32 seq = e.custodyCount + 1;

        bytes32 root = keccak256(
            abi.encode(e.custodyRoot, id, actor, newHolder, newStatus, action, now64)
        );

        e.holder       = newHolder;
        e.status       = newStatus;
        e.updatedAt    = now64;
        e.custodyCount = seq;
        e.custodyRoot  = root;

        emit CustodyRecorded(id, seq, actor, newHolder, newStatus, action, now64, root);
    }

    /// @notice Attach a forensic report or scanned order. Current holder only.
    /// @dev    Append-only by construction: nothing is stored, so nothing can be
    ///         overwritten. The item's own `itemHash` is never writable again,
    ///         which is what blocks evidence substitution after deposit.
    function attachDocument(
        uint256 id,
        bytes32 docType,
        bytes32 cidDigest
    ) external whenNotPaused {
        Evidence storage e = _evidence[id];
        if (e.status == Status.None) revert UnknownEvidence(id);
        if (e.status == Status.Disposed) revert RecordTerminal(id);
        if (msg.sender != e.holder) revert NotHolder(msg.sender, e.holder);
        if (cidDigest == bytes32(0)) revert EmptyHash();

        emit DocumentAttached(id, msg.sender, docType, cidDigest, uint64(block.timestamp));
    }

    // ----------------------------------------------------------------- views
    function evidenceCount() external view returns (uint256) {
        return _count;
    }

    function getEvidence(uint256 id) external view returns (Evidence memory) {
        Evidence memory e = _evidence[id];
        if (e.status == Status.None) revert UnknownEvidence(id);
        return e;
    }

    function holderOf(uint256 id) external view returns (address) {
        return _evidence[id].holder;
    }

    function statusOf(uint256 id) external view returns (Status) {
        return _evidence[id].status;
    }

    function custodyRootOf(uint256 id) external view returns (bytes32) {
        return _evidence[id].custodyRoot;
    }
}

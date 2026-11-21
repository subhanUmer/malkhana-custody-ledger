// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaselineAccessControl} from "./BaselineAccessControl.sol";

/// @notice BASELINE ONLY. Same architecture and call graph as EvidenceRegistry.
///         The four measured differences:
///           1. struct fields are all full-width -> 10 slots instead of 6
///           2. the custody trail is pushed into a storage array, not emitted
///           3. require(string) instead of custom errors
///           4. the IPFS CID and description are stored on-chain as strings
contract BaselineRegistry is BaselineAccessControl {
    enum Status { None, Seized, Deposited, InTransit, AtForensic, InCourt, Disposed, Disputed }

    // Deliberately unpacked: every field takes its own 32-byte slot.
    struct Evidence {
        uint256 status;
        address holder;
        address registeredBy;
        uint256 seizedAt;
        uint256 updatedAt;
        uint256 custodyCount;
        bytes32 caseId;
        bytes32 itemHash;
        string  cid;
        string  description;
    }

    // Deliberately stored on-chain rather than emitted as an event.
    struct CustodyEntry {
        uint256 seq;
        address actor;
        address newHolder;
        uint256 newStatus;
        uint256 at;
        string  action;
    }

    uint256 private _count;
    mapping(uint256 => Evidence) private _evidence;
    mapping(uint256 => CustodyEntry[]) private _trail;

    mapping(address => bool) public custodyWriter;
    mapping(address => bool) public courtWriter;

    event EvidenceRegistered(uint256 indexed id, bytes32 indexed caseId, address indexed registeredBy);
    event DocumentAttached(uint256 indexed id, address indexed by, string docType, string cid);

    constructor(address admin) BaselineAccessControl(admin) {}

    function setCustodyWriter(address writer, bool allowed) external onlyRole(ROLE_ADMIN) {
        require(writer != address(0), "Registry: zero address not permitted");
        custodyWriter[writer] = allowed;
    }

    function setCourtWriter(address writer, bool allowed) external onlyRole(ROLE_ADMIN) {
        require(writer != address(0), "Registry: zero address not permitted");
        courtWriter[writer] = allowed;
    }

    /// @dev `memory` params rather than `calldata`, matching the unoptimized style.
    function registerEvidence(
        bytes32 caseId,
        bytes32 itemHash,
        string memory cid,
        string memory description
    ) external whenNotPaused onlyRole(ROLE_IO) returns (uint256 id) {
        require(itemHash != bytes32(0), "Registry: item hash must not be empty");

        id = ++_count;

        _evidence[id] = Evidence({
            status:       uint256(Status.Seized),
            holder:       msg.sender,
            registeredBy: msg.sender,
            seizedAt:     block.timestamp,
            updatedAt:    block.timestamp,
            custodyCount: 1,
            caseId:       caseId,
            itemHash:     itemHash,
            cid:          cid,
            description:  description
        });

        _trail[id].push(CustodyEntry({
            seq:       1,
            actor:     msg.sender,
            newHolder: msg.sender,
            newStatus: uint256(Status.Seized),
            at:        block.timestamp,
            action:    "SEIZED"
        }));

        emit EvidenceRegistered(id, caseId, msg.sender);
    }

    function applyCustody(
        uint256 id,
        address actor,
        address newHolder,
        Status  newStatus,
        string memory action
    ) external whenNotPaused {
        require(custodyWriter[msg.sender], "Registry: caller is not an authorized custody writer");

        Evidence storage e = _evidence[id];
        require(e.status != uint256(Status.None), "Registry: evidence id is not registered");
        require(e.status != uint256(Status.Disposed), "Registry: record is terminal and cannot change");
        require(e.status != uint256(Status.Disputed), "Registry: record is frozen by court order");
        require(newHolder != address(0), "Registry: zero address not permitted");

        uint256 seq = e.custodyCount + 1;
        e.holder = newHolder;
        e.status = uint256(newStatus);
        e.updatedAt = block.timestamp;
        e.custodyCount = seq;

        _trail[id].push(CustodyEntry({
            seq:       seq,
            actor:     actor,
            newHolder: newHolder,
            newStatus: uint256(newStatus),
            at:        block.timestamp,
            action:    action
        }));
    }

    /// @dev Stores the attachment on-chain, where the optimized version only
    ///      emits an event.
    function attachDocument(
        uint256 id,
        string memory docType,
        string memory cid
    ) external whenNotPaused {
        Evidence storage e = _evidence[id];
        require(e.status != uint256(Status.None), "Registry: evidence id is not registered");
        require(e.status != uint256(Status.Disposed), "Registry: record is terminal and cannot change");
        require(msg.sender == e.holder, "Registry: caller is not the current holder");
        require(bytes(cid).length > 0, "Registry: cid must not be empty");

        uint256 seq = e.custodyCount + 1;
        e.custodyCount = seq;
        _trail[id].push(CustodyEntry({
            seq:       seq,
            actor:     msg.sender,
            newHolder: e.holder,
            newStatus: e.status,
            at:        block.timestamp,
            action:    docType
        }));

        emit DocumentAttached(id, msg.sender, docType, cid);
    }

    function evidenceCount() external view returns (uint256) { return _count; }
    function getEvidence(uint256 id) external view returns (Evidence memory) { return _evidence[id]; }
    function holderOf(uint256 id) external view returns (address) { return _evidence[id].holder; }
    function statusOf(uint256 id) external view returns (Status) { return Status(_evidence[id].status); }
    function trailLength(uint256 id) external view returns (uint256) { return _trail[id].length; }
    function trailEntry(uint256 id, uint256 i) external view returns (CustodyEntry memory) { return _trail[id][i]; }
}

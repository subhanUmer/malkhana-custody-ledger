// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlBase} from "./AccessControlBase.sol";
import {EvidenceRegistry} from "./EvidenceRegistry.sol";

/// @title  CustodyManager
/// @notice Two-phase custody handover between officers.
/// @dev    Inherits AccessControlBase for the modifiers, then overrides the role
///         and pause hooks so EvidenceRegistry is the only authority for both.
///         The handover is deliberately two-phase: custody can never be *pushed*
///         onto someone. The receiver must accept, which is the control that
///         defeats the "I handed it over, they lost it" defence.
contract CustodyManager is AccessControlBase {
    EvidenceRegistry public immutable registry;

    /// @dev slot: to(160) + prevStatus(8) + initiatedAt(64) = 232 bits, one slot.
    struct Pending {
        address to;
        EvidenceRegistry.Status prevStatus;
        uint64 initiatedAt;
    }

    mapping(uint256 => Pending) private _pending;

    error RolesManagedByRegistryError();
    error PauseManagedByRegistry();
    error NotCurrentHolder(address caller, address holder);
    error TransferAlreadyPending(uint256 id);
    error NoPendingTransfer(uint256 id);
    error NotIntendedReceiver(address caller, address expected);
    error ReceiverNotAuthorized(address receiver);
    error CannotTransferToSelf();

    event TransferInitiated(uint256 indexed id, address indexed from, address indexed to, uint64 occurredAt);
    event TransferAccepted(uint256 indexed id, address indexed by, EvidenceRegistry.Status newStatus, uint64 occurredAt);
    event TransferRejected(uint256 indexed id, address indexed by, uint64 occurredAt);
    event TransferCancelled(uint256 indexed id, address indexed by, uint64 occurredAt);

    constructor(address registry_, address admin) AccessControlBase(admin) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = EvidenceRegistry(registry_);
    }

    // ------------------------------------- single authority for roles & pause
    function hasRole(bytes32 role, address account) public view override returns (bool) {
        return registry.hasRole(role, account);
    }

    function paused() public view override returns (bool) {
        return registry.paused();
    }

    function grantRole(bytes32, address) external pure override {
        revert RolesManagedByRegistryError();
    }

    function revokeRole(bytes32, address) external pure override {
        revert RolesManagedByRegistryError();
    }

    function pause() external pure override {
        revert PauseManagedByRegistry();
    }

    function unpause() external pure override {
        revert PauseManagedByRegistry();
    }

    // ------------------------------------------------------------- workflow
    /// @notice Step 1 of 2. The current holder offers the item to `to`.
    /// @dev    The holder does NOT change here - they still physically have the
    ///         item. Status becomes InTransit so the gap is visible in the trail.
    function initiateTransfer(uint256 id, address to) external whenNotPaused {
        address holder = registry.holderOf(id);
        if (msg.sender != holder) revert NotCurrentHolder(msg.sender, holder);
        if (to == address(0)) revert ZeroAddress();
        if (to == msg.sender) revert CannotTransferToSelf();
        if (_pending[id].to != address(0)) revert TransferAlreadyPending(id);

        // Reject early if the receiver holds no custody-capable role, so the
        // item is never stranded InTransit toward an address that cannot accept.
        _statusForReceiver(to);

        EvidenceRegistry.Status prev = registry.statusOf(id);
        uint64 now64 = uint64(block.timestamp);

        _pending[id] = Pending({to: to, prevStatus: prev, initiatedAt: now64});

        registry.applyCustody(
            id, msg.sender, holder, EvidenceRegistry.Status.InTransit, bytes32("TRANSFER_INIT")
        );
        emit TransferInitiated(id, msg.sender, to, now64);
    }

    /// @notice Step 2 of 2. Only the named receiver can complete the handover,
    ///         and the resulting status is derived from THEIR role.
    function acceptTransfer(uint256 id) external whenNotPaused {
        Pending memory p = _pending[id];
        if (p.to == address(0)) revert NoPendingTransfer(id);
        if (msg.sender != p.to) revert NotIntendedReceiver(msg.sender, p.to);

        EvidenceRegistry.Status newStatus = _statusForReceiver(msg.sender);
        delete _pending[id];

        registry.applyCustody(id, msg.sender, msg.sender, newStatus, bytes32("TRANSFER_ACCEPT"));
        emit TransferAccepted(id, msg.sender, newStatus, uint64(block.timestamp));
    }

    /// @notice The named receiver refuses the item; custody reverts to the sender.
    function rejectTransfer(uint256 id) external whenNotPaused {
        Pending memory p = _pending[id];
        if (p.to == address(0)) revert NoPendingTransfer(id);
        if (msg.sender != p.to) revert NotIntendedReceiver(msg.sender, p.to);

        address holder = registry.holderOf(id);
        delete _pending[id];

        registry.applyCustody(id, msg.sender, holder, p.prevStatus, bytes32("TRANSFER_REJECT"));
        emit TransferRejected(id, msg.sender, uint64(block.timestamp));
    }

    /// @notice The sender withdraws the offer before it is accepted.
    function cancelTransfer(uint256 id) external whenNotPaused {
        Pending memory p = _pending[id];
        if (p.to == address(0)) revert NoPendingTransfer(id);

        address holder = registry.holderOf(id);
        if (msg.sender != holder) revert NotCurrentHolder(msg.sender, holder);

        delete _pending[id];

        registry.applyCustody(id, msg.sender, holder, p.prevStatus, bytes32("TRANSFER_CANCEL"));
        emit TransferCancelled(id, msg.sender, uint64(block.timestamp));
    }

    function pendingTransfer(uint256 id) external view returns (Pending memory) {
        return _pending[id];
    }

    /// @dev Maps the receiver's role to the resulting custody status. Checked in
    ///      a fixed order, so an address holding two roles resolves to the first
    ///      match - documented rather than left to chance.
    function _statusForReceiver(address to) private view returns (EvidenceRegistry.Status) {
        if (registry.hasRole(ROLE_MALKHANA, to)) return EvidenceRegistry.Status.Deposited;
        if (registry.hasRole(ROLE_FORENSIC, to)) return EvidenceRegistry.Status.AtForensic;
        if (registry.hasRole(ROLE_IO, to))       return EvidenceRegistry.Status.Seized;
        revert ReceiverNotAuthorized(to);
    }
}

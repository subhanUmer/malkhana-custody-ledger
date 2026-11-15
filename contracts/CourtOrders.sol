// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlBase} from "./AccessControlBase.sol";
import {EvidenceRegistry} from "./EvidenceRegistry.sol";

/// @notice Notified when evidence is finally disposed of, so an external
///         destruction contractor or auction system can act on the order.
interface IDisposalHandler {
    function onDisposal(uint256 evidenceId, bytes32 caseId) external;
}

/// @title  CourtOrders
/// @notice Judicial actions: freeze, release to court, and final disposal.
/// @dev    The only contract authorized as a `courtWriter` on the registry,
///         which makes it the sole path that can freeze or terminally dispose
///         of a record. Separating this from CustodyManager means a bug in the
///         day-to-day transfer workflow cannot reach the judicial powers.
contract CourtOrders is AccessControlBase {
    EvidenceRegistry public immutable registry;

    /// @dev Optional. When unset, disposal simply records on-chain.
    address public disposalHandler;

    error RolesManagedByRegistryError();
    error PauseManagedByRegistry();
    error NotDisputed(uint256 id);
    error AlreadyDisputed(uint256 id);
    error CannotRestoreToDisputed();

    event DisputeRaised(uint256 indexed id, address indexed by, bytes32 reasonHash, uint64 occurredAt);
    event DisputeResolved(uint256 indexed id, address indexed by, EvidenceRegistry.Status restoredTo, uint64 occurredAt);
    event ProductionOrdered(uint256 indexed id, address indexed court, uint64 occurredAt);
    event DisposalOrdered(uint256 indexed id, address indexed court, uint64 occurredAt);
    event DisposalHandlerSet(address indexed handler);
    event DisposalNotificationFailed(uint256 indexed id, address indexed handler);

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

    function setDisposalHandler(address handler) external onlyRole(ROLE_ADMIN) {
        disposalHandler = handler;
        emit DisposalHandlerSet(handler);
    }

    // -------------------------------------------------------- court actions
    /// @notice Freeze a record pending enquiry. Custody does not move - the item
    ///         stays where it is, but no further transfer can be recorded until
    ///         the court resolves it.
    function raiseDispute(uint256 id, bytes32 reasonHash) external whenNotPaused onlyRole(ROLE_COURT) {
        if (registry.statusOf(id) == EvidenceRegistry.Status.Disputed) revert AlreadyDisputed(id);

        address holder = registry.holderOf(id);
        registry.applyCourtAction(
            id, msg.sender, holder, EvidenceRegistry.Status.Disputed, bytes32("DISPUTE_RAISE")
        );
        emit DisputeRaised(id, msg.sender, reasonHash, uint64(block.timestamp));
    }

    /// @notice Lift a freeze and put the record back into the normal workflow.
    function resolveDispute(
        uint256 id,
        address restoreHolder,
        EvidenceRegistry.Status restoreStatus
    ) external whenNotPaused onlyRole(ROLE_COURT) {
        if (registry.statusOf(id) != EvidenceRegistry.Status.Disputed) revert NotDisputed(id);
        if (restoreStatus == EvidenceRegistry.Status.Disputed) revert CannotRestoreToDisputed();
        if (restoreHolder == address(0)) revert ZeroAddress();

        registry.applyCourtAction(
            id, msg.sender, restoreHolder, restoreStatus, bytes32("DISPUTE_RESOLVE")
        );
        emit DisputeResolved(id, msg.sender, restoreStatus, uint64(block.timestamp));
    }

    /// @notice Produce the item before the court; the court becomes the custodian.
    function orderProduction(uint256 id) external whenNotPaused onlyRole(ROLE_COURT) {
        registry.applyCourtAction(
            id, msg.sender, msg.sender, EvidenceRegistry.Status.InCourt, bytes32("COURT_PRODUCE")
        );
        emit ProductionOrdered(id, msg.sender, uint64(block.timestamp));
    }

    /// @notice Final, irreversible disposal.
    /// @dev    Checks-Effects-Interactions: the registry is updated to Disposed
    ///         BEFORE the external handler is called, so a malicious handler
    ///         re-entering finds a terminal record. `nonReentrant` is a second,
    ///         independent control, and try/catch keeps a broken third-party
    ///         handler from blocking a lawful court order.
    function orderDisposal(uint256 id) external whenNotPaused nonReentrant onlyRole(ROLE_COURT) {
        // --- checks
        bytes32 caseId = registry.getEvidence(id).caseId;

        // --- effects
        registry.applyCourtAction(
            id, msg.sender, msg.sender, EvidenceRegistry.Status.Disposed, bytes32("COURT_DISPOSE")
        );
        emit DisposalOrdered(id, msg.sender, uint64(block.timestamp));

        // --- interactions
        address handler = disposalHandler;
        if (handler != address(0)) {
            try IDisposalHandler(handler).onDisposal(id, caseId) {
                // notified
            } catch {
                emit DisposalNotificationFailed(id, handler);
            }
        }
    }
}

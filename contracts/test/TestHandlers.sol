// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDisposalHandler, CourtOrders} from "../CourtOrders.sol";
import {EvidenceRegistry} from "../EvidenceRegistry.sol";

/// @notice TEST ONLY. A well-behaved disposal handler, used to prove the happy
///         path notification works before the malicious variant is tested.
contract BenignDisposalHandler is IDisposalHandler {
    uint256 public callCount;
    uint256 public lastEvidenceId;
    bytes32 public lastCaseId;

    function onDisposal(uint256 evidenceId, bytes32 caseId) external override {
        callCount += 1;
        lastEvidenceId = evidenceId;
        lastCaseId = caseId;
    }
}

/// @notice TEST ONLY. A handler that reverts, to prove a broken third-party
///         integration cannot block a lawful court disposal order.
contract RevertingDisposalHandler is IDisposalHandler {
    function onDisposal(uint256, bytes32) external pure override {
        revert("handler is down");
    }
}

/// @notice TEST ONLY - attack scenario. A disposal handler that attempts to
///         re-enter CourtOrders during the disposal callback.
/// @dev    In the test this contract is deliberately GRANTED ROLE_COURT, so the
///         role check cannot be what stops it. That isolates the reentrancy
///         guard and the terminal-state check as the controls actually under
///         test, rather than letting authorization mask the result.
contract ReentrantDisposalHandler is IDisposalHandler {
    CourtOrders public immutable court;
    EvidenceRegistry public immutable registry;

    uint256 public attempts;
    bool public reenteredSameId;
    bool public reenteredOtherId;
    bool public reenteredDispute;
    uint256 public otherId;

    constructor(address court_, address registry_) {
        court = CourtOrders(court_);
        registry = EvidenceRegistry(registry_);
    }

    function setOtherId(uint256 id) external {
        otherId = id;
    }

    function onDisposal(uint256 evidenceId, bytes32) external override {
        attempts += 1;

        // 1. Re-enter the same function on the same record.
        try court.orderDisposal(evidenceId) {
            reenteredSameId = true;
        } catch {}

        // 2. Re-enter the same function on a DIFFERENT record, to show the guard
        //    is contract-wide and not merely per-record.
        if (otherId != 0) {
            try court.orderDisposal(otherId) {
                reenteredOtherId = true;
            } catch {}
        }

        // 3. Re-enter a different state-changing court function.
        try court.raiseDispute(evidenceId, bytes32("REENTRY")) {
            reenteredDispute = true;
        } catch {}
    }
}

/// @notice TEST ONLY - attack scenario. Attempts to call the registry's
///         writer-only entry points directly, bypassing CustodyManager and
///         CourtOrders entirely.
contract DirectWriteAttacker {
    EvidenceRegistry public immutable registry;

    constructor(address registry_) {
        registry = EvidenceRegistry(registry_);
    }

    function tryApplyCustody(uint256 id, address newHolder) external {
        registry.applyCustody(id, msg.sender, newHolder, EvidenceRegistry.Status.Deposited, bytes32("FORGED"));
    }

    function tryApplyCourtAction(uint256 id, address newHolder) external {
        registry.applyCourtAction(id, msg.sender, newHolder, EvidenceRegistry.Status.Disposed, bytes32("FORGED"));
    }
}

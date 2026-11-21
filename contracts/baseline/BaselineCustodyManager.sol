// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaselineAccessControl} from "./BaselineAccessControl.sol";
import {BaselineRegistry} from "./BaselineRegistry.sol";

/// @notice BASELINE ONLY. Same two-phase workflow and the same cross-contract
///         call into the registry as CustodyManager, so the gas delta reflects
///         the storage/error patterns and not a change of architecture.
contract BaselineCustodyManager is BaselineAccessControl {
    BaselineRegistry public immutable registry;

    // Unpacked: three separate slots instead of one.
    struct Pending {
        address to;
        uint256 prevStatus;
        uint256 initiatedAt;
    }

    mapping(uint256 => Pending) private _pending;

    event TransferInitiated(uint256 indexed id, address indexed from, address indexed to);
    event TransferAccepted(uint256 indexed id, address indexed by, uint256 newStatus);

    constructor(address registry_, address admin) BaselineAccessControl(admin) {
        require(registry_ != address(0), "CustodyManager: zero address not permitted");
        registry = BaselineRegistry(registry_);
    }

    function hasRole(bytes32 role, address account) public view override returns (bool) {
        return registry.hasRole(role, account);
    }

    function paused() public view override returns (bool) {
        return registry.paused();
    }

    function initiateTransfer(uint256 id, address to) external whenNotPaused {
        address holder = registry.holderOf(id);
        require(msg.sender == holder, "CustodyManager: caller is not the current holder");
        require(to != address(0), "CustodyManager: zero address not permitted");
        require(to != msg.sender, "CustodyManager: cannot transfer to self");
        require(_pending[id].to == address(0), "CustodyManager: a transfer is already pending");

        _statusForReceiver(to);

        _pending[id] = Pending({
            to: to,
            prevStatus: uint256(registry.statusOf(id)),
            initiatedAt: block.timestamp
        });

        registry.applyCustody(id, msg.sender, holder, BaselineRegistry.Status.InTransit, "TRANSFER_INIT");
        emit TransferInitiated(id, msg.sender, to);
    }

    function acceptTransfer(uint256 id) external whenNotPaused {
        Pending memory p = _pending[id];
        require(p.to != address(0), "CustodyManager: no pending transfer for this id");
        require(msg.sender == p.to, "CustodyManager: caller is not the intended receiver");

        BaselineRegistry.Status newStatus = _statusForReceiver(msg.sender);
        delete _pending[id];

        registry.applyCustody(id, msg.sender, msg.sender, newStatus, "TRANSFER_ACCEPT");
        emit TransferAccepted(id, msg.sender, uint256(newStatus));
    }

    function pendingTransfer(uint256 id) external view returns (Pending memory) {
        return _pending[id];
    }

    function _statusForReceiver(address to) private view returns (BaselineRegistry.Status) {
        if (registry.hasRole(ROLE_MALKHANA, to)) return BaselineRegistry.Status.Deposited;
        if (registry.hasRole(ROLE_FORENSIC, to)) return BaselineRegistry.Status.AtForensic;
        if (registry.hasRole(ROLE_IO, to))       return BaselineRegistry.Status.Seized;
        revert("CustodyManager: receiver holds no custody-capable role");
    }
}

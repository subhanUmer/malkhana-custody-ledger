// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  AccessControlBase
/// @notice Reusable authorization, emergency-pause and reentrancy behaviour.
/// @dev    Inherited by EvidenceRegistry, CustodyManager and CourtOrders. The
///         three derived contracts each need the same role checks, the same
///         pause switch and the same reentrancy guard, so the behaviour lives
///         here once rather than being copied three times. This is inheritance
///         for shared *behaviour*, not merely to split files.
abstract contract AccessControlBase {
    // ------------------------------------------------------------- roles
    // Roles mirror the real custody chain under Police Rules 1934 r. 22.70.
    bytes32 public constant ROLE_ADMIN    = keccak256("ROLE_ADMIN");
    bytes32 public constant ROLE_IO       = keccak256("ROLE_IO");       // Investigating Officer
    bytes32 public constant ROLE_MALKHANA = keccak256("ROLE_MALKHANA"); // Malkhana Officer (moharrir)
    bytes32 public constant ROLE_FORENSIC = keccak256("ROLE_FORENSIC"); // PFSA analyst
    bytes32 public constant ROLE_COURT    = keccak256("ROLE_COURT");    // Court / registrar

    mapping(bytes32 => mapping(address => bool)) private _roles;

    /// @dev Guards against the last admin locking everyone out of the system.
    uint256 private _adminCount;

    bool private _paused;

    /// @dev 1 = idle, 2 = entered. Starts at 1 so the first call writes a warm slot.
    uint256 private _entered;

    error Unauthorized(address account, bytes32 role);
    error ContractPaused();
    error ReentrantCall();
    error ZeroAddress();
    error LastAdmin();
    error RolesManagedByRegistry();

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed by);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed by);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _roles[ROLE_ADMIN][admin] = true;
        _adminCount = 1;
        _entered = 1;
        emit RoleGranted(ROLE_ADMIN, admin, msg.sender);
    }

    modifier onlyRole(bytes32 role) {
        if (!hasRole(role, msg.sender)) revert Unauthorized(msg.sender, role);
        _;
    }

    modifier whenNotPaused() {
        if (paused()) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 2) revert ReentrantCall();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @notice Overridable so a derived contract can defer to a single shared
    ///         role authority instead of keeping its own table. CustodyManager
    ///         and CourtOrders both override this to read EvidenceRegistry, so
    ///         an officer is granted their role exactly once, system-wide.
    function hasRole(bytes32 role, address account) public view virtual returns (bool) {
        return _roles[role][account];
    }

    function adminCount() external view returns (uint256) {
        return _adminCount;
    }

    /// @notice Only an existing admin may grant any role. This is what stops a
    ///         Malkhana Officer from awarding themselves ROLE_COURT.
    function grantRole(bytes32 role, address account) external virtual onlyRole(ROLE_ADMIN) {
        if (account == address(0)) revert ZeroAddress();
        if (_roles[role][account]) return;
        _roles[role][account] = true;
        if (role == ROLE_ADMIN) _adminCount += 1;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external virtual onlyRole(ROLE_ADMIN) {
        if (!_roles[role][account]) return;
        // Removing the final admin would leave the system permanently unmanageable.
        if (role == ROLE_ADMIN && _adminCount == 1) revert LastAdmin();
        _roles[role][account] = false;
        if (role == ROLE_ADMIN) _adminCount -= 1;
        emit RoleRevoked(role, account, msg.sender);
    }

    /// @notice Overridable for the same reason as `hasRole`: the derived
    ///         workflow contracts defer to the registry so that one pause
    ///         call freezes the entire system rather than one contract.
    function paused() public view virtual returns (bool) {
        return _paused;
    }

    /// @notice Emergency stop. Freezes every state-changing custody action while
    ///         leaving all reads open, so an ongoing investigation can still be
    ///         inspected during an incident.
    function pause() external virtual onlyRole(ROLE_ADMIN) {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external virtual onlyRole(ROLE_ADMIN) {
        _paused = false;
        emit Unpaused(msg.sender);
    }
}

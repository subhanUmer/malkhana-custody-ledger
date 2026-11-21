// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice BASELINE ONLY - the unoptimized counterpart of AccessControlBase,
///         kept for gas comparison. Identical behaviour and identical call
///         graph; the only differences are the four patterns under measurement.
///         Difference here: require(string) instead of custom errors.
abstract contract BaselineAccessControl {
    bytes32 public constant ROLE_ADMIN    = keccak256("ROLE_ADMIN");
    bytes32 public constant ROLE_IO       = keccak256("ROLE_IO");
    bytes32 public constant ROLE_MALKHANA = keccak256("ROLE_MALKHANA");
    bytes32 public constant ROLE_FORENSIC = keccak256("ROLE_FORENSIC");
    bytes32 public constant ROLE_COURT    = keccak256("ROLE_COURT");

    mapping(bytes32 => mapping(address => bool)) private _roles;
    uint256 private _adminCount;
    bool private _paused;
    uint256 private _entered;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed by);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed by);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    constructor(address admin) {
        require(admin != address(0), "AccessControl: zero address not permitted");
        _roles[ROLE_ADMIN][admin] = true;
        _adminCount = 1;
        _entered = 1;
        emit RoleGranted(ROLE_ADMIN, admin, msg.sender);
    }

    modifier onlyRole(bytes32 role) {
        require(hasRole(role, msg.sender), "AccessControl: caller does not have the required role");
        _;
    }

    modifier whenNotPaused() {
        require(!paused(), "AccessControl: contract is currently paused");
        _;
    }

    modifier nonReentrant() {
        require(_entered != 2, "AccessControl: reentrant call rejected");
        _entered = 2;
        _;
        _entered = 1;
    }

    function hasRole(bytes32 role, address account) public view virtual returns (bool) {
        return _roles[role][account];
    }

    function paused() public view virtual returns (bool) {
        return _paused;
    }

    function grantRole(bytes32 role, address account) external virtual onlyRole(ROLE_ADMIN) {
        require(account != address(0), "AccessControl: zero address not permitted");
        if (_roles[role][account]) return;
        _roles[role][account] = true;
        if (role == ROLE_ADMIN) _adminCount += 1;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external virtual onlyRole(ROLE_ADMIN) {
        if (!_roles[role][account]) return;
        require(!(role == ROLE_ADMIN && _adminCount == 1), "AccessControl: cannot remove the last admin");
        _roles[role][account] = false;
        if (role == ROLE_ADMIN) _adminCount -= 1;
        emit RoleRevoked(role, account, msg.sender);
    }

    function pause() external virtual onlyRole(ROLE_ADMIN) {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external virtual onlyRole(ROLE_ADMIN) {
        _paused = false;
        emit Unpaused(msg.sender);
    }
}

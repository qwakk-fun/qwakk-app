// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQorePQC} from "./interfaces/IQorePQC.sol";

/// @dev The three ERC-20 calls the vault makes. QoreChain Diana's fUSD, fETH and
///      fBTC are plain ERC-20 contracts (`/cosmos/evm/erc20/v1/token_pairs`,
///      `contract_owner: OWNER_EXTERNAL`).
interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title Qwakk Pond Vault
/// @author Qwakk
/// @notice A post-quantum guarded vault for Qwakk's interface fees on the
///         QoreChain EVM.
///
///         Anyone can deposit QOR or ERC-20 tokens. Every action that could move
///         funds or weaken the vault needs two independent authorisations:
///
///         1. a transaction from `owner`, which on QoreChain can only be sent
///            inside an EVM authorisation window that the owner opened with a
///            hybrid (secp256k1 + ML-DSA-87) signed native message, and
///         2. an ML-DSA-87 (FIPS 204) signature by the `approver` account's
///            registered post-quantum key over a domain-separated message,
///            checked on chain by the `pqcVerify` precompile against the key
///            the `pqcKeyStatus` precompile reports.
///
///         Approved actions wait out a timelock before anyone can execute them,
///         and withdrawals are limited by a per-token daily cap. `pause` and
///         `cancel` only reduce what the vault can do, so the owner or the
///         guardian may call them without a post-quantum approval.
///
/// @dev Approval message (203 bytes, every field fixed width, so packing is
///      unambiguous):
///
///          "qwakk-vault-v1" (bytes14) | chainid (uint256) | vault (address)
///          | action (uint8) | token (address) | to (address) | amount (uint256)
///          | nonce (uint256) | deadline (uint256)
///
///      The nonce is the vault's sequential approval counter, so every approval
///      is single use and bound to one chain, one vault and one action.
contract PondVault {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice What an approval authorises. The numbers are part of the signed
    ///         message: never reorder.
    enum Action {
        None, // 0: never valid
        Withdraw, // 1: send `amount` of `token` to `to` (token 0 = native QOR)
        SetDailyCap, // 2: set the daily withdrawal cap of `token` to `amount`
        SetTimelock, // 3: set the timelock to `amount` seconds
        SetOwner, // 4: hand the owner role to `to`
        SetApprover, // 5: hand the approver role to `to`
        SetGuardian, // 6: hand the guardian role to `to` (0 removes it)
        Unpause // 7: lift a pause (immediate, not queued)
    }

    enum Status {
        None,
        Queued,
        Executed,
        Cancelled
    }

    struct QueuedAction {
        Action action;
        Status status;
        uint64 nonce;
        uint64 eta;
        address token;
        address to;
        uint256 amount;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Domain tag at the start of every approval message.
    bytes14 public constant DOMAIN = "qwakk-vault-v1";

    /// @notice `pqcVerify` precompile (`PRECOMPILE_ADDRESSES.pqcVerify`, @qorechain/evm@0.14.0).
    address public constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    /// @notice `pqcKeyStatus` precompile (`PRECOMPILE_ADDRESSES.pqcKeyStatus`, @qorechain/evm@0.14.0).
    address public constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    /// @notice The token id the vault uses for native QOR (18 decimals on the EVM lane).
    address public constant NATIVE = address(0);

    /// @notice `algorithmId` of ML-DSA-87 in `pqcKeyStatus`.
    uint8 public constant ML_DSA_87 = 1;
    uint256 public constant ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;
    uint256 public constant ML_DSA_87_SIGNATURE_LENGTH = 4627;

    uint256 public constant MIN_TIMELOCK = 1 minutes;
    uint256 public constant MAX_TIMELOCK = 30 days;
    /// @notice A queued action that is not executed within this time after its
    ///         eta expires and can never run.
    uint256 public constant GRACE_PERIOD = 7 days;
    /// @notice An approval may not be valid for longer than this, so a signed
    ///         but unused approval cannot linger.
    uint256 public constant MAX_APPROVAL_TTL = 1 days;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice Sends every sensitive transaction.
    address public owner;
    /// @notice Whose registered ML-DSA-87 key must sign every sensitive action.
    address public approver;
    /// @notice May pause and cancel, nothing else. Zero when unset.
    address public guardian;

    /// @notice While paused, no withdrawal can be queued or executed.
    bool public paused;
    /// @notice Seconds between queueing an action and its earliest execution.
    uint64 public timelock;
    /// @notice The nonce the next approval must carry.
    uint64 public nonce;
    /// @notice Number of actions ever queued. Ids run from 1 to actionCount.
    uint256 public actionCount;

    /// @notice Daily withdrawal cap per token, in the token's base units
    ///         (wei for native QOR). Zero blocks withdrawals of that token.
    mapping(address token => uint256) public dailyCap;

    mapping(uint256 id => QueuedAction) private _actions;
    mapping(address token => uint256) private _spentDay;
    mapping(address token => uint256) private _spentAmount;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Deposited(address indexed token, address indexed from, uint256 amount);
    event ApprovalVerified(uint64 indexed nonce, address indexed approver, Action action, bytes32 messageHash);
    event ActionQueued(
        uint256 indexed id, Action indexed action, address token, address to, uint256 amount, uint64 nonce, uint64 eta
    );
    event ActionExecuted(uint256 indexed id, Action indexed action);
    event ActionCancelled(uint256 indexed id, address indexed by);
    event Withdrawn(uint256 indexed id, address indexed token, address indexed to, uint256 amount);
    event DailyCapSet(address indexed token, uint256 cap);
    event TimelockSet(uint256 timelock);
    event OwnerSet(address indexed previousOwner, address indexed newOwner);
    event ApproverSet(address indexed previousApprover, address indexed newApprover);
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotOwner();
    error NotOwnerOrGuardian();
    error VaultPaused();
    error VaultNotPaused();
    error ApprovalExpired();
    error ApprovalTooLong();
    error InvalidApproval();
    error ApproverKeyUnavailable(address account);
    error InvalidParameters();
    error NotQueued(uint256 id);
    error TimelockActive(uint64 eta);
    error ActionExpired(uint256 id);
    error DailyCapExceeded(address token, uint256 remaining);
    error GuardianCannotCancel(uint256 id);
    error TransferFailed();
    error Reentrancy();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner && (msg.sender != guardian || guardian == address(0))) revert NotOwnerOrGuardian();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    /// @param owner_          Sends every sensitive transaction.
    /// @param approver_       Its registered ML-DSA-87 key signs every sensitive
    ///                        action. Must already have a key registered with a
    ///                        proof of possession. May equal `owner_`.
    /// @param guardian_       May pause and cancel. Zero for none.
    /// @param timelock_       Seconds, MIN_TIMELOCK to MAX_TIMELOCK.
    /// @param nativeDailyCap_ Daily cap for native QOR, in wei.
    constructor(address owner_, address approver_, address guardian_, uint256 timelock_, uint256 nativeDailyCap_) {
        if (owner_ == address(0) || approver_ == address(0)) revert InvalidParameters();
        if (timelock_ < MIN_TIMELOCK || timelock_ > MAX_TIMELOCK) revert InvalidParameters();
        _requireUsableKey(approver_);

        owner = owner_;
        approver = approver_;
        guardian = guardian_;
        timelock = uint64(timelock_);
        dailyCap[NATIVE] = nativeDailyCap_;

        emit OwnerSet(address(0), owner_);
        emit ApproverSet(address(0), approver_);
        emit GuardianSet(address(0), guardian_);
        emit TimelockSet(timelock_);
        emit DailyCapSet(NATIVE, nativeDailyCap_);
    }

    // ------------------------------------------------------------------
    // Deposits (open to anyone)
    // ------------------------------------------------------------------

    receive() external payable {
        emit Deposited(NATIVE, msg.sender, msg.value);
    }

    /// @notice Pull `amount` of an ERC-20 token from the caller (approve first).
    ///         Plain `transfer`s to the vault also count; they just emit no event here.
    function depositToken(address token, uint256 amount) external nonReentrant {
        if (token.code.length == 0 || amount == 0) revert InvalidParameters();
        uint256 before = IERC20Like(token).balanceOf(address(this));
        _callToken(token, abi.encodeCall(IERC20Like.transferFrom, (msg.sender, address(this), amount)));
        emit Deposited(token, msg.sender, IERC20Like(token).balanceOf(address(this)) - before);
    }

    // ------------------------------------------------------------------
    // Sensitive actions: owner + ML-DSA-87 approval
    // ------------------------------------------------------------------

    /// @notice Queue an approved action. It can be executed after the timelock.
    /// @param deadline  Unix time after which the approval is refused. At most
    ///                  MAX_APPROVAL_TTL ahead.
    /// @param signature ML-DSA-87 signature by the approver's registered key over
    ///                  `approvalMessage(action, token, to, amount, nonce, deadline)`.
    function queue(Action action, address token, address to, uint256 amount, uint256 deadline, bytes calldata signature)
        external
        onlyOwner
        nonReentrant
        returns (uint256 id)
    {
        _validate(action, token, to, amount);
        if (action == Action.Withdraw && paused) revert VaultPaused();
        uint64 used = _consumeApproval(action, token, to, amount, deadline, signature);

        id = ++actionCount;
        uint64 eta = uint64(block.timestamp) + timelock;
        _actions[id] = QueuedAction({
            action: action, status: Status.Queued, nonce: used, eta: eta, token: token, to: to, amount: amount
        });
        emit ActionQueued(id, action, token, to, amount, used, eta);
    }

    /// @notice Lift a pause. Needs the owner and an ML-DSA-87 approval, and takes
    ///         effect at once: queued actions still wait for their own eta.
    function unpause(uint256 deadline, bytes calldata signature) external onlyOwner nonReentrant {
        if (!paused) revert VaultNotPaused();
        _consumeApproval(Action.Unpause, address(0), address(0), 0, deadline, signature);
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Run a queued action once its timelock has passed. Anyone may call:
    ///         the action already carries both authorisations.
    function execute(uint256 id) external nonReentrant {
        QueuedAction storage a = _actions[id];
        if (a.status != Status.Queued) revert NotQueued(id);
        if (block.timestamp < a.eta) revert TimelockActive(a.eta);
        if (block.timestamp > uint256(a.eta) + GRACE_PERIOD) revert ActionExpired(id);
        a.status = Status.Executed;

        Action action = a.action;
        if (action == Action.Withdraw) {
            if (paused) revert VaultPaused();
            _spend(a.token, a.amount);
            _send(a.token, a.to, a.amount);
            emit Withdrawn(id, a.token, a.to, a.amount);
        } else if (action == Action.SetDailyCap) {
            dailyCap[a.token] = a.amount;
            emit DailyCapSet(a.token, a.amount);
        } else if (action == Action.SetTimelock) {
            timelock = uint64(a.amount);
            emit TimelockSet(a.amount);
        } else if (action == Action.SetOwner) {
            emit OwnerSet(owner, a.to);
            owner = a.to;
        } else if (action == Action.SetApprover) {
            // Checked again: the key may have been rotated away since queueing.
            _requireUsableKey(a.to);
            emit ApproverSet(approver, a.to);
            approver = a.to;
        } else {
            // _validate admits nothing else into the queue.
            emit GuardianSet(guardian, a.to);
            guardian = a.to;
        }
        emit ActionExecuted(id, action);
    }

    // ------------------------------------------------------------------
    // Safety valves: owner or guardian, no approval needed
    // ------------------------------------------------------------------

    /// @notice Stop all withdrawals until an approved `unpause`.
    function pause() external onlyOwnerOrGuardian {
        if (paused) revert VaultPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Drop a queued action. The guardian cannot cancel its own
    ///         replacement, so the owner can always remove a bad guardian.
    function cancel(uint256 id) external onlyOwnerOrGuardian {
        QueuedAction storage a = _actions[id];
        if (a.status != Status.Queued) revert NotQueued(id);
        if (msg.sender != owner && a.action == Action.SetGuardian) revert GuardianCannotCancel(id);
        a.status = Status.Cancelled;
        emit ActionCancelled(id, msg.sender);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice The exact bytes the approver signs for an action on this vault
    ///         and chain. The CLI compares its own encoding with this before signing.
    function approvalMessage(
        Action action,
        address token,
        address to,
        uint256 amount,
        uint256 approvalNonce,
        uint256 deadline
    ) external view returns (bytes memory) {
        return _message(action, token, to, amount, approvalNonce, deadline);
    }

    function getAction(uint256 id) external view returns (QueuedAction memory) {
        return _actions[id];
    }

    /// @notice Whether `account` has a key the vault would accept, and that key.
    function keyStatus(address account) external view returns (bool usable, bytes memory pubkey) {
        return _keyStatus(account);
    }

    /// @notice Amount of `token` withdrawn in the current UTC day.
    function spentToday(address token) public view returns (uint256) {
        return _spentDay[token] == block.timestamp / 1 days ? _spentAmount[token] : 0;
    }

    /// @notice Amount of `token` that may still be withdrawn in the current UTC day.
    function remainingToday(address token) external view returns (uint256) {
        uint256 spent = spentToday(token);
        uint256 cap = dailyCap[token];
        return spent >= cap ? 0 : cap - spent;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _message(Action action, address token, address to, uint256 amount, uint256 approvalNonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            DOMAIN, block.chainid, address(this), uint8(action), token, to, amount, approvalNonce, deadline
        );
    }

    /// @dev Checks deadline, then the signature against the approver's key as
    ///      the chain reports it right now, then uses up the nonce.
    function _consumeApproval(
        Action action,
        address token,
        address to,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) internal returns (uint64 used) {
        if (block.timestamp > deadline) revert ApprovalExpired();
        if (deadline > block.timestamp + MAX_APPROVAL_TTL) revert ApprovalTooLong();
        if (signature.length != ML_DSA_87_SIGNATURE_LENGTH) revert InvalidApproval();

        used = nonce;
        address signer = approver;
        bytes memory message = _message(action, token, to, amount, used, deadline);
        bytes memory pubkey = _requireUsableKey(signer);
        if (!_pqcVerify(pubkey, signature, message)) revert InvalidApproval();

        nonce = used + 1;
        emit ApprovalVerified(used, signer, action, keccak256(message));
    }

    /// @dev Canonical parameters per action: fields an action does not use must be zero.
    function _validate(Action action, address token, address to, uint256 amount) internal view {
        if (action == Action.Withdraw) {
            if (to == address(0) || to == address(this) || amount == 0) revert InvalidParameters();
            if (token != NATIVE && token.code.length == 0) revert InvalidParameters();
        } else if (action == Action.SetDailyCap) {
            if (to != address(0)) revert InvalidParameters();
            if (token != NATIVE && token.code.length == 0) revert InvalidParameters();
        } else if (action == Action.SetTimelock) {
            if (token != address(0) || to != address(0)) revert InvalidParameters();
            if (amount < MIN_TIMELOCK || amount > MAX_TIMELOCK) revert InvalidParameters();
        } else if (action == Action.SetOwner) {
            if (token != address(0) || to == address(0) || amount != 0) revert InvalidParameters();
        } else if (action == Action.SetApprover) {
            if (token != address(0) || to == address(0) || amount != 0) revert InvalidParameters();
            _requireUsableKey(to);
        } else if (action == Action.SetGuardian) {
            if (token != address(0) || amount != 0) revert InvalidParameters();
        } else {
            // None and Unpause cannot be queued.
            revert InvalidParameters();
        }
    }

    function _spend(address token, uint256 amount) internal {
        uint256 today = block.timestamp / 1 days;
        uint256 spent = _spentDay[token] == today ? _spentAmount[token] : 0;
        uint256 cap = dailyCap[token];
        if (spent + amount > cap) revert DailyCapExceeded(token, spent >= cap ? 0 : cap - spent);
        _spentDay[token] = today;
        _spentAmount[token] = spent + amount;
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _callToken(token, abi.encodeCall(IERC20Like.transfer, (to, amount)));
        }
    }

    /// @dev Accepts tokens that return true or nothing; refuses false, a revert or a non-contract.
    function _callToken(address token, bytes memory data) internal {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TransferFailed();
        }
    }

    function _requireUsableKey(address account) internal view returns (bytes memory pubkey) {
        bool usable;
        (usable, pubkey) = _keyStatus(account);
        if (!usable) revert ApproverKeyUnavailable(account);
    }

    /// @dev Usable = registered, ML-DSA-87, registered with a proof of
    ///      possession (as the precompile docs require for a key a contract
    ///      relies on) and exactly 2,592 bytes. An inactive precompile answers
    ///      with empty data, which reads as unusable.
    function _keyStatus(address account) internal view returns (bool usable, bytes memory pubkey) {
        (bool ok, bytes memory ret) = PQC_KEY_STATUS.staticcall(abi.encodeCall(IQorePQC.pqcKeyStatus, (account)));
        // Four head words plus the length word of `pubkey`.
        if (!ok || ret.length < 160) return (false, "");
        bool registered;
        uint8 algorithmId;
        bool possessionProven;
        (registered, algorithmId, pubkey, possessionProven) = abi.decode(ret, (bool, uint8, bytes, bool));
        usable =
            registered && algorithmId == ML_DSA_87 && possessionProven && pubkey.length == ML_DSA_87_PUBLIC_KEY_LENGTH;
        if (!usable) pubkey = "";
    }

    /// @dev Fails closed: a failed call, short or odd return data reads as invalid.
    function _pqcVerify(bytes memory pubkey, bytes calldata signature, bytes memory message)
        internal
        view
        returns (bool)
    {
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeCall(IQorePQC.pqcVerify, (pubkey, signature, message)));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }
}

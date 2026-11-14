// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {PondVault} from "../src/PondVault.sol";
import {IQorePQC} from "../src/interfaces/IQorePQC.sol";
import {PondVaultBase} from "./utils/PondVaultBase.sol";

/// @dev Fuzzed parameters cannot carry real ML-DSA-87 signatures (signing
///      happens off chain), so these suites answer every pqcVerify call with
///      true and test only the timelock, cap and access logic. Signature
///      checking is covered with real vectors in PondVault.t.sol.
abstract contract PermissiveVerifier is PondVaultBase {
    bytes internal anySig;

    function setUp() public virtual override {
        super.setUp();
        vm.mockCall(PQC_VERIFY, abi.encodeWithSelector(IQorePQC.pqcVerify.selector), abi.encode(true));
        anySig = new bytes(4627);
    }

    function _queueWithdraw(PondVault target, address tokenId, uint256 amount) internal returns (uint256) {
        vm.prank(owner);
        return target.queue(PondVault.Action.Withdraw, tokenId, recipient, amount, block.timestamp + 1 hours, anySig);
    }
}

contract PondVaultFuzzTest is PermissiveVerifier {
    /// Execution succeeds exactly when timelock <= wait <= timelock + GRACE_PERIOD.
    function testFuzz_TimelockWindow(uint256 timelock, uint256 wait) public {
        timelock = bound(timelock, vault.MIN_TIMELOCK(), vault.MAX_TIMELOCK());
        wait = bound(wait, 0, timelock + vault.GRACE_PERIOD() + 30 days);
        PondVault v = _deployFresh(timelock, 1 ether);
        vm.deal(address(v), 1 ether);

        uint256 id = _queueWithdraw(v, address(0), 1);
        uint256 queuedAt = block.timestamp;
        vm.warp(queuedAt + wait);

        if (wait < timelock) {
            vm.expectRevert(abi.encodeWithSelector(PondVault.TimelockActive.selector, uint64(queuedAt + timelock)));
        } else if (wait > timelock + v.GRACE_PERIOD()) {
            vm.expectRevert(abi.encodeWithSelector(PondVault.ActionExpired.selector, id));
        }
        v.execute(id);
        if (wait >= timelock && wait <= timelock + v.GRACE_PERIOD()) assertEq(recipient.balance, 1);
    }

    /// A changed timelock never shortens an action that is already queued.
    function testFuzz_TimelockChangeKeepsQueuedEta(uint256 newTimelock) public {
        newTimelock = bound(newTimelock, vault.MIN_TIMELOCK(), vault.MAX_TIMELOCK());
        uint256 withdrawId = _queueWithdraw(vault, address(0), 1);
        uint64 eta = vault.getAction(withdrawId).eta;

        vm.prank(owner);
        uint256 setId = vault.queue(
            PondVault.Action.SetTimelock, address(0), address(0), newTimelock, block.timestamp + 1 hours, anySig
        );
        _waitTimelock();
        vault.execute(setId);
        assertEq(vault.timelock(), newTimelock);
        assertEq(vault.getAction(withdrawId).eta, eta);
    }

    /// Within one UTC day the vault never pays out more than the cap, and every
    /// withdrawal that fits is paid.
    function testFuzz_DailyCapWithinOneDay(uint256 cap, uint256[8] memory amounts) public {
        cap = bound(cap, 1, 1_000_000 ether);
        vm.warp(_dayStart(nowTs) + 1); // a full day ahead of us
        PondVault v = _deployFresh(vault.MIN_TIMELOCK(), cap);
        vm.deal(address(v), 2_000_000 ether);

        uint256[] memory ids = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) {
            amounts[i] = bound(amounts[i], 1, cap);
            ids[i] = _queueWithdraw(v, address(0), amounts[i]);
        }
        vm.warp(block.timestamp + v.MIN_TIMELOCK());

        uint256 paid;
        for (uint256 i = 0; i < 8; i++) {
            if (paid + amounts[i] > cap) {
                vm.expectRevert(abi.encodeWithSelector(PondVault.DailyCapExceeded.selector, address(0), cap - paid));
                v.execute(ids[i]);
            } else {
                v.execute(ids[i]);
                paid += amounts[i];
            }
            assertLe(v.spentToday(address(0)), cap);
            assertEq(v.remainingToday(address(0)), cap - paid);
        }
        assertEq(recipient.balance, paid);
    }

    /// The cap resets at the UTC day boundary, never earlier.
    function testFuzz_DailyCapResetsAtDayBoundary(uint256 cap, uint256 secondsIntoDay) public {
        cap = bound(cap, 1, 1_000_000 ether);
        secondsIntoDay = bound(secondsIntoDay, 0, 1 days - 1);
        uint256 dayStart = _dayStart(nowTs) + 1 days;
        vm.warp(dayStart);
        PondVault v = _deployFresh(vault.MIN_TIMELOCK(), cap);
        vm.deal(address(v), 3_000_000 ether);

        uint256 first = _queueWithdraw(v, address(0), cap);
        uint256 second = _queueWithdraw(v, address(0), cap);
        vm.warp(dayStart + v.MIN_TIMELOCK());
        v.execute(first);

        vm.warp(dayStart + v.MIN_TIMELOCK() + (secondsIntoDay % (1 days - v.MIN_TIMELOCK())));
        vm.expectRevert(abi.encodeWithSelector(PondVault.DailyCapExceeded.selector, address(0), 0));
        v.execute(second);

        vm.warp(dayStart + 1 days + secondsIntoDay);
        v.execute(second);
        assertEq(recipient.balance, 2 * cap);
    }

    /// A zero cap blocks every withdrawal of that token.
    function testFuzz_ZeroCapBlocksToken(uint256 amount) public {
        amount = bound(amount, 1, 10_000e6);
        uint256 id = _queueWithdraw(vault, tokenAddr, amount);
        _waitTimelock();
        vm.expectRevert(abi.encodeWithSelector(PondVault.DailyCapExceeded.selector, tokenAddr, 0));
        vault.execute(id);
    }

    /// Approvals are accepted only for deadlines in [now, now + MAX_APPROVAL_TTL].
    function testFuzz_ApprovalDeadlineWindow(uint256 deadline) public {
        deadline = bound(deadline, 0, block.timestamp + 3 days);
        uint256 ttl = vault.MAX_APPROVAL_TTL();
        vm.prank(owner);
        if (deadline < block.timestamp) {
            vm.expectRevert(PondVault.ApprovalExpired.selector);
        } else if (deadline > block.timestamp + ttl) {
            vm.expectRevert(PondVault.ApprovalTooLong.selector);
        }
        vault.queue(PondVault.Action.Withdraw, address(0), recipient, 1, deadline, anySig);
    }

    /// Nobody but the owner can queue, whatever the signature says.
    function testFuzz_OnlyOwnerQueues(address caller) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(PondVault.NotOwner.selector);
        vault.queue(PondVault.Action.Withdraw, address(0), recipient, 1, block.timestamp + 1 hours, anySig);
    }

    /// Nobody but the owner or the guardian can pause or cancel.
    function testFuzz_OnlyRolesPauseOrCancel(address caller) public {
        vm.assume(caller != owner && caller != guardian);
        uint256 id = _queueWithdraw(vault, address(0), 1);
        vm.startPrank(caller);
        vm.expectRevert(PondVault.NotOwnerOrGuardian.selector);
        vault.pause();
        vm.expectRevert(PondVault.NotOwnerOrGuardian.selector);
        vault.cancel(id);
        vm.stopPrank();
    }

    /// Every approval uses up exactly one nonce, in order.
    function testFuzz_NonceIsSequential(uint8 count) public {
        count = uint8(bound(count, 1, 20));
        for (uint256 i = 0; i < count; i++) {
            _queueWithdraw(vault, address(0), 1);
            assertEq(vault.nonce(), i + 1);
        }
        assertEq(vault.actionCount(), count);
    }

    function _deployFresh(uint256 timelock, uint256 cap) internal returns (PondVault) {
        return new PondVault(owner, owner, guardian, timelock, cap);
    }

    function _dayStart(uint256 t) internal pure returns (uint256) {
        return (t / 1 days) * 1 days;
    }
}

/// @dev Drives random deposits, queues, cancels, executions and time jumps.
contract PondVaultHandler is Test {
    PondVault internal immutable vault;
    address internal immutable owner;
    address internal immutable guardian;
    address internal immutable recipient;
    bytes internal sig = new bytes(4627);

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    mapping(uint256 day => uint256) public ghostPaidOnDay;
    uint256[] public touchedDays;

    constructor(PondVault vault_, address owner_, address guardian_, address recipient_) {
        vault = vault_;
        owner = owner_;
        guardian = guardian_;
        recipient = recipient_;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 100 ether);
        vm.deal(address(this), amount);
        (bool ok,) = address(vault).call{value: amount}("");
        require(ok);
        ghostDeposited += amount;
    }

    function queueWithdraw(uint256 amount) external {
        amount = bound(amount, 1, 10 ether);
        vm.prank(owner);
        try vault.queue(PondVault.Action.Withdraw, address(0), recipient, amount, block.timestamp + 1 hours, sig) {}
            catch {}
    }

    function cancel(uint256 id, bool asGuardian) external {
        uint256 count = vault.actionCount();
        if (count == 0) return;
        id = bound(id, 1, count);
        vm.prank(asGuardian ? guardian : owner);
        try vault.cancel(id) {} catch {}
    }

    function execute(uint256 id) external {
        uint256 count = vault.actionCount();
        if (count == 0) return;
        id = bound(id, 1, count);
        uint256 before = recipient.balance;
        try vault.execute(id) {
            uint256 paid = recipient.balance - before;
            ghostWithdrawn += paid;
            uint256 day = block.timestamp / 1 days;
            if (ghostPaidOnDay[day] == 0) touchedDays.push(day);
            ghostPaidOnDay[day] += paid;
        } catch {}
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 2 days));
    }

    function touchedDayCount() external view returns (uint256) {
        return touchedDays.length;
    }
}

contract PondVaultInvariantTest is StdInvariant, PermissiveVerifier {
    PondVaultHandler internal handler;
    uint256 internal startBalance;

    function setUp() public override {
        super.setUp();
        startBalance = vaultAddr.balance;
        handler = new PondVaultHandler(vault, owner, guardian, recipient);
        targetContract(address(handler));
    }

    /// No UTC day ever pays out more than the native cap.
    function invariant_NeverAboveDailyCap() public view {
        uint256 n = handler.touchedDayCount();
        for (uint256 i = 0; i < n; i++) {
            assertLe(handler.ghostPaidOnDay(handler.touchedDays(i)), NATIVE_CAP);
        }
        assertLe(vault.spentToday(address(0)), vault.dailyCap(address(0)));
    }

    /// Funds are conserved: what is in the vault is what came in minus what was paid.
    function invariant_BalanceIsConserved() public view {
        assertEq(vaultAddr.balance, startBalance + handler.ghostDeposited() - handler.ghostWithdrawn());
        assertEq(recipient.balance, handler.ghostWithdrawn());
    }

    /// The approval nonce always equals the number of actions queued.
    function invariant_NonceTracksQueue() public view {
        assertEq(vault.nonce(), vault.actionCount());
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PondVault} from "../src/PondVault.sol";
import {PondVaultBase} from "./utils/PondVaultBase.sol";
import {FalseToken} from "./utils/MockERC20.sol";

/// @dev Re-enters the vault from its `receive` while a withdrawal pays it.
contract ReentrantReceiver {
    receive() external payable {
        PondVault(payable(msg.sender)).execute(1);
    }
}

/// @notice Unit and negative tests with real ML-DSA-87 vectors.
contract PondVaultTest is PondVaultBase {
    // ------------------------------------------------------------------
    // Encoding: the TypeScript signer and the contract agree byte for byte
    // ------------------------------------------------------------------

    function test_EveryVectorMatchesTheContractEncoding() public {
        PondVault other = _deployVault(otherVaultAddr);
        for (uint256 i = 0; i < vectorNames.length; i++) {
            Vec memory v = _vec(vectorNames[i]);
            PondVault target = v.vault == vaultAddr ? vault : other;
            vm.chainId(v.chainId);
            bytes memory onChain =
                target.approvalMessage(PondVault.Action(v.action), v.token, v.to, v.amount, v.nonce, v.deadline);
            assertEq(onChain, v.message, vectorNames[i]);
            assertEq(onChain.length, 203);
        }
    }

    function test_MessageStartsWithDomainTag() public view {
        bytes memory m = vault.approvalMessage(PondVault.Action.Withdraw, address(0), recipient, 1, 0, nowTs);
        bytes memory tag = bytes("qwakk-vault-v1");
        for (uint256 i = 0; i < tag.length; i++) {
            assertEq(m[i], tag[i]);
        }
    }

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    function test_ConstructorSetsRoles() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.approver(), owner);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.timelock(), TIMELOCK);
        assertEq(vault.dailyCap(address(0)), NATIVE_CAP);
        assertEq(vault.nonce(), 0);
        assertFalse(vault.paused());
        (bool usable, bytes memory key) = vault.keyStatus(owner);
        assertTrue(usable);
        assertEq(key, pubA);
    }

    function test_RevertWhen_ApproverHasNoKey() public {
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, recipient));
        new PondVault(owner, recipient, guardian, TIMELOCK, NATIVE_CAP);
    }

    function test_RevertWhen_ApproverKeyLacksPossessionProof() public {
        _setKey(recipient, pubA, false);
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, recipient));
        new PondVault(owner, recipient, guardian, TIMELOCK, NATIVE_CAP);
    }

    function test_RevertWhen_ApproverKeyHasWrongLength() public {
        _setKey(recipient, new bytes(1312), true);
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, recipient));
        new PondVault(owner, recipient, guardian, TIMELOCK, NATIVE_CAP);
    }

    function test_RevertWhen_TimelockOutOfBounds() public {
        vm.expectRevert(PondVault.InvalidParameters.selector);
        new PondVault(owner, owner, guardian, 59, NATIVE_CAP);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        new PondVault(owner, owner, guardian, 30 days + 1, NATIVE_CAP);
    }

    function test_RevertWhen_OwnerIsZero() public {
        vm.expectRevert(PondVault.InvalidParameters.selector);
        new PondVault(address(0), owner, guardian, TIMELOCK, NATIVE_CAP);
    }

    // ------------------------------------------------------------------
    // Deposits
    // ------------------------------------------------------------------

    function test_DepositNative() public {
        address donor = makeAddr("donor");
        vm.deal(donor, 3 ether);
        vm.expectEmit(vaultAddr);
        emit PondVault.Deposited(address(0), donor, 3 ether);
        vm.prank(donor);
        (bool ok,) = vaultAddr.call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(vaultAddr.balance, 23 ether);
    }

    function test_DepositToken() public {
        address donor = makeAddr("donor");
        token.mint(donor, 500e6);
        vm.startPrank(donor);
        token.approve(vaultAddr, 500e6);
        vm.expectEmit(vaultAddr);
        emit PondVault.Deposited(tokenAddr, donor, 500e6);
        vault.depositToken(tokenAddr, 500e6);
        vm.stopPrank();
        assertEq(token.balanceOf(vaultAddr), 10_500e6);
    }

    function test_RevertWhen_DepositTokenIsNotAContract() public {
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.depositToken(makeAddr("eoa"), 1);
    }

    function test_RevertWhen_TokenReturnsFalse() public {
        FalseToken bad = new FalseToken();
        vm.expectRevert(PondVault.TransferFailed.selector);
        vault.depositToken(address(bad), 1);
    }

    // ------------------------------------------------------------------
    // Queue and execute with a real ML-DSA-87 approval
    // ------------------------------------------------------------------

    function test_QueueWithdrawalWithRealApproval() public {
        Vec memory v = _vec("withdrawQor");
        vm.expectEmit(vaultAddr);
        emit PondVault.ApprovalVerified(0, owner, PondVault.Action.Withdraw, keccak256(v.message));
        vm.expectEmit(vaultAddr);
        emit PondVault.ActionQueued(
            1, PondVault.Action.Withdraw, address(0), recipient, 1 ether, 0, uint64(nowTs + TIMELOCK)
        );
        uint256 id = _queue(v);

        assertEq(id, 1);
        assertEq(vault.nonce(), 1);
        assertEq(vault.actionCount(), 1);
        PondVault.QueuedAction memory a = vault.getAction(1);
        assertEq(uint8(a.action), uint8(PondVault.Action.Withdraw));
        assertEq(uint8(a.status), uint8(PondVault.Status.Queued));
        assertEq(a.to, recipient);
        assertEq(a.amount, 1 ether);
        assertEq(a.eta, nowTs + TIMELOCK);
    }

    function test_ExecuteAfterTimelockPaysRecipient() public {
        _queue(_vec("withdrawQor"));
        _waitTimelock();
        vm.expectEmit(vaultAddr);
        emit PondVault.Withdrawn(1, address(0), recipient, 1 ether);
        vm.prank(makeAddr("anyone")); // execution is permissionless
        vault.execute(1);
        assertEq(recipient.balance, 1 ether);
        assertEq(vault.spentToday(address(0)), 1 ether);
        assertEq(vault.remainingToday(address(0)), NATIVE_CAP - 1 ether);
        assertEq(uint8(vault.getAction(1).status), uint8(PondVault.Status.Executed));
    }

    function test_RevertWhen_ExecutedBeforeTimelock() public {
        _queue(_vec("withdrawQor"));
        vm.warp(nowTs + TIMELOCK - 1);
        vm.expectRevert(abi.encodeWithSelector(PondVault.TimelockActive.selector, uint64(nowTs + TIMELOCK)));
        vault.execute(1);
    }

    function test_RevertWhen_ExecutedAfterGracePeriod() public {
        _queue(_vec("withdrawQor"));
        vm.warp(nowTs + TIMELOCK + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(PondVault.ActionExpired.selector, 1));
        vault.execute(1);
    }

    function test_RevertWhen_ExecutedTwice() public {
        _queue(_vec("withdrawQor"));
        _waitTimelock();
        vault.execute(1);
        vm.expectRevert(abi.encodeWithSelector(PondVault.NotQueued.selector, 1));
        vault.execute(1);
    }

    function test_RevertWhen_UnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(PondVault.NotQueued.selector, 42));
        vault.execute(42);
    }

    // ------------------------------------------------------------------
    // Negative: replay, wrong chain, wrong vault, expiry, tampering, sender
    // ------------------------------------------------------------------

    function test_RevertWhen_ApprovalIsReplayed() public {
        Vec memory v = _vec("withdrawQor");
        _queue(v);
        // Same bytes again: the vault now expects nonce 1, so the message differs.
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(v);
    }

    function test_RevertWhen_ReplayedOnAnotherChain() public {
        vm.chainId(1);
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(_vec("withdrawQor"));
    }

    function test_RevertWhen_SignedForAnotherChain() public {
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(_vec("withdrawQorOtherChain"));
    }

    function test_RevertWhen_ReplayedOnAnotherVault() public {
        PondVault other = _deployVault(otherVaultAddr);
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(other, _vec("withdrawQor"));
    }

    function test_RevertWhen_SignedForAnotherVault() public {
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(_vec("withdrawQorOtherVault"));
    }

    function test_RevertWhen_ApprovalExpired() public {
        Vec memory v = _vec("withdrawQor");
        vm.warp(v.deadline + 1);
        vm.expectRevert(PondVault.ApprovalExpired.selector);
        _queue(v);
    }

    function test_RevertWhen_ApprovalLivesTooLong() public {
        Vec memory v = _vec("withdrawQor");
        vm.warp(v.deadline - 1 days - 1);
        vm.expectRevert(PondVault.ApprovalTooLong.selector);
        _queue(v);
    }

    function test_RevertWhen_SignatureIsTampered() public {
        Vec memory v = _vec("withdrawQor");
        v.signature[100] ^= 0x01;
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(v);
    }

    function test_RevertWhen_AmountIsTampered() public {
        Vec memory v = _vec("withdrawQor");
        v.amount += 1;
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(v);
    }

    function test_RevertWhen_RecipientIsTampered() public {
        Vec memory v = _vec("withdrawQor");
        v.to = makeAddr("thief");
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(v);
    }

    function test_RevertWhen_SignatureHasWrongLength() public {
        Vec memory v = _vec("withdrawQor");
        v.signature = bytes.concat(v.signature, hex"00");
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(v);
    }

    function test_RevertWhen_SenderIsNotOwner() public {
        Vec memory v = _vec("withdrawQor");
        vm.prank(makeAddr("thief"));
        vm.expectRevert(PondVault.NotOwner.selector);
        vault.queue(PondVault.Action.Withdraw, v.token, v.to, v.amount, v.deadline, v.signature);
    }

    function test_RevertWhen_GuardianTriesToQueue() public {
        Vec memory v = _vec("withdrawQor");
        vm.prank(guardian);
        vm.expectRevert(PondVault.NotOwner.selector);
        vault.queue(PondVault.Action.Withdraw, v.token, v.to, v.amount, v.deadline, v.signature);
    }

    function test_RevertWhen_ApproverKeyWasRemoved() public {
        _clearKey(owner);
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, owner));
        _queue(_vec("withdrawQor"));
    }

    function test_RevertWhen_ApproverKeyWasRotatedOnChain() public {
        // A native-lane MsgRotatePQCKey takes effect at once: old-key approvals die.
        _setKey(owner, pubB, true);
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(_vec("withdrawQor"));
    }

    function test_FailsClosedWhenPrecompilesAreInactive() public {
        // An inactive precompile answers with empty data (docs: evm-precompiles).
        vm.clearMockedCalls();
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, owner));
        _queue(_vec("withdrawQor"));

        _setKey(owner, pubA, true); // key status works, pqcVerify inactive
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(_vec("withdrawQor"));
    }

    function test_RevertWhen_ParametersAreNotCanonical() public {
        bytes memory sig = new bytes(4627);
        uint256 d = nowTs + 1 hours;
        vm.startPrank(owner);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.Withdraw, address(0), address(0), 1, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.Withdraw, address(0), recipient, 0, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.Withdraw, address(0), vaultAddr, 1, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.Withdraw, makeAddr("eoa"), recipient, 1, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.SetDailyCap, address(0), recipient, 1, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.SetTimelock, address(0), address(0), 59, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.SetOwner, address(0), address(0), 0, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.SetGuardian, tokenAddr, address(0), 0, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.Unpause, address(0), address(0), 0, d, sig);
        vm.expectRevert(PondVault.InvalidParameters.selector);
        vault.queue(PondVault.Action.None, address(0), address(0), 0, d, sig);
        vm.stopPrank();
        assertEq(vault.nonce(), 0);
    }

    // ------------------------------------------------------------------
    // Configuration actions
    // ------------------------------------------------------------------

    function test_SetDailyCapThenWithdrawToken() public {
        _queue(_vec("capToken"));
        _waitTimelock();
        vault.execute(1);
        assertEq(vault.dailyCap(tokenAddr), 1_000e6);

        _queue(_vec("withdrawToken"));
        _waitTimelock();
        vault.execute(2);
        assertEq(token.balanceOf(recipient), 250e6);
        assertEq(vault.remainingToday(tokenAddr), 750e6);
    }

    function test_SetTimelock() public {
        _queue(_vec("setTimelock"));
        _waitTimelock();
        vault.execute(1);
        assertEq(vault.timelock(), 3_600);
    }

    function test_SetOwner() public {
        _queue(_vec("setOwner"));
        _waitTimelock();
        vault.execute(1);
        assertEq(vault.owner(), newOwner);
        vm.prank(owner);
        vm.expectRevert(PondVault.NotOwnerOrGuardian.selector);
        vault.pause();
        Vec memory next = _vec("withdrawQor");
        vm.prank(owner);
        vm.expectRevert(PondVault.NotOwner.selector);
        vault.queue(PondVault.Action.Withdraw, next.token, next.to, next.amount, next.deadline, next.signature);
    }

    function test_SetGuardian() public {
        _queue(_vec("setGuardian"));
        _waitTimelock();
        vault.execute(1);
        assertEq(vault.guardian(), newGuardian);
        vm.prank(guardian);
        vm.expectRevert(PondVault.NotOwnerOrGuardian.selector);
        vault.pause();
        vm.prank(newGuardian);
        vault.pause();
    }

    function test_RotateApproverToSecondKey() public {
        _queue(_vec("setApproverB"));
        _waitTimelock();
        vault.execute(1);
        assertEq(vault.approver(), approverB);

        // The old key no longer authorises anything, even with the right nonce.
        vm.expectRevert(PondVault.InvalidApproval.selector);
        _queue(_vec("withdrawQorByANonce1"));

        _queue(_vec("withdrawQorByB"));
        _waitTimelock();
        vault.execute(2);
        assertEq(recipient.balance, 1 ether);
    }

    function test_RevertWhen_NewApproverHasNoKeyAtQueue() public {
        _clearKey(approverB);
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, approverB));
        _queue(_vec("setApproverB"));
    }

    function test_RevertWhen_NewApproverLostKeyBeforeExecute() public {
        _queue(_vec("setApproverB"));
        _clearKey(approverB);
        _waitTimelock();
        vm.expectRevert(abi.encodeWithSelector(PondVault.ApproverKeyUnavailable.selector, approverB));
        vault.execute(1);
    }

    // ------------------------------------------------------------------
    // Pause and cancel
    // ------------------------------------------------------------------

    function test_GuardianPauseBlocksWithdrawals() public {
        _queue(_vec("withdrawQor"));
        vm.prank(guardian);
        vault.pause();
        _waitTimelock();
        vm.expectRevert(PondVault.VaultPaused.selector);
        vault.execute(1);
    }

    function test_PauseBlocksQueueingWithdrawals() public {
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(PondVault.VaultPaused.selector);
        _queue(_vec("withdrawQor"));
    }

    function test_ConfigCanStillChangeWhilePaused() public {
        vm.prank(guardian);
        vault.pause();
        _queue(_vec("setGuardian"));
        _waitTimelock();
        vault.execute(1);
        assertEq(vault.guardian(), newGuardian);
    }

    function test_UnpauseWithRealApproval() public {
        vm.prank(guardian);
        vault.pause();
        Vec memory v = _vec("unpause");
        vm.expectEmit(vaultAddr);
        emit PondVault.Unpaused(owner);
        vm.prank(owner);
        vault.unpause(v.deadline, v.signature);
        assertFalse(vault.paused());
        assertEq(vault.nonce(), 1);
    }

    function test_RevertWhen_GuardianTriesToUnpause() public {
        vm.prank(guardian);
        vault.pause();
        Vec memory v = _vec("unpause");
        vm.prank(guardian);
        vm.expectRevert(PondVault.NotOwner.selector);
        vault.unpause(v.deadline, v.signature);
    }

    function test_RevertWhen_UnpauseWithoutPause() public {
        Vec memory v = _vec("unpause");
        vm.prank(owner);
        vm.expectRevert(PondVault.VaultNotPaused.selector);
        vault.unpause(v.deadline, v.signature);
    }

    function test_RevertWhen_StrangerPauses() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(PondVault.NotOwnerOrGuardian.selector);
        vault.pause();
    }

    function test_GuardianCancelsWithdrawal() public {
        _queue(_vec("withdrawQor"));
        vm.expectEmit(vaultAddr);
        emit PondVault.ActionCancelled(1, guardian);
        vm.prank(guardian);
        vault.cancel(1);
        _waitTimelock();
        vm.expectRevert(abi.encodeWithSelector(PondVault.NotQueued.selector, 1));
        vault.execute(1);
    }

    function test_GuardianCannotCancelItsReplacement() public {
        _queue(_vec("setGuardian"));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PondVault.GuardianCannotCancel.selector, 1));
        vault.cancel(1);
        vm.prank(owner);
        vault.cancel(1);
    }

    function test_RevertWhen_StrangerCancels() public {
        _queue(_vec("withdrawQor"));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(PondVault.NotOwnerOrGuardian.selector);
        vault.cancel(1);
    }

    // ------------------------------------------------------------------
    // Reentrancy
    // ------------------------------------------------------------------

    function test_ReentrantRecipientCannotReenter() public {
        vm.etch(recipient, address(new ReentrantReceiver()).code);
        _queue(_vec("withdrawQor"));
        _waitTimelock();
        vm.expectRevert(PondVault.TransferFailed.selector);
        vault.execute(1);
        assertEq(uint8(vault.getAction(1).status), uint8(PondVault.Status.Queued));
    }
}

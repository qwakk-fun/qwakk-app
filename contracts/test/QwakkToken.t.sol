// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {QwakkToken} from "../src/QwakkToken.sol";

contract QwakkTokenTest is Test {
    QwakkToken internal token;
    address internal deployer = makeAddr("deployer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// x/erc20's module account: the first 20 bytes of sha256("erc20"). On
    /// QoreChain Diana it is qor1glht96kr2rseywuvhhay894qw7ekuc4q70yeuy, the
    /// `coinbase` minter of every MsgConvertERC20 (for example tx D53380E8...).
    address internal constant ERC20_MODULE = 0x47EeB2eac350E1923b8CBDfA4396A077b36E62a0;

    uint256 internal constant SUPPLY = 1_000_000_000e6;

    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant APPROVAL_TOPIC = keccak256("Approval(address,address,uint256)");

    function setUp() public {
        vm.prank(deployer);
        token = new QwakkToken();
    }

    // ------------------------------------------------------------------
    // Metadata and supply
    // ------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(token.name(), "Qwakk");
        assertEq(token.symbol(), "QWAKK");
        assertEq(token.decimals(), 6);
    }

    function test_SupplyIsOneBillionWithSixDecimals() public view {
        assertEq(token.totalSupply(), 1e15);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(deployer), SUPPLY);
    }

    function test_ConstructorEmitsOneMintToTheDeployer() public {
        vm.recordLogs();
        vm.prank(alice);
        QwakkToken fresh = new QwakkToken();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(fresh));
        assertEq(logs[0].topics[0], TRANSFER_TOPIC);
        assertEq(logs[0].topics[1], bytes32(0));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(alice))));
        assertEq(abi.decode(logs[0].data, (uint256)), SUPPLY);
        assertEq(fresh.balanceOf(alice), SUPPLY);
    }

    // ------------------------------------------------------------------
    // No mint, burn, owner, pause or blocklist path
    // ------------------------------------------------------------------

    function test_NoPrivilegedFunctionExists() public {
        bytes[] memory calls = new bytes[](14);
        calls[0] = abi.encodeWithSignature("mint(address,uint256)", alice, 1);
        calls[1] = abi.encodeWithSignature("mint(uint256)", 1);
        calls[2] = abi.encodeWithSignature("burn(uint256)", 1);
        calls[3] = abi.encodeWithSignature("burnFrom(address,uint256)", deployer, 1);
        calls[4] = abi.encodeWithSignature("owner()");
        calls[5] = abi.encodeWithSignature("transferOwnership(address)", alice);
        calls[6] = abi.encodeWithSignature("renounceOwnership()");
        calls[7] = abi.encodeWithSignature("pause()");
        calls[8] = abi.encodeWithSignature("unpause()");
        calls[9] = abi.encodeWithSignature("blacklist(address)", alice);
        calls[10] = abi.encodeWithSignature("setFee(uint256)", 1);
        calls[11] = abi.encodeWithSignature("increaseAllowance(address,uint256)", alice, 1);
        calls[12] = abi.encodeWithSignature("grantRole(bytes32,address)", bytes32(0), alice);
        calls[13] = hex"";
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(deployer);
            (bool ok,) = address(token).call(calls[i]);
            assertFalse(ok, "an unexpected function answered");
        }
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(deployer), SUPPLY);
    }

    function test_RejectsPlainValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(token).call{value: 1}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // transfer
    // ------------------------------------------------------------------

    function test_Transfer() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit QwakkToken.Transfer(deployer, alice, 1_000e6);
        vm.prank(deployer);
        assertTrue(token.transfer(alice, 1_000e6));
        assertEq(token.balanceOf(alice), 1_000e6);
        assertEq(token.balanceOf(deployer), SUPPLY - 1_000e6);
    }

    function test_TransferToSelfKeepsBalance() public {
        vm.prank(deployer);
        token.transfer(deployer, 5e6);
        assertEq(token.balanceOf(deployer), SUPPLY);
    }

    function test_ZeroTransferSucceeds() public {
        vm.prank(alice);
        assertTrue(token.transfer(bob, 0));
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InsufficientBalance.selector, alice, 0, 1));
        token.transfer(bob, 1);
    }

    function test_RevertWhen_TransferToZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InvalidReceiver.selector, address(0)));
        token.transfer(address(0), 1);
    }

    // ------------------------------------------------------------------
    // approve and transferFrom
    // ------------------------------------------------------------------

    function test_ApproveAndTransferFrom() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit QwakkToken.Approval(deployer, alice, 10e6);
        vm.prank(deployer);
        assertTrue(token.approve(alice, 10e6));
        assertEq(token.allowance(deployer, alice), 10e6);

        vm.prank(alice);
        assertTrue(token.transferFrom(deployer, bob, 4e6));
        assertEq(token.allowance(deployer, alice), 6e6);
        assertEq(token.balanceOf(bob), 4e6);
        assertEq(token.balanceOf(deployer), SUPPLY - 4e6);
    }

    function test_TransferFromEmitsNoApproval() public {
        vm.prank(deployer);
        token.approve(alice, 10e6);
        vm.recordLogs();
        vm.prank(alice);
        token.transferFrom(deployer, bob, 1e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], TRANSFER_TOPIC);
    }

    function test_InfiniteAllowanceIsNotSpent() public {
        vm.prank(deployer);
        token.approve(alice, type(uint256).max);
        vm.prank(alice);
        token.transferFrom(deployer, bob, 7e6);
        assertEq(token.allowance(deployer, alice), type(uint256).max);
    }

    function test_ApproveOverwrites() public {
        vm.startPrank(deployer);
        token.approve(alice, 10);
        token.approve(alice, 3);
        vm.stopPrank();
        assertEq(token.allowance(deployer, alice), 3);
    }

    function test_RevertWhen_TransferFromExceedsAllowance() public {
        vm.prank(deployer);
        token.approve(alice, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InsufficientAllowance.selector, alice, 5, 6));
        token.transferFrom(deployer, bob, 6);
    }

    function test_RevertWhen_TransferFromExceedsBalance() public {
        vm.prank(alice);
        token.approve(bob, 10);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InsufficientBalance.selector, alice, 0, 10));
        token.transferFrom(alice, bob, 10);
    }

    function test_RevertWhen_TransferFromZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InvalidSender.selector, address(0)));
        token.transferFrom(address(0), bob, 0);
    }

    function test_RevertWhen_ApproveZeroSpender() public {
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InvalidSpender.selector, address(0)));
        token.approve(address(0), 1);
    }

    // ------------------------------------------------------------------
    // The calls QoreChain's x/erc20 module makes (cosmos/evm v0.6.3)
    // ------------------------------------------------------------------

    /// Registration (keeper/evm.go QueryERC20) reads name, symbol and decimals
    /// with the ERC20MinterBurnerDecimals ABI: two ABI strings and a uint8.
    function test_RegistrationReadsDecodeAsTheModuleExpects() public {
        vm.startPrank(ERC20_MODULE);
        (bool okName, bytes memory rawName) = address(token).staticcall(abi.encodeWithSignature("name()"));
        (bool okSymbol, bytes memory rawSymbol) = address(token).staticcall(abi.encodeWithSignature("symbol()"));
        (bool okDecimals, bytes memory rawDecimals) = address(token).staticcall(abi.encodeWithSignature("decimals()"));
        vm.stopPrank();
        assertTrue(okName && okSymbol && okDecimals);
        assertEq(abi.decode(rawName, (string)), "Qwakk");
        assertEq(abi.decode(rawSymbol, (string)), "QWAKK");
        assertEq(rawDecimals.length, 32);
        assertEq(abi.decode(rawDecimals, (uint8)), 6);
    }

    /// MsgConvertERC20 (keeper/convert.go ConvertERC20IntoCoinsForNativeToken):
    /// the module calls transfer(module, amount) as the sender, needs `true`
    /// back, and needs the module's balance to grow by exactly `amount`.
    function test_ConvertToBankEscrowShape() public {
        uint256 amount = 250_000_000e6;
        uint256 before = token.balanceOf(ERC20_MODULE);
        vm.recordLogs();
        vm.prank(deployer);
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSignature("transfer(address,uint256)", ERC20_MODULE, amount));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok);
        assertTrue(abi.decode(ret, (bool)));
        assertEq(token.balanceOf(ERC20_MODULE), before + amount);
        uint256 transfers;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == TRANSFER_TOPIC) transfers++;
            assertTrue(logs[i].topics[0] != APPROVAL_TOPIC, "unexpected Approval event");
        }
        assertEq(transfers, 1);
    }

    /// MsgConvertCoin (keeper/msg_server.go ConvertCoinNativeERC20): the module
    /// sends escrowed tokens back and needs the receiver's balance to grow by exactly `amount`.
    function test_ConvertBackUnescrowShape() public {
        vm.prank(deployer);
        token.transfer(ERC20_MODULE, 100e6);
        uint256 before = token.balanceOf(alice);
        vm.prank(ERC20_MODULE);
        assertTrue(token.transfer(alice, 40e6));
        assertEq(token.balanceOf(alice), before + 40e6);
        assertEq(token.balanceOf(ERC20_MODULE), 60e6);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    function testFuzz_TransferMovesExactly(address to, uint256 amount) public {
        vm.assume(to != address(0) && to != deployer);
        amount = bound(amount, 0, SUPPLY);
        uint256 toBefore = token.balanceOf(to);
        vm.prank(deployer);
        assertTrue(token.transfer(to, amount));
        assertEq(token.balanceOf(deployer), SUPPLY - amount);
        assertEq(token.balanceOf(to), toBefore + amount);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function testFuzz_TransferAboveBalanceReverts(address from, address to, uint256 held, uint256 amount) public {
        vm.assume(from != address(0) && to != address(0) && from != deployer);
        held = bound(held, 0, SUPPLY - 1);
        amount = bound(amount, held + 1, type(uint256).max);
        vm.prank(deployer);
        token.transfer(from, held);
        vm.prank(from);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InsufficientBalance.selector, from, held, amount));
        token.transfer(to, amount);
    }

    function testFuzz_TransferFromSpendsAllowance(address spender, address to, uint256 allowed, uint256 amount) public {
        vm.assume(spender != address(0) && to != address(0));
        allowed = bound(allowed, 0, type(uint256).max - 1);
        amount = bound(amount, 0, allowed < SUPPLY ? allowed : SUPPLY);
        vm.prank(deployer);
        token.approve(spender, allowed);
        uint256 toBefore = token.balanceOf(to);
        uint256 deployerBefore = token.balanceOf(deployer);
        vm.prank(spender);
        assertTrue(token.transferFrom(deployer, to, amount));
        assertEq(token.allowance(deployer, spender), allowed - amount);
        if (to != deployer) {
            assertEq(token.balanceOf(to), toBefore + amount);
            assertEq(token.balanceOf(deployer), deployerBefore - amount);
        } else {
            assertEq(token.balanceOf(deployer), deployerBefore);
        }
    }

    function testFuzz_TransferFromAboveAllowanceReverts(address spender, uint256 allowed, uint256 amount) public {
        vm.assume(spender != address(0));
        allowed = bound(allowed, 0, SUPPLY - 1);
        amount = bound(amount, allowed + 1, SUPPLY);
        vm.prank(deployer);
        token.approve(spender, allowed);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(QwakkToken.ERC20InsufficientAllowance.selector, spender, allowed, amount));
        token.transferFrom(deployer, alice, amount);
    }

    function testFuzz_ChainedTransfersConserveSupply(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 0, SUPPLY);
        vm.prank(deployer);
        token.transfer(alice, a);
        b = bound(b, 0, a);
        vm.prank(alice);
        token.transfer(bob, b);
        c = bound(c, 0, b);
        vm.prank(bob);
        token.transfer(deployer, c);
        assertEq(token.balanceOf(deployer) + token.balanceOf(alice) + token.balanceOf(bob), SUPPLY);
    }
}

/// Random transfers, approvals and transferFroms among a fixed set of holders.
contract QwakkTokenHandler is Test {
    QwakkToken public immutable token;
    address[] public actors;

    constructor(QwakkToken token_, address[] memory actors_) {
        token = token_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        amount = bound(amount, 0, token.balanceOf(from));
        vm.prank(from);
        token.transfer(to, amount);
    }

    function approve(uint256 ownerSeed, uint256 spenderSeed, uint256 amount) external {
        address owner = actors[ownerSeed % actors.length];
        address spender = actors[spenderSeed % actors.length];
        vm.prank(owner);
        token.approve(spender, amount);
    }

    function transferFrom(uint256 spenderSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address spender = actors[spenderSeed % actors.length];
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 allowed = token.allowance(from, spender);
        uint256 held = token.balanceOf(from);
        amount = bound(amount, 0, allowed < held ? allowed : held);
        vm.prank(spender);
        token.transferFrom(from, to, amount);
    }
}

contract QwakkTokenInvariantTest is StdInvariant, Test {
    QwakkToken internal token;
    QwakkTokenHandler internal handler;
    address[] internal actors;

    function setUp() public {
        actors.push(makeAddr("deployer"));
        actors.push(makeAddr("holder1"));
        actors.push(makeAddr("holder2"));
        actors.push(makeAddr("holder3"));
        actors.push(0x47EeB2eac350E1923b8CBDfA4396A077b36E62a0); // x/erc20 module escrow
        vm.prank(actors[0]);
        token = new QwakkToken();
        handler = new QwakkTokenHandler(token, actors);
        targetContract(address(handler));
    }

    /// Nothing mints or burns: the holders always own exactly the supply.
    function invariant_BalancesSumToFixedSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < actors.length; i++) sum += token.balanceOf(actors[i]);
        assertEq(sum, 1_000_000_000e6);
        assertEq(token.totalSupply(), 1_000_000_000e6);
    }
}

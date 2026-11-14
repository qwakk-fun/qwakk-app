// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PondVault} from "../../src/PondVault.sol";
import {IQorePQC} from "../../src/interfaces/IQorePQC.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Shared setup. The precompiles do not exist in Foundry's EVM, so they
///         are mocked to answer exactly what QoreChain Diana answers:
///
///         - pqcVerify (0xA01) returns true only for the exact (pubkey,
///           signature, message) triples in test/fixtures/pq-vectors.json, all
///           real ML-DSA-87 signatures that Diana's precompile verified when the
///           file was generated with `npm run vectors -- --live`; anything else
///           returns false.
///         - pqcKeyStatus (0xA02) returns the four-value answer Diana gives:
///           (registered, algorithmId, pubkey, possessionProven), and
///           (false, 0, "", false) for an account without a key.
abstract contract PondVaultBase is Test {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant DIANA_EVM_CHAIN_ID = 9800;
    uint256 internal constant TIMELOCK = 10 minutes;
    uint256 internal constant NATIVE_CAP = 5 ether;

    struct Vec {
        uint8 action;
        address token;
        address to;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        uint256 chainId;
        address vault;
        bytes message;
        bytes signature;
        bytes pubkey;
    }

    string internal json;
    bytes internal pubA;
    bytes internal pubB;
    uint256 internal nowTs;

    address internal vaultAddr;
    address internal otherVaultAddr;
    address internal owner;
    address internal guardian;
    address internal recipient;
    address internal tokenAddr;
    address internal approverB;
    address internal newOwner;
    address internal newGuardian;

    PondVault internal vault;
    MockERC20 internal token;

    string[] internal vectorNames;

    function setUp() public virtual {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/pq-vectors.json"));
        pubA = vm.parseJsonBytes(json, ".pubkeyA");
        pubB = vm.parseJsonBytes(json, ".pubkeyB");
        nowTs = vm.parseJsonUint(json, ".now");
        vaultAddr = vm.parseJsonAddress(json, ".addresses.vault");
        otherVaultAddr = vm.parseJsonAddress(json, ".addresses.otherVault");
        owner = vm.parseJsonAddress(json, ".addresses.owner");
        guardian = vm.parseJsonAddress(json, ".addresses.guardian");
        recipient = vm.parseJsonAddress(json, ".addresses.recipient");
        tokenAddr = vm.parseJsonAddress(json, ".addresses.token");
        approverB = vm.parseJsonAddress(json, ".addresses.approverB");
        newOwner = vm.parseJsonAddress(json, ".addresses.newOwner");
        newGuardian = vm.parseJsonAddress(json, ".addresses.newGuardian");
        vectorNames = vm.parseJsonKeys(json, ".vectors");

        vm.chainId(DIANA_EVM_CHAIN_ID);
        vm.warp(nowTs);

        // Diana's answers for anything not listed below.
        vm.mockCall(PQC_VERIFY, abi.encodeWithSelector(IQorePQC.pqcVerify.selector), abi.encode(false));
        vm.mockCall(
            PQC_KEY_STATUS,
            abi.encodeWithSelector(IQorePQC.pqcKeyStatus.selector),
            abi.encode(false, uint8(0), bytes(""), false)
        );
        _setKey(owner, pubA, true);
        _setKey(approverB, pubB, true);
        for (uint256 i = 0; i < vectorNames.length; i++) {
            Vec memory v = _vec(vectorNames[i]);
            vm.mockCall(
                PQC_VERIFY, abi.encodeCall(IQorePQC.pqcVerify, (v.pubkey, v.signature, v.message)), abi.encode(true)
            );
        }

        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("Test USD", "tUSD", uint8(6)), tokenAddr);
        token = MockERC20(tokenAddr);
        vault = _deployVault(vaultAddr);
        vm.deal(vaultAddr, 20 ether);
        token.mint(vaultAddr, 10_000e6);
    }

    function _deployVault(address at) internal returns (PondVault) {
        deployCodeTo("PondVault.sol:PondVault", abi.encode(owner, owner, guardian, TIMELOCK, NATIVE_CAP), at);
        return PondVault(payable(at));
    }

    /// @dev Make pqcKeyStatus(account) answer like Diana does for a registered key.
    function _setKey(address account, bytes memory pubkey, bool possessionProven) internal {
        vm.mockCall(
            PQC_KEY_STATUS,
            abi.encodeCall(IQorePQC.pqcKeyStatus, (account)),
            abi.encode(true, uint8(1), pubkey, possessionProven)
        );
    }

    /// @dev Make pqcKeyStatus(account) answer "no key".
    function _clearKey(address account) internal {
        vm.mockCall(
            PQC_KEY_STATUS,
            abi.encodeCall(IQorePQC.pqcKeyStatus, (account)),
            abi.encode(false, uint8(0), bytes(""), false)
        );
    }

    function _vec(string memory name) internal view returns (Vec memory v) {
        string memory p = string.concat(".vectors.", name);
        v.action = uint8(vm.parseJsonUint(json, string.concat(p, ".action")));
        v.token = vm.parseJsonAddress(json, string.concat(p, ".token"));
        v.to = vm.parseJsonAddress(json, string.concat(p, ".to"));
        v.amount = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".amount")));
        v.nonce = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".nonce")));
        v.deadline = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".deadline")));
        v.chainId = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".chainId")));
        v.vault = vm.parseJsonAddress(json, string.concat(p, ".vault"));
        v.message = vm.parseJsonBytes(json, string.concat(p, ".message"));
        v.signature = vm.parseJsonBytes(json, string.concat(p, ".signature"));
        bool isB = keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".signer")))) == keccak256("B");
        v.pubkey = isB ? pubB : pubA;
    }

    /// @dev Queue a vector as the original owner on `target`. No external call
    ///      happens before `queue`, so a preceding vm.expectRevert applies to it.
    function _queue(PondVault target, Vec memory v) internal returns (uint256 id) {
        vm.prank(owner);
        id = target.queue(PondVault.Action(v.action), v.token, v.to, v.amount, v.deadline, v.signature);
    }

    function _queue(Vec memory v) internal returns (uint256) {
        return _queue(vault, v);
    }

    function _waitTimelock() internal {
        vm.warp(block.timestamp + vault.timelock());
    }
}

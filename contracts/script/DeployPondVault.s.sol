// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PondVault} from "../src/PondVault.sol";

/// @notice Deploys PondVault on a LOCAL anvil node for rehearsal. It is not the
///         way to deploy on QoreChain Diana: use the CLI (`npm run pond -- deploy`).
///
///         Why anvil only:
///         - Foundry runs `run()` on a local fork before broadcasting. QoreChain's
///           pqcKeyStatus and pqcVerify are native precompiles with no EVM code,
///           so on a fork of Diana the constructor's key check finds nothing and
///           reverts before anything is sent.
///         - The CLI also checks that the approver's registered ML-DSA-87 key is
///           the key its mnemonic derives. Solidity cannot derive that key, so
///           this script skips the check.
///
///         On anvil, place the stand-ins from test/utils/DevnetPrecompiles.sol at
///         0xA01 and 0xA02 first (contracts/README.md, "Local rehearsal").
///         The deployer is account 0 of QORE_MNEMONIC (m/44'/60'/0'/0/0).
contract DeployPondVault is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    function run() external returns (PondVault vault) {
        require(block.chainid == ANVIL_CHAIN_ID, "anvil only: deploy on QoreChain with `npm run pond -- deploy`");
        uint256 key = vm.deriveKey(vm.envString("QORE_MNEMONIC"), uint32(vm.envOr("QORE_ACCOUNT_INDEX", uint256(0))));
        address owner = vm.addr(key);
        address approver = vm.envOr("POND_APPROVER", owner);
        address guardian = vm.envOr("POND_GUARDIAN", address(0));
        uint256 timelock = vm.envOr("POND_TIMELOCK_SECONDS", uint256(120));
        // Whole QOR here; the CLI also accepts decimals.
        uint256 cap = vm.envOr("POND_NATIVE_DAILY_CAP_QOR", uint256(10)) * 1 ether;

        vm.startBroadcast(key);
        vault = new PondVault(owner, approver, guardian, timelock, cap);
        vm.stopBroadcast();

        console.log("PondVault deployed at", address(vault));
        console.log("owner", owner);
        console.log("approver", approver);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stand-ins for QoreChain's PQC precompiles on a local anvil node, so
///         the CLI can be rehearsed end to end without spending a Diana window.
///         Place their runtime code at 0xA01 and 0xA02 with anvil_setCode (see
///         contracts/README.md, "Local rehearsal").
///
///         NOT a verifier: it accepts any well-formed signature. Real ML-DSA-87
///         checks only happen on QoreChain Diana, and in the Foundry tests with
///         vectors Diana verified.
contract DevnetPqcVerify {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata) external pure returns (bool) {
        return pubkey.length == 2592 && signature.length == 4627;
    }
}

/// @notice Answers pqcKeyStatus with the four values Diana returns.
contract DevnetPqcKeyStatus {
    mapping(address => bytes) internal keys;

    function setKey(address account, bytes calldata pubkey) external {
        keys[account] = pubkey;
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        bytes memory key = keys[account];
        if (key.length == 0) return (false, 0, "", false);
        return (true, 1, key, true);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IQorePQC
/// @notice QoreChain's post-quantum precompiles on the EVM lane.
/// @dev Source: https://docs.qorechain.io/developer-guide/evm-precompiles
///      (IQorePQC.sol) and PRECOMPILE_ADDRESSES in the npm package
///      qorechain/evm 0.14.0.
///      Both are active on QoreChain Diana (`/cosmos/evm/vm/v1/params`,
///      `active_static_precompiles`). On a network where they are inactive a
///      call succeeds with empty return data, so callers must check the length.
///
///      `pqcKeyStatus` returns FOUR values. The npm package qorechain/evm
///      0.14.0 lists only the first three in IQORE_PQC_ABI; the docs page and a live eth_call on
///      Diana (2026-11-14) both show the fourth, `possessionProven`.
interface IQorePQC {
    /// @param pubkey    The 2,592-byte ML-DSA-87 public key.
    /// @param signature The 4,627-byte ML-DSA-87 signature.
    /// @param message   The original message bytes (not a hash).
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    /// @param account The EVM form of a QoreChain account (same 20 bytes as its qor1 address).
    /// @return registered       True when the account has a PQC key on chain.
    /// @return algorithmId      1 = ML-DSA-87.
    /// @return pubkey           The registered public key (empty when not registered).
    /// @return possessionProven True only when the key was registered with a proof of possession.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

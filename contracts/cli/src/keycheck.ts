/**
 * Does the key QoreChain has registered for an account match the ML-DSA-87 key
 * this CLI derives from its mnemonic, and would the vault accept it?
 *
 * Pure: the caller passes the `pqcKeyStatus` answer (the same precompile the
 * vault reads) and the derived public key.
 */
import { bytesToHex, type Hex } from "viem";

export type KeyStatusAnswer = { registered: boolean; algorithmId: number; pubkey: Hex; possessionProven: boolean };

export type KeyCheck =
  | { ok: true }
  | { ok: false; problem: "not-registered" | "wrong-algorithm" | "no-possession-proof" | "different-key"; message: string };

const ML_DSA_87 = 1;

export function checkRegisteredKey(status: KeyStatusAnswer, derivedPublicKey: Uint8Array, who: string): KeyCheck {
  if (!status.registered) {
    return { ok: false, problem: "not-registered", message: `${who} has no ML-DSA-87 key registered on QoreChain yet.` };
  }
  if (status.algorithmId !== ML_DSA_87) {
    return { ok: false, problem: "wrong-algorithm", message: `${who} has a PQC key of algorithm ${status.algorithmId}, not ML-DSA-87 (1).` };
  }
  if (status.pubkey.toLowerCase() !== bytesToHex(derivedPublicKey).toLowerCase()) {
    return {
      ok: false,
      problem: "different-key",
      message:
        `${who} has a different ML-DSA-87 key registered than the one this mnemonic derives ` +
        "(registered by another wallet or tool). Approvals signed here would be refused. " +
        "Use a fresh testnet-only mnemonic for the vault.",
    };
  }
  if (!status.possessionProven) {
    return {
      ok: false,
      problem: "no-possession-proof",
      message: `${who}'s key was registered without a proof of possession, and the vault refuses such keys. Use a fresh testnet-only mnemonic.`,
    };
  }
  return { ok: true };
}

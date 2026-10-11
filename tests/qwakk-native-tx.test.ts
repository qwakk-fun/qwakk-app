import assert from "node:assert/strict";
import test from "node:test";

import { amm, qorechainRegistry, signClassicalEth, unifiedAccountFromSeed } from "@qorechain/sdk";
import { AuthInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import {
  assembleSignedTx,
  base64ToBytes,
  SECP256K1_PUBKEY_TYPE,
  buildUnsignedNativeTx,
  bytesToBase64,
  classicalAddressFromPublicKey,
  findAccountInfo,
  messageTypesInBody,
  parseCompressedPublicKey,
} from "../lib/qwakk-native-tx";

const sender = "qor1exampleaddress000000000000";
const publicKey = parseCompressedPublicKey(`02${"ab".repeat(32)}`);

function unsignedSwap() {
  return buildUnsignedNativeTx({
    messages: [amm.swapExactIn({ sender, poolId: "1", tokenIn: { denom: "uqor", amount: "10" }, denomOut: "utest", minOut: "1" })],
    publicKey,
    keyType: "secp256k1",
    account: { accountNumber: BigInt(42), sequence: BigInt(7) },
    fee: { amount: [{ denom: "uqor", amount: "60000" }], gas: "300000" },
  });
}

test("builds a direct-sign body for a classical QoreX account", () => {
  const unsigned = unsignedSwap();
  assert.deepEqual(messageTypesInBody(unsigned.bodyBytes), ["/qorechain.amm.v1.MsgSwapExactIn"]);
  assert.equal(unsigned.accountNumber, BigInt(42));

  const authInfo = AuthInfo.decode(unsigned.authInfoBytes);
  assert.equal(authInfo.signerInfos[0].publicKey?.typeUrl, SECP256K1_PUBKEY_TYPE);
  assert.equal(authInfo.signerInfos[0].sequence, BigInt(7));
  assert.equal(authInfo.fee?.gasLimit, BigInt(300000));
});

test("matches the SDK's own eth_secp256k1 signing bytes", () => {
  const account = unifiedAccountFromSeed(new Uint8Array(32).fill(7));
  const messages = [amm.swapExactIn({ sender: account.cosmos, poolId: "1", tokenIn: { denom: "uqor", amount: "10" }, denomOut: "utest", minOut: "1" })];
  const fee = { amount: [{ denom: "uqor", amount: "60000" }], gas: "300000" };
  const registry = qorechainRegistry();

  const reference = signClassicalEth({
    account,
    chainId: "qorechain-diana",
    accountNumber: BigInt(42),
    sequence: BigInt(7),
    messages,
    fee,
    encodeMessage: (message) => registry.encodeAsAny(message),
  });
  const unsigned = buildUnsignedNativeTx({
    messages,
    publicKey: parseCompressedPublicKey(account.publicKey),
    keyType: "eth_secp256k1",
    account: { accountNumber: BigInt(42), sequence: BigInt(7) },
    fee,
  });

  assert.deepEqual(unsigned.bodyBytes, reference.bodyBytes);
  assert.deepEqual(unsigned.authInfoBytes, reference.authInfoBytes);
});

test("derives the classical address QoreX's signer controls", () => {
  const account = unifiedAccountFromSeed(new Uint8Array(32).fill(7));
  const address = classicalAddressFromPublicKey(parseCompressedPublicKey(account.publicKey));
  assert.match(address, /^qor1[0-9a-z]{38}$/);
  assert.notEqual(address, account.cosmos);
});

test("joins a 64-byte wallet signature and refuses anything else", () => {
  const unsigned = unsignedSwap();
  assert.ok(assembleSignedTx(unsigned.bodyBytes, unsigned.authInfoBytes, new Uint8Array(64)).length > 0);
  assert.throws(() => assembleSignedTx(unsigned.bodyBytes, unsigned.authInfoBytes, new Uint8Array(65)), /signature length/);
});

test("round-trips base64 and rejects malformed keys", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.throws(() => base64ToBytes("not base64!"), /Invalid base64/);
  assert.throws(() => parseCompressedPublicKey(`04${"ab".repeat(32)}`), /compressed/);
});

test("reads account number and sequence from nested auth responses", () => {
  const account = findAccountInfo({ account: { base_account: { account_number: "12", sequence: "3" } } });
  assert.deepEqual(account, { accountNumber: BigInt(12), sequence: BigInt(3) });
});

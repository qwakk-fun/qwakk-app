import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { qorechainRegistry, toChecksumAddress } from "@qorechain/sdk";
import {
  DIANA,
  ERC20_MODULE_ADDRESS,
  MSG_CONVERT_ERC20_TYPE_URL,
  QWAKK,
  TOKEN_REGISTRY_TYPES,
  assertDiana,
  bankDenomFor,
  bankSendMsg,
  convertErc20Msg,
  decodeMsgConvertERC20,
  encodeMsgConvertERC20,
  expectedBankMetadata,
  formatQwakk,
  metadataDifferences,
  nativeFeeFor,
  nativeGasFor,
  parseQorAddress,
  parseQwakkAmount,
  parseTokenAddress,
  sanitizeErc20Name,
} from "../src/qwakk-token.ts";

const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "0x02292293c13880a26242690eb70a0e42B8E91c28";
const FBTC = "0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A";
const OWNER_WALLET = "qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq";

/**
 * The message of Diana tx D53380E8260EAA25A790D35E462AD14E07D13BD879C79C4BD43157E5B5FAE3B6
 * (height 10094739, code 0): MsgConvertERC20 of 1 fUSD, sender and receiver
 * qor12hthsqv003px6huh76d6z8l38e6w8qm9sj4v60. Read from the node's /tx route
 * (TxRaw -> TxBody -> messages[0].value) on 2026-11-18.
 */
const LIVE_CONVERT = {
  value: {
    contractAddress: FUSD,
    amount: "1000000",
    receiver: "qor12hthsqv003px6huh76d6z8l38e6w8qm9sj4v60",
    sender: "qor12hthsqv003px6huh76d6z8l38e6w8qm9sj4v60",
  },
  hex:
    "0a2a3078393731343342373731443334646462393133306238303762313335416536373541356139363343411207313030303030301a2a716f72313268" +
    "7468737176303033707836687568373664367a386c333865367738716d39736a34763630222a716f723132687468737176303033707836687568373664" +
    "367a386c333865367738716d39736a34763630",
};

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("MsgConvertERC20 bytes equal a live Diana conversion byte for byte", () => {
  assert.equal(toHex(encodeMsgConvertERC20(LIVE_CONVERT.value)), LIVE_CONVERT.hex);
  assert.deepEqual(decodeMsgConvertERC20(Buffer.from(LIVE_CONVERT.hex, "hex")), LIVE_CONVERT.value);
});

test("the SDK registry encodes MsgConvertERC20 through the added type, and still encodes MsgSend", () => {
  const registry = qorechainRegistry(TOKEN_REGISTRY_TYPES);
  const msg = convertErc20Msg({ token: FUSD, amount: 1_000_000n, sender: LIVE_CONVERT.value.sender, receiver: LIVE_CONVERT.value.receiver });
  assert.equal(msg.typeUrl, MSG_CONVERT_ERC20_TYPE_URL);
  const any = registry.encodeAsAny(msg);
  assert.equal(any.typeUrl, "/cosmos.evm.erc20.v1.MsgConvertERC20");
  assert.equal(toHex(any.value), LIVE_CONVERT.hex);

  const send = bankSendMsg({ denom: bankDenomFor(FUSD), amount: 5n, from: LIVE_CONVERT.value.sender, to: OWNER_WALLET });
  const decoded = registry.decode(registry.encodeAsAny(send)) as { fromAddress: string; toAddress: string; amount: { denom: string; amount: string }[] };
  assert.deepEqual(decoded.amount, [{ denom: `erc20:${FUSD}`, amount: "5" }]);
  assert.equal(decoded.toAddress, OWNER_WALLET);
});

test("message builders refuse empty amounts", () => {
  assert.throws(() => convertErc20Msg({ token: FUSD, amount: 0n, sender: OWNER_WALLET, receiver: OWNER_WALLET }));
  assert.throws(() => bankSendMsg({ denom: "uqor", amount: -1n, from: OWNER_WALLET, to: OWNER_WALLET }));
});

/**
 * Diana's live records (GET /cosmos/bank/v1beta1/denoms_metadata, 2026-11-18),
 * built from each contract's real name() ("Fest USD", read with eth_call), so
 * the sanitizer's space removal is exercised too.
 */
const LIVE_METADATA = [
  { token: { address: FUSD, name: "Fest USD", symbol: "fUSD", decimals: 6 }, display: "FestUSD" },
  { token: { address: FETH, name: "Fest ETH", symbol: "fETH", decimals: 18 }, display: "FestETH" },
  { token: { address: FBTC, name: "Fest BTC", symbol: "fBTC", decimals: 8 }, display: "FestBTC" },
].map(({ token, display }) => ({
  token,
  live: {
    description: `Cosmos coin token representation of ${token.address}`,
    denom_units: [
      { denom: `erc20:${token.address}`, exponent: 0, aliases: [] },
      { denom: display, exponent: token.decimals, aliases: [] },
    ],
    base: `erc20:${token.address}`,
    display,
    name: `erc20:${token.address}`,
    symbol: token.symbol,
  },
}));

test("the registration metadata replica reproduces Diana's fUSD, fETH and fBTC records", () => {
  for (const { token, live } of LIVE_METADATA) {
    const expected = expectedBankMetadata(token.address, token);
    assert.deepEqual(expected, live);
    assert.deepEqual(metadataDifferences(live, expected), []);
  }
});

test("QWAKK will register as erc20:<address> with symbol QWAKK, display Qwakk and 6 decimals", () => {
  const address = toChecksumAddress(`0x${"ab12cd34ef".repeat(4)}`);
  const meta = expectedBankMetadata(address, QWAKK);
  assert.equal(meta.base, `erc20:${address}`);
  assert.equal(meta.name, `erc20:${address}`);
  assert.equal(meta.symbol, "QWAKK");
  assert.equal(meta.display, "Qwakk");
  assert.deepEqual(meta.denom_units.map((u) => [u.denom, u.exponent]), [[`erc20:${address}`, 0], ["Qwakk", 6]]);
  // The bank module's denom rule (cosmos-sdk ValidateDenom) accepts the display unit.
  assert.match(meta.display, /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/);
  assert.deepEqual(metadataDifferences({ ...meta, symbol: "QWAK" }, meta), ['symbol: "QWAK" (expected "QWAKK")']);
  assert.deepEqual(metadataDifferences(undefined, meta), ["no bank metadata"]);
});

test("SanitizeERC20Name port", () => {
  assert.equal(sanitizeErc20Name("Qwakk"), "Qwakk");
  assert.equal(sanitizeErc20Name("FestUSD"), "FestUSD");
  assert.equal(sanitizeErc20Name("123 Wrapped Ether!"), "WrappedEther");
  assert.equal(sanitizeErc20Name("erc20/ibc/Token"), "Token");
});

test("only QoreChain Diana passes the network guard", () => {
  assert.doesNotThrow(() => assertDiana({ chainId: "qorechain-diana", evmChainId: 9800 }));
  assert.throws(() => assertDiana({ chainId: "qorechain-vladi", evmChainId: 9801 }), /Diana/);
  assert.throws(() => assertDiana({ chainId: "qorechain-diana", evmChainId: 9801 }), /Diana/);
  assert.throws(() => assertDiana({ chainId: "", evmChainId: 31337 }), /Nothing was sent/);
  assert.deepEqual(DIANA, { chainId: "qorechain-diana", evmChainId: 9800 });
});

test("the token address must be set and EIP-55 spelled", () => {
  assert.equal(parseTokenAddress(` ${FUSD} `), FUSD);
  assert.throws(() => parseTokenAddress(undefined), /QWAKK_TOKEN_ADDRESS/);
  assert.throws(() => parseTokenAddress("0x1234"), /QWAKK_TOKEN_ADDRESS/);
  assert.throws(() => parseTokenAddress(FUSD.toLowerCase()), /EIP-55/);
  assert.equal(bankDenomFor(FUSD), `erc20:${FUSD}`);
  assert.throws(() => bankDenomFor(FUSD.toLowerCase()));
});

test("recipients must be qor1 account addresses", () => {
  assert.equal(parseQorAddress(OWNER_WALLET, "--to"), OWNER_WALLET);
  assert.throws(() => parseQorAddress("0x77E9232E33a24D915710367CbD78D8491861e8a4", "--to"), /qor1/);
  assert.throws(() => parseQorAddress(OWNER_WALLET.slice(0, -1) + "x", "--to"), /qor1/);
  assert.throws(() => parseQorAddress("cosmos1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq", "--to"), /qor1/);
  assert.throws(() => parseQorAddress(undefined, "--to"), /--to/);
});

test("QWAKK amounts use integer math with 6 decimals", () => {
  const all = QWAKK.totalSupply;
  assert.equal(parseQwakkAmount("1", all), 1_000_000n);
  assert.equal(parseQwakkAmount("0.000001", all), 1n);
  assert.equal(parseQwakkAmount("1000000000", all), 10n ** 15n);
  assert.equal(parseQwakkAmount("all", 42n), 42n);
  assert.equal(parseQwakkAmount("ALL", 42n), 42n);
  assert.throws(() => parseQwakkAmount("0.0000001", all), /6 decimals/);
  assert.throws(() => parseQwakkAmount("1000000000.000001", all), /available/);
  assert.throws(() => parseQwakkAmount("0", all), /greater than zero/);
  assert.throws(() => parseQwakkAmount("all", 0n), /greater than zero/);
  assert.throws(() => parseQwakkAmount("-1", all), /amount/);
  assert.throws(() => parseQwakkAmount("1e6", all), /amount/);
  assert.throws(() => parseQwakkAmount(undefined, all), /amount/);
  assert.equal(formatQwakk(QWAKK.totalSupply), "1,000,000,000");
  assert.equal(formatQwakk(1_500_000n), "1.5");
  assert.equal(formatQwakk(1n), "0.000001");
  assert.equal(formatQwakk(0n), "0");
});

test("native gas and fee: 800,000 by default, 1.3 x simulation above that, 0.125 uqor per gas", () => {
  assert.equal(nativeGasFor(428_257n), 800_000n); // a live MsgConvertERC20 used 428,257 gas
  assert.equal(nativeGasFor(700_000n), 910_000n);
  assert.equal(nativeFeeFor(800_000n), 100_000n);
  assert.equal(nativeFeeFor(910_000n), 113_750n);
  assert.equal(nativeFeeFor(9n), 2n);
  // At least Diana's 0.1 uqor per gas floor.
  for (const gas of [800_000n, 910_001n, 30_000_000n]) assert.ok(nativeFeeFor(gas) * 10n >= gas);
});

test("the module escrow address is sha256('erc20')[:20]", async () => {
  const { createHash } = await import("node:crypto");
  assert.equal(ERC20_MODULE_ADDRESS.toLowerCase(), `0x${createHash("sha256").update("erc20").digest("hex").slice(0, 40)}`);
});

test("the compiled QwakkToken exposes only the ERC-20 surface and matches the CLI constants", { skip: !existsSync(new URL("../../out/QwakkToken.sol/QwakkToken.json", import.meta.url)) && "run forge build first" }, () => {
  const artifact = JSON.parse(readFileSync(new URL("../../out/QwakkToken.sol/QwakkToken.json", import.meta.url), "utf8")) as {
    abi: { type: string; name?: string; stateMutability?: string; inputs?: unknown[] }[];
  };
  const functions = artifact.abi.filter((x) => x.type === "function").map((x) => x.name).sort();
  assert.deepEqual(functions, ["allowance", "approve", "balanceOf", "decimals", "name", "symbol", "totalSupply", "transfer", "transferFrom"]);
  const ctor = artifact.abi.find((x) => x.type === "constructor");
  assert.ok(ctor && (ctor.inputs ?? []).length === 0 && ctor.stateMutability === "nonpayable");
  assert.equal(artifact.abi.some((x) => x.type === "fallback" || x.type === "receive"), false);
  const source = readFileSync(new URL("../../src/QwakkToken.sol", import.meta.url), "utf8");
  assert.match(source, new RegExp(`string public constant name = "${QWAKK.name}";`));
  assert.match(source, new RegExp(`string public constant symbol = "${QWAKK.symbol}";`));
  assert.match(source, new RegExp(`uint8 public constant decimals = ${QWAKK.decimals};`));
  assert.match(source, /uint256 public constant totalSupply = 1_000_000_000 \* 10 \*\* 6;/);
});

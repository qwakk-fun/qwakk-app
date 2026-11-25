import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { hexToBech32, qorechainRegistry, toChecksumAddress } from "@qorechain/sdk";
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
  GOV_MODULE_ADDRESS,
  MSG_REGISTER_ERC20_TYPE_URL,
  MSG_SUBMIT_PROPOSAL_TYPE_URL,
  QCAT,
  TOKENS,
  encodeMsgRegisterERC20,
  formatTokenAmount,
  parseTokenAmount,
  registrationProposalMsg,
  registrationProposalText,
  tokenSpec,
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

// ---------------------------------------------------------------------------
// QCAT and the registration proposal
// ---------------------------------------------------------------------------

const QWAKK_TOKEN = "0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";

/**
 * Diana proposal 38 (the QWAKK registration): submit tx
 * F4D76890B5F0B9E42CDC936A9314E323C86273DC3F04CBD92487AFA25084EE74, height
 * 10327279, code 0, a hybrid-signed Native-lane transaction. Bytes of
 * TxRaw -> TxBody -> messages[0].value, read from the RPC /tx route on 2026-11-25.
 */
const LIVE_PROPOSAL_38 = {
  proposer: "qor1hz907zyx2t9ax2fj0y8hhspc5rpnxuegrfzzr9",
  deposit: 50_000_000n,
  expedited: true,
  innerHex:
    "0a2a716f72313064303779323635676d6d757674347a30773961773838306a6e73723730306a776679787233122a3078613562336333466239324532" +
    "45383935353546393930396239303034433635463335343265453233",
  valueHex:
    "0a81010a252f636f736d6f732e65766d2e65726332302e76312e4d73675265676973746572455243323012580a2a716f72313064303779323635676d" +
    "6d757674347a30773961773838306a6e73723730306a776679787233122a307861356233633346623932453245383935353546393930396239303034" +
    "43363546333534326545323312100a0475716f72120835303030303030301a2a716f7231687a3930377a7978327439617832666a3079386868737063" +
    "3572706e7875656772667a7a72392a42526567697374657220746865205177616b6b20285157414b4b29204552432d32302061732061206e61746976" +
    "6520746f6b656e20706169722028746573746e65742932d502546573746e6574206f6e6c792e2052656769737465727320746865204552432d323020" +
    "636f6e74726163742030786135623363334662393245324538393535354639393039623930303443363546333534326545323320285177616b6b2c20" +
    "5157414b4b2c203620646563696d616c732c20666978656420737570706c7920312c3030302c3030302c303030206d696e746564206f6e636520746f" +
    "20746865206465706c6f7965723b206e6f206f776e65722c206d696e742c2070617573652c20626c6f636b6c697374206f72207472616e7366657220" +
    "66656529206173206120746f6b656e20706169722c20736f2069742063616e20626520636f6e76657274656420746f20616e64207573656420617320" +
    "746865206e61746976652064656e6f6d2065726332303a30786135623363334662393245324538393535354639393039623930303443363546333534" +
    "32654532332e3801",
};

test("MsgRegisterERC20 bytes equal Diana proposal 38's message byte for byte", () => {
  const bytes = encodeMsgRegisterERC20({ signer: GOV_MODULE_ADDRESS, erc20addresses: [QWAKK_TOKEN] });
  assert.ok(LIVE_PROPOSAL_38.valueHex.includes(toHex(bytes)));
  assert.equal(toHex(bytes), LIVE_PROPOSAL_38.innerHex);
});

test("the registration proposal for QWAKK rebuilds Diana's live MsgSubmitProposal of proposal 38 exactly", () => {
  const msg = registrationProposalMsg({
    token: QWAKK_TOKEN,
    spec: QWAKK,
    proposer: LIVE_PROPOSAL_38.proposer,
    depositUqor: LIVE_PROPOSAL_38.deposit,
    expedited: LIVE_PROPOSAL_38.expedited,
  });
  assert.equal(msg.typeUrl, MSG_SUBMIT_PROPOSAL_TYPE_URL);
  assert.equal(msg.value.messages[0].typeUrl, MSG_REGISTER_ERC20_TYPE_URL);
  const any = qorechainRegistry(TOKEN_REGISTRY_TYPES).encodeAsAny(msg);
  assert.equal(any.typeUrl, "/cosmos.gov.v1.MsgSubmitProposal");
  assert.equal(toHex(any.value), LIVE_PROPOSAL_38.valueHex);
});

test("the QCAT proposal: one contract, gov authority signer, normal deposit, no em dash in its text", () => {
  const address = toChecksumAddress(`0x${"cd34ab12ef".repeat(4)}`);
  const proposer = "qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp";
  const msg = registrationProposalMsg({ token: address, spec: QCAT, proposer, depositUqor: 10_000_000n, expedited: false });
  const registry = qorechainRegistry(TOKEN_REGISTRY_TYPES);
  const decoded = registry.decode(registry.encodeAsAny(msg)) as {
    messages: { typeUrl: string; value: Uint8Array }[];
    initialDeposit: { denom: string; amount: string }[];
    proposer: string;
    title: string;
    summary: string;
    expedited: boolean;
  };
  assert.equal(decoded.messages.length, 1);
  assert.equal(toHex(decoded.messages[0].value), toHex(encodeMsgRegisterERC20({ signer: GOV_MODULE_ADDRESS, erc20addresses: [address] })));
  assert.deepEqual(decoded.initialDeposit, [{ denom: "uqor", amount: "10000000" }]);
  assert.equal(decoded.proposer, proposer);
  assert.equal(decoded.expedited, false);
  assert.equal(decoded.title, "Register the Quantum Cat (QCAT) ERC-20 as a native token pair (testnet)");
  assert.match(decoded.summary, new RegExp(`erc20:${address}\\.$`));
  assert.match(decoded.summary, /Quantum Cat, QCAT, 6 decimals, fixed supply 1,000,000,000 minted once/);
  const text = registrationProposalText(address, QCAT);
  assert.ok(!/\u2014/.test(text.title + text.summary));
  assert.throws(() => registrationProposalMsg({ token: address, spec: QCAT, proposer, depositUqor: 0n, expedited: false }));
});

test("the gov module address is sha256('gov')[:20] in qor1 form", async () => {
  const { createHash } = await import("node:crypto");
  assert.equal(hexToBech32(`0x${createHash("sha256").update("gov").digest("hex").slice(0, 40)}`, "qor"), GOV_MODULE_ADDRESS);
});

test("QCAT will register as erc20:<address> with symbol QCAT, display QuantumCat and 6 decimals", () => {
  const address = toChecksumAddress(`0x${"cd34ab12ef".repeat(4)}`);
  const meta = expectedBankMetadata(address, QCAT);
  assert.equal(meta.base, `erc20:${address}`);
  assert.equal(meta.symbol, "QCAT");
  assert.equal(meta.display, "QuantumCat");
  assert.deepEqual(meta.denom_units.map((u) => [u.denom, u.exponent]), [[`erc20:${address}`, 0], ["QuantumCat", 6]]);
  assert.match(meta.display, /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/);
});

test("--token picks QWAKK by default and QCAT on request", () => {
  assert.equal(tokenSpec(undefined), TOKENS.qwakk);
  assert.equal(tokenSpec("QCAT"), TOKENS.qcat);
  assert.deepEqual(
    [TOKENS.qwakk.contract, TOKENS.qwakk.addressEnv, TOKENS.qwakk.symbol, TOKENS.qwakk.totalSupply],
    ["QwakkToken", "QWAKK_TOKEN_ADDRESS", "QWAKK", 10n ** 15n],
  );
  assert.deepEqual(
    [TOKENS.qcat.contract, TOKENS.qcat.addressEnv, TOKENS.qcat.name, TOKENS.qcat.symbol, TOKENS.qcat.decimals, TOKENS.qcat.totalSupply],
    ["QcatToken", "QCAT_TOKEN_ADDRESS", "Quantum Cat", "QCAT", 6, 10n ** 15n],
  );
  assert.throws(() => tokenSpec("fusd"), /--token/);
  assert.throws(() => parseTokenAddress(undefined, "QCAT_TOKEN_ADDRESS"), /QCAT_TOKEN_ADDRESS/);
});

test("QCAT amounts use integer math with 6 decimals", () => {
  assert.equal(parseTokenAmount("1", QCAT.totalSupply, QCAT), 1_000_000n);
  assert.equal(parseTokenAmount("all", QCAT.totalSupply, QCAT), 10n ** 15n);
  assert.equal(parseTokenAmount("0.000001", 1n, QCAT), 1n);
  assert.throws(() => parseTokenAmount("0.0000001", QCAT.totalSupply, QCAT), /QCAT has 6 decimals/);
  assert.throws(() => parseTokenAmount("2", 1_000_000n, QCAT), /Only 1 QCAT is available/);
  assert.throws(() => parseTokenAmount("x", 1n, QCAT), /amount in QCAT/);
  assert.equal(formatTokenAmount(QCAT.totalSupply, QCAT.decimals), "1,000,000,000");
  assert.equal(formatTokenAmount(1_500_001n, 6), "1.500001");
});

test("the compiled QcatToken exposes only the ERC-20 surface and matches the CLI constants", { skip: !existsSync(new URL("../../out/QcatToken.sol/QcatToken.json", import.meta.url)) && "run forge build first" }, () => {
  const artifact = JSON.parse(readFileSync(new URL("../../out/QcatToken.sol/QcatToken.json", import.meta.url), "utf8")) as {
    abi: { type: string; name?: string; stateMutability?: string; inputs?: unknown[] }[];
  };
  const functions = artifact.abi.filter((x) => x.type === "function").map((x) => x.name).sort();
  assert.deepEqual(functions, ["allowance", "approve", "balanceOf", "decimals", "name", "symbol", "totalSupply", "transfer", "transferFrom"]);
  const ctor = artifact.abi.find((x) => x.type === "constructor");
  assert.ok(ctor && (ctor.inputs ?? []).length === 0 && ctor.stateMutability === "nonpayable");
  assert.equal(artifact.abi.some((x) => x.type === "fallback" || x.type === "receive"), false);
  const source = readFileSync(new URL("../../src/QcatToken.sol", import.meta.url), "utf8");
  assert.match(source, new RegExp(`string public constant name = "${QCAT.name}";`));
  assert.match(source, new RegExp(`string public constant symbol = "${QCAT.symbol}";`));
  assert.match(source, new RegExp(`uint8 public constant decimals = ${QCAT.decimals};`));
  assert.match(source, /uint256 public constant totalSupply = 1_000_000_000 \* 10 \*\* 6;/);
});

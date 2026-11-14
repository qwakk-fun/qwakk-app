/**
 * pond: the owner and approver CLI for the Qwakk Pond Vault on QoreChain Diana.
 *
 *   npm run pond -- <command> [options]      (run from contracts/cli)
 *
 * Every command that sends anything prints what it will do and waits for "yes"
 * (or --yes). Keys come from contracts/.env and never leave this machine.
 * Run `npm run pond -- help` for the list.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  fetchPqcStatus,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, toQorAddress, weiToUqorCeil } from "@qorechain/evm";
import {
  bytesToHex,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ERC20_READ_ABI, POND_VAULT_ABI } from "./abi.js";
import {
  crossCheckEncoding,
  describe,
  nextApprovalFields,
  precompileVerifies,
  readApprovalFile,
  signApproval,
  vaultApproverKey,
  writeApprovalFile,
  type ActionRequest,
} from "./approval.js";
import {
  approverAccount,
  broadcastNative,
  devnetRpc,
  explainEvmError,
  PQC_VERIFY_ADDRESS,
  keyStatus,
  network,
  ownerAccount,
  publicClient,
  requireWindowFor,
  txLink,
  vaultAddress,
  walletClient,
  windowStatus,
} from "./chain.js";
import { checkRegisteredKey } from "./keycheck.js";
import { ACTION_NAMES, NATIVE_TOKEN, VaultAction, type ApprovalFields, type VaultActionId } from "./message.js";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !isBoolFlag(argv[i - 1])));
function isBoolFlag(flag: string) {
  return flag === "--yes" || flag === "--approver";
}
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function envBig(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  return BigInt(raw);
}

// ---------------------------------------------------------------------------
// Tokens and amounts (integer math only: parseUnits / formatUnits)
// ---------------------------------------------------------------------------

/**
 * QoreChain Diana test tokens, as in lib/qwakk-assets.ts. Checked 2026-11-14 with
 * symbol() and decimals() on the EVM lane: fUSD 6, fETH 18, fBTC 8 decimals.
 * `resolveToken` checks symbol() again before a symbol is trusted.
 */
const DIANA_TOKENS: Record<string, Address> = {
  fUSD: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  fETH: "0x02292293c13880a26242690eb70a0e42B8E91c28",
  fBTC: "0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A",
};

async function resolveToken(client: PublicClient, raw: string | undefined): Promise<Address> {
  if (!raw || raw.toUpperCase() === "QOR") return NATIVE_TOKEN;
  const known = Object.entries(DIANA_TOKENS).find(([symbol]) => symbol.toLowerCase() === raw.toLowerCase());
  if (known) {
    const symbol = await client.readContract({ address: known[1], abi: ERC20_READ_ABI, functionName: "symbol" });
    if (symbol !== known[0]) throw new Error(`${known[1]} reports symbol ${symbol}, not ${known[0]}. Pass the token address instead.`);
    return known[1];
  }
  if (isAddress(raw, { strict: false })) return getAddress(raw);
  throw new Error(`Unknown token "${raw}". Use QOR, fUSD, fETH, fBTC or a 0x address.`);
}

const decimalsCache = new Map<string, number>();
/** QOR on the EVM lane has 18 decimals (extended denom aqor); ERC-20 decimals are read on chain. */
async function decimalsOf(client: PublicClient, token: Address): Promise<number> {
  if (token === NATIVE_TOKEN) return 18;
  const hit = decimalsCache.get(token);
  if (hit !== undefined) return hit;
  const d = Number(await client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "decimals" }));
  decimalsCache.set(token, d);
  return d;
}

function symbolOf(token: Address): string {
  if (token === NATIVE_TOKEN) return "QOR";
  return Object.entries(DIANA_TOKENS).find(([, a]) => a.toLowerCase() === token.toLowerCase())?.[0] ?? token;
}

function requireAddress(raw: string | undefined, what: string): Address {
  if (!raw || !isAddress(raw, { strict: false })) throw new Error(`${what} must be a 0x address (--to 0x...)`);
  return getAddress(raw);
}

// ---------------------------------------------------------------------------
// Prompts, fees and sending
// ---------------------------------------------------------------------------

async function confirm(lines: string[]): Promise<void> {
  console.log(lines.join("\n"));
  if (flag("yes")) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "yes" to continue: ')).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") throw new Error("Stopped. Nothing was sent.");
}

/** The fee cap each EVM transaction may use. The window is sized with the same number. */
function maxFeePerGas(): bigint {
  return envBig("POND_MAX_FEE_GWEI", 250n) * 1_000_000_000n;
}

type ContractCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

/** Simulate, check the window, send, wait. Returns the hash and the receipt logs. */
async function sendEvm(acc: UnifiedAccount, call: ContractCall | { to: Address; value: bigint }, label: string) {
  const client = publicClient();
  const wallet = walletClient(acc);
  const account = wallet.account;
  let to: Address;
  let data: Hex | undefined;
  let value = 0n;
  if ("abi" in call) {
    try {
      await client.simulateContract({ ...call, account } as Parameters<PublicClient["simulateContract"]>[0]);
    } catch (error) {
      throw new Error(`${label}: ${explainEvmError(error)} (simulated, nothing was sent)`);
    }
    to = call.address;
    data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as Parameters<typeof encodeFunctionData>[0]);
    value = call.value ?? 0n;
  } else {
    to = call.to;
    value = call.value;
  }
  const estimate = await client.estimateGas({ account, to, data, value });
  const gas = (estimate * 13n) / 10n;
  const fees = await client.estimateFeesPerGas();
  const cap = maxFeePerGas();
  const feeCap = fees.maxFeePerGas > cap ? cap : fees.maxFeePerGas;
  if (fees.maxFeePerGas > cap) console.log(`note: network fee cap ${fees.maxFeePerGas} wei is above POND_MAX_FEE_GWEI; using ${cap} wei`);
  const priority = fees.maxPriorityFeePerGas > feeCap ? feeCap : fees.maxPriorityFeePerGas;
  await requireWindowFor(acc, to, evmWindowCost({ value, gas, maxFeePerGas: feeCap }));

  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account, chain: wallet.chain, to, data, value, gas, maxFeePerGas: feeCap, maxPriorityFeePerGas: priority });
  } catch (error) {
    throw new Error(`${label}: ${explainEvmError(error)}`);
  }
  console.log(`${label}: sent ${txLink(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label}: reverted in block ${receipt.blockNumber}: ${txLink(hash)}`);
  console.log(`${label}: confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  return { hash, logs: receipt.logs };
}

function vaultEvents(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], vault: Address) {
  const out: { eventName: string; args: Record<string, unknown> }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: POND_VAULT_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({ eventName: decoded.eventName, args: (decoded.args ?? {}) as Record<string, unknown> });
    } catch {
      // not one of ours
    }
  }
  return out;
}

const utc = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function status() {
  const net = network();
  const client = publicClient();
  const owner = await ownerAccount();
  console.log(`network   QoreChain Diana (${net.chainId}, EVM ${net.evmChainId})`);
  console.log(`owner     ${owner.evm}  (${owner.cosmos})`);
  await printKey("owner", owner, client);
  const approver = await approverAccount();
  if (approver.evm !== owner.evm) {
    console.log(`approver  ${approver.evm}  (${approver.cosmos})`);
    await printKey("approver", approver, client);
  }
  const w = await windowStatus(owner);
  if (!w.found) console.log("window    none (run: npm run pond -- window vault)");
  else {
    const scope = w.allowedTargets.length ? `scoped to ${w.allowedTargets.join(", ")}` : w.nativeOnly ? "native QOR transfers only" : "unscoped";
    console.log(`window    ${w.live ? "live" : "not usable"}, ${scope}; ${w.remainingBlocks} blocks, ${w.remainingTxs} txs, ${w.remainingValue} uqor left`);
  }
  const vault = vaultAddress(false);
  if (!vault) {
    console.log("vault     not set (POND_VAULT_ADDRESS)");
    return;
  }
  await printVault(client, vault);
}

async function printKey(role: string, acc: UnifiedAccount, client: PublicClient) {
  const s = await keyStatus(client, getAddress(acc.evm));
  if (!s.registered) {
    console.log(`  ${role} PQC key: not registered (run: npm run pond -- register${role === "approver" ? " --approver" : ""})`);
    return;
  }
  const mine = s.pubkey.toLowerCase() === bytesToHex(acc.pqc.publicKey).toLowerCase();
  console.log(
    `  ${role} PQC key: ML-DSA-87 ${s.algorithmId === 1 ? "" : `(alg ${s.algorithmId}) `}registered, ${mine ? "matches this mnemonic" : "NOT the key of this mnemonic"}, ` +
      `proof of possession ${s.possessionProven ? "yes" : "NO (the vault refuses keys without one)"}`,
  );
}

async function printVault(client: PublicClient, vault: Address) {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: vault, abi: POND_VAULT_ABI, functionName, args } as Parameters<PublicClient["readContract"]>[0]) as Promise<T>;
  const [owner, approver, guardian, paused, timelock, nonce, count, qor] = await Promise.all([
    read<Address>("owner"),
    read<Address>("approver"),
    read<Address>("guardian"),
    read<boolean>("paused"),
    read<bigint>("timelock"),
    read<bigint>("nonce"),
    read<bigint>("actionCount"),
    client.getBalance({ address: vault }),
  ]);
  console.log(`vault     ${vault}  (${toQorAddress(vault)})`);
  console.log(`  owner ${owner}, approver ${approver}, guardian ${guardian === zeroAddress ? "none" : guardian}`);
  console.log(`  ${paused ? "PAUSED" : "active"}, timelock ${timelock} s, next nonce ${nonce}, ${count} actions`);
  for (const token of [NATIVE_TOKEN, ...Object.values(DIANA_TOKENS)]) {
    try {
      const balance = token === NATIVE_TOKEN ? qor : await client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [vault] });
      const [cap, left] = await Promise.all([read<bigint>("dailyCap", [token]), read<bigint>("remainingToday", [token])]);
      const d = await decimalsOf(client, token);
      console.log(`  ${symbolOf(token).padEnd(4)} balance ${formatUnits(balance, d)}, daily cap ${formatUnits(cap, d)}, left today ${formatUnits(left, d)}`);
    } catch {
      console.log(`  ${symbolOf(token).padEnd(4)} unreadable on this network`);
    }
  }
  const from = count > 10n ? count - 9n : 1n;
  for (let id = count; id >= from && id > 0n; id--) {
    const a = await read<{ action: number; status: number; eta: bigint; token: Address; to: Address; amount: bigint }>("getAction", [id]);
    const st = ["none", "queued", "executed", "cancelled"][a.status];
    console.log(`  #${id} ${ACTION_NAMES[a.action]} ${st}, eta ${utc(a.eta)}${a.to !== zeroAddress ? `, to ${a.to}` : ""}${a.amount ? `, amount ${a.amount}` : ""}`);
  }
}

async function register() {
  const net = network();
  const acc = flag("approver") ? await approverAccount() : await ownerAccount();
  const s = await fetchPqcStatus({ rest: net.rest, address: acc.cosmos });
  if (s.registered) {
    // Read it the way the vault will: through the pqcKeyStatus precompile.
    const check = checkRegisteredKey(await keyStatus(publicClient(), getAddress(acc.evm)), acc.pqc.publicKey, acc.evm);
    if (!check.ok) throw new Error(`${check.message} Nothing was sent.`);
    console.log(`${acc.cosmos} already has this mnemonic's ML-DSA-87 key, registered with a proof of possession. Nothing to do.`);
    return;
  }
  await confirm([
    `Register the ML-DSA-87 key of ${acc.cosmos} (${acc.evm}) on QoreChain Diana,`,
    "with a proof of possession. Native transaction, fee 0.1 QOR. Signed classically: the chain accepts only this message that way.",
  ]);
  const proofOfPossession = signProofOfPossession({ chainId: net.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  console.log(`registered: ${txLink(await broadcastNative(acc, "classical", [msg]))}`);
}

async function windowCommand() {
  const sub = positional[1];
  const acc = await ownerAccount();
  if (sub === "close") {
    await confirm([`Close the EVM window of ${acc.cosmos}. Native hybrid transaction, fee 0.1 QOR.`]);
    console.log(`closed: ${txLink(await broadcastNative(acc, "hybrid", [closeEvmWindowMsg(acc.cosmos)]))}`);
    return;
  }
  // Diana makes about 0.7 blocks per second (measured 2026-11-14): 1800 blocks is about 43 minutes.
  const blocks = envBig("QORE_WINDOW_BLOCKS", 1800n);
  const fee = maxFeePerGas();
  let maxTxs: bigint;
  let maxValue: bigint;
  let allowedTargets: string[] | undefined;
  if (sub === "deploy") {
    // Contract creation needs an unscoped window (docs: evm-window-reference).
    maxTxs = BigInt(opt("txs") ?? "1");
    maxValue = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: fee }) * maxTxs;
  } else if (sub === "vault") {
    const vault = vaultAddress()!;
    maxTxs = BigInt(opt("txs") ?? "4");
    const deposit = parseEther(opt("deposit-qor") ?? "0");
    // A queue with a 4,627-byte ML-DSA-87 signature uses about 0.5M gas; 1M leaves room.
    maxValue = evmWindowCost({ gas: 1_000_000n, maxFeePerGas: fee }) * maxTxs + weiToUqorCeil(deposit);
    allowedTargets = [vault];
    const extra = process.env.POND_WINDOW_EXTRA_TARGETS?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
    for (const t of extra) allowedTargets.push(requireAddress(t, "POND_WINDOW_EXTRA_TARGETS entry"));
  } else {
    throw new Error("Use: window deploy | window vault [--txs N] [--deposit-qor X] | window close");
  }
  if (process.env.QORE_WINDOW_MAX_UQOR?.trim()) maxValue = envBig("QORE_WINDOW_MAX_UQOR", maxValue);
  await confirm([
    `Open an EVM window for ${acc.cosmos}:`,
    `  ${blocks} blocks, ${maxTxs} transactions, up to ${formatUnits(maxValue, 6)} QOR of value plus fees`,
    `  ${allowedTargets ? `only to ${allowedTargets.join(", ")} (contract creation refused)` : "unscoped (needed to deploy)"}`,
    "Native transaction signed hybrid (secp256k1 + ML-DSA-87), fee 0.1 QOR. It advances the account nonce and replaces any open window.",
  ]);
  const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks, maxTxs, maxValue, ...(allowedTargets ? { allowedTargets } : {}) });
  console.log(`window opened: ${txLink(await broadcastNative(acc, "hybrid", [msg]))}`);
}

async function deploy() {
  const client = publicClient();
  const owner = await ownerAccount();
  const approver = await approverAccount();
  const guardianRaw = process.env.POND_GUARDIAN?.trim();
  const guardian = guardianRaw ? requireAddress(guardianRaw, "POND_GUARDIAN") : zeroAddress;
  const timelock = envBig("POND_TIMELOCK_SECONDS", 120n);
  const cap = parseEther(process.env.POND_NATIVE_DAILY_CAP_QOR?.trim() || "10");
  const check = checkRegisteredKey(await keyStatus(client, getAddress(approver.evm)), approver.pqc.publicKey, `The approver ${approver.evm}`);
  if (!check.ok) {
    const fix = check.problem === "not-registered" ? ` Run: npm run pond -- register${approver.evm === owner.evm ? "" : " --approver"}` : "";
    throw new Error(`${check.message}${fix} Nothing was deployed.`);
  }
  const artifactPath = fileURLToPath(new URL("../../out/PondVault.sol/PondVault.json", import.meta.url));
  let bytecode: Hex;
  try {
    bytecode = (JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
  } catch {
    throw new Error("Build the contract first: cd contracts && forge build");
  }
  await confirm([
    "Deploy PondVault to QoreChain Diana:",
    `  owner ${owner.evm}`,
    `  approver ${approver.evm}`,
    `  guardian ${guardian === zeroAddress ? "none" : guardian}`,
    `  timelock ${timelock} s, native daily cap ${formatUnits(cap, 18)} QOR`,
    "Needs an unscoped window (npm run pond -- window deploy).",
  ]);
  const wallet = walletClient(owner);
  const data = encodeDeploy(bytecode, [getAddress(owner.evm), getAddress(approver.evm), guardian, timelock, cap]);
  const gas = ((await client.estimateGas({ account: wallet.account, data })) * 13n) / 10n;
  const fees = await client.estimateFeesPerGas();
  const feeCap = fees.maxFeePerGas > maxFeePerGas() ? maxFeePerGas() : fees.maxFeePerGas;
  await requireWindowFor(owner, "create", evmWindowCost({ gas, maxFeePerGas: feeCap }));
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, data, gas, maxFeePerGas: feeCap, maxPriorityFeePerGas: fees.maxPriorityFeePerGas > feeCap ? feeCap : fees.maxPriorityFeePerGas });
  } catch (error) {
    throw new Error(`deploy: ${explainEvmError(error)}`);
  }
  console.log(`deploy: sent ${txLink(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy reverted: ${txLink(hash)}`);
  const deployed = getAddress(receipt.contractAddress);
  console.log(`PondVault deployed at ${deployed} (${toQorAddress(deployed)})`);
  console.log(`Put it in contracts/.env:   POND_VAULT_ADDRESS=${deployed}`);
  console.log(`and in the app (read-only dashboard):   QWAKK_VAULT_ADDRESS=${deployed}`);
}

function encodeDeploy(bytecode: Hex, args: readonly [Address, Address, Address, bigint, bigint]): Hex {
  const ctor = POND_VAULT_ABI.find((x) => x.type === "constructor");
  if (!ctor) throw new Error("constructor missing from ABI");
  const encoded = encodeFunctionData({
    abi: [{ type: "function", name: "c", stateMutability: "nonpayable", inputs: ctor.inputs, outputs: [] }],
    functionName: "c",
    args,
  });
  return `${bytecode}${encoded.slice(10)}` as Hex;
}

async function deposit() {
  const vault = vaultAddress()!;
  const amount = positional[1];
  if (!amount) throw new Error("Use: deposit <QOR amount>, for example deposit 0.01");
  const value = parseEther(amount);
  const owner = await ownerAccount();
  await confirm([`Send ${amount} QOR from ${owner.evm} to the vault ${vault}.`]);
  await sendEvm(owner, { to: vault, value }, "deposit");
}

/** Turn command-line options into the action the approver signs. */
async function actionRequest(client: PublicClient, kind: string | undefined): Promise<ActionRequest> {
  switch (kind) {
    case "withdraw": {
      const token = await resolveToken(client, opt("token"));
      const amount = parseUnits(required("amount"), await decimalsOf(client, token));
      return { action: VaultAction.Withdraw, token, to: requireAddress(opt("to"), "--to"), amount };
    }
    case "cap": {
      const token = await resolveToken(client, opt("token"));
      return { action: VaultAction.SetDailyCap, token, to: zeroAddress, amount: parseUnits(required("amount"), await decimalsOf(client, token)) };
    }
    case "timelock":
      return { action: VaultAction.SetTimelock, token: zeroAddress, to: zeroAddress, amount: BigInt(required("seconds")) };
    case "owner":
      return { action: VaultAction.SetOwner, token: zeroAddress, to: requireAddress(opt("to"), "--to"), amount: 0n };
    case "approver":
      return { action: VaultAction.SetApprover, token: zeroAddress, to: requireAddress(opt("to"), "--to"), amount: 0n };
    case "guardian":
      return { action: VaultAction.SetGuardian, token: zeroAddress, to: opt("to") ? requireAddress(opt("to"), "--to") : zeroAddress, amount: 0n };
    case "unpause":
      return { action: VaultAction.Unpause, token: zeroAddress, to: zeroAddress, amount: 0n };
    default:
      throw new Error("Action must be one of: withdraw, cap, timelock, owner, approver, guardian, unpause");
  }
}

function required(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

async function formatter(client: PublicClient) {
  return async (fields: ApprovalFields) => {
    const d = fields.action === VaultAction.Withdraw || fields.action === VaultAction.SetDailyCap ? await decimalsOf(client, fields.token) : 0;
    return describe(fields, (token, amount) => `${formatUnits(amount, d)} ${symbolOf(token)}`);
  };
}

/** What happens after signing, for the prompt: the prompt must name every step that follows. */
function sendStep(fields: ApprovalFields, owner: string): string {
  return fields.action === VaultAction.Unpause
    ? `then send it from the owner ${owner} to the vault in one EVM transaction (unpause takes effect at once):`
    : `then send it from the owner ${owner} to the vault in one EVM transaction (queued, it runs after the timelock):`;
}

/** Build and sign the vault's next approval, after both cross-checks. `heading` names what follows the signature. */
async function makeApproval(client: PublicClient, vault: Address, request: ActionRequest, heading: (fields: ApprovalFields) => string) {
  const ttl = envBig("POND_APPROVAL_TTL_SECONDS", 900n);
  const fields = await nextApprovalFields(client, vault, request, ttl);
  const message = await crossCheckEncoding(client, fields);
  const trusted = await vaultApproverKey(client, vault);
  const approver = await approverAccount();
  const lines = await (await formatter(client))(fields);
  await confirm([heading(fields), ...lines]);
  const signature = signApproval(approver, trusted, message);
  if (!(await precompileVerifies(client, trusted.pubkey, signature, message))) {
    throw new Error("The pqcVerify precompile did not accept the signature. Nothing was sent.");
  }
  console.log(`approval: signed, and the pqcVerify precompile at ${PQC_VERIFY_ADDRESS} accepts it (eth_call)`);
  return { fields, message, signature, approver: trusted.approver };
}

async function approve() {
  const client = publicClient();
  const vault = vaultAddress()!;
  const request = await actionRequest(client, positional[1]);
  const out = opt("out") ?? `approval-${ACTION_NAMES[request.action].toLowerCase()}.json`;
  const a = await makeApproval(client, vault, request, () => `Sign this approval with the approver's ML-DSA-87 key and write it to ${out}. Nothing is sent:`);
  writeApprovalFile(out, a.approver, a.fields, a.message, a.signature);
  console.log(`wrote ${out}. It is useless without the owner's transaction: hand it to the owner, who runs queue --approval ${out}.`);
}

async function queue() {
  const client = publicClient();
  const vault = vaultAddress()!;
  const owner = await ownerAccount();
  const onChainOwner = await client.readContract({ address: vault, abi: POND_VAULT_ABI, functionName: "owner" });
  if (getAddress(onChainOwner) !== getAddress(owner.evm)) throw new Error(`The vault's owner is ${onChainOwner}, not ${owner.evm}.`);

  let fields: ApprovalFields;
  let signature: Hex;
  const file = opt("approval");
  if (file) {
    const loaded = readApprovalFile(file);
    fields = loaded.fields;
    signature = loaded.signature;
    if (getAddress(fields.vault) !== vault) throw new Error(`The approval is for vault ${fields.vault}, not ${vault}.`);
    await crossCheckEncoding(client, fields);
    const trusted = await vaultApproverKey(client, vault);
    if (!(await precompileVerifies(client, trusted.pubkey, signature, loaded.message))) {
      throw new Error("The pqcVerify precompile refuses this approval for the vault's current approver key.");
    }
    const step = fields.action === VaultAction.Unpause ? "unpause takes effect at once" : "queued, it runs after the timelock";
    await confirm([`Send this signed approval from the owner ${owner.evm} to the vault in one EVM transaction (${step}):`, ...(await (await formatter(client))(fields))]);
  } else {
    const a = await makeApproval(client, vault, await actionRequest(client, positional[1]), (f) => `Sign this approval with the approver's ML-DSA-87 key, ${sendStep(f, owner.evm)}`);
    fields = a.fields;
    signature = a.signature;
  }
  return submitApproval(owner, vault, fields, signature);
}

async function submitApproval(owner: UnifiedAccount, vault: Address, fields: ApprovalFields, signature: Hex, label = "queue") {
  if (fields.action === VaultAction.Unpause) {
    const { hash } = await sendEvm(owner, { address: vault, abi: POND_VAULT_ABI, functionName: "unpause", args: [fields.deadline, signature] }, "unpause");
    return { hash, id: undefined, eta: undefined };
  }
  const { hash, logs } = await sendEvm(
    owner,
    { address: vault, abi: POND_VAULT_ABI, functionName: "queue", args: [fields.action, fields.token, fields.to, fields.amount, fields.deadline, signature] },
    label,
  );
  const queued = vaultEvents(logs, vault).find((e) => e.eventName === "ActionQueued");
  const id = queued?.args.id as bigint | undefined;
  const eta = queued?.args.eta as bigint | undefined;
  if (id !== undefined && eta !== undefined) console.log(`queued action #${id}; anyone can execute it from ${utc(eta)} (npm run pond -- execute ${id})`);
  return { hash, id, eta };
}

async function idCommand(fn: "execute" | "cancel") {
  const vault = vaultAddress()!;
  const raw = positional[1];
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`Use: ${fn} <action id>`);
  const owner = await ownerAccount();
  await confirm([`${fn} action #${raw} on ${vault}.`]);
  await sendEvm(owner, { address: vault, abi: POND_VAULT_ABI, functionName: fn, args: [BigInt(raw)] }, fn);
}

async function pause() {
  const vault = vaultAddress()!;
  const owner = await ownerAccount();
  await confirm([`Pause withdrawals on ${vault}. Lifting the pause needs an ML-DSA-87 approval.`]);
  await sendEvm(owner, { address: vault, abi: POND_VAULT_ABI, functionName: "pause" }, "pause");
}

/**
 * The live smoke test: deposit, queue a withdrawal with a fresh ML-DSA-87
 * approval, prove the same approval is refused a second time, wait out the
 * timelock and execute. Three EVM transactions; the replay check is an eth_call.
 */
async function smoke() {
  const client = publicClient();
  const vault = vaultAddress()!;
  const owner = await ownerAccount();
  const depositQor = process.env.POND_SMOKE_DEPOSIT_QOR?.trim() || "0.01";
  const withdrawQor = process.env.POND_SMOKE_WITHDRAW_QOR?.trim() || "0.005";
  const w = await windowStatus(owner);
  if (!w.live || w.remainingTxs < 3n) {
    throw new Error(`The smoke test sends 3 EVM transactions. Open a window first: npm run pond -- window vault --txs 3 --deposit-qor ${depositQor}`);
  }
  await confirm([
    "Smoke test on QoreChain Diana:",
    `  1. deposit ${depositQor} QOR into ${vault}`,
    `  2. queue a ${withdrawQor} QOR withdrawal to ${owner.evm}, approved with ML-DSA-87`,
    "  3. replay the same approval (eth_call only): must be refused",
    "  4. wait for the timelock, then execute",
  ]);
  const report: string[] = [];

  const d = await sendEvm(owner, { to: vault, value: parseEther(depositQor) }, "1/3 deposit");
  report.push(`deposit   ${txLink(d.hash)}`);

  const request: ActionRequest = { action: VaultAction.Withdraw, token: NATIVE_TOKEN, to: getAddress(owner.evm), amount: parseEther(withdrawQor) };
  const approval = await makeApproval(client, vault, request, (f) => `Step 2: sign this approval with the approver's ML-DSA-87 key, ${sendStep(f, owner.evm)}`);
  const q = await submitApproval(owner, vault, approval.fields, approval.signature, "2/3 queue");
  report.push(`queue     ${txLink(q.hash)}  (action #${q.id})`);

  try {
    await client.simulateContract({
      address: vault,
      abi: POND_VAULT_ABI,
      functionName: "queue",
      args: [approval.fields.action, approval.fields.token, approval.fields.to, approval.fields.amount, approval.fields.deadline, approval.signature],
      account: walletClient(owner).account,
    });
    if (devnetRpc()) {
      console.log("replay: accepted by the devnet mock verifier (it accepts any signature); this check is only meaningful on Diana");
      report.push("replay    not checked (devnet mock verifier)");
    } else {
      throw new Error("REPLAY WAS ACCEPTED: stop and investigate");
    }
  } catch (error) {
    const text = explainEvmError(error);
    if (text.includes("REPLAY WAS ACCEPTED")) throw error;
    console.log(`replay: refused as expected (${text})`);
    report.push(`replay    refused (${text}), checked with eth_call`);
  }

  if (q.eta === undefined || q.id === undefined) throw new Error("queue confirmed but no ActionQueued event was found");
  for (;;) {
    const now = (await client.getBlock({ blockTag: "latest" })).timestamp;
    if (now >= q.eta) break;
    console.log(`timelock: ${q.eta - now} s left`);
    await new Promise((r) => setTimeout(r, Number(q.eta! - now > 15n ? 15n : q.eta! - now) * 1000 + 1000));
  }
  const e = await sendEvm(owner, { address: vault, abi: POND_VAULT_ABI, functionName: "execute", args: [q.id] }, "3/3 execute");
  const paid = vaultEvents(e.logs, vault).find((x) => x.eventName === "Withdrawn");
  report.push(`execute   ${txLink(e.hash)}${paid ? `  (Withdrawn ${formatUnits(paid.args.amount as bigint, 18)} QOR)` : ""}`);

  console.log(`\nSmoke test passed${devnetRpc() ? " on the local rehearsal node (not QoreChain)" : " on QoreChain Diana"}:`);
  for (const line of report) console.log(`  ${line}`);
}

/**
 * Optional tie-in check: can a native-lane bank send credit the vault's qor1
 * address (as Qwakk's interface fee transfer would)? Sends 1 uqor and compares
 * the vault's EVM balance before and after. Unverified until this runs.
 */
async function nativeSendTest() {
  const client = publicClient();
  const vault = vaultAddress()!;
  const owner = await ownerAccount();
  const vaultQor = toQorAddress(vault);
  await confirm([`Send 1 uqor on the native lane from ${owner.cosmos} to the vault's qor1 address ${vaultQor}. Fee 0.1 QOR.`]);
  const before = await client.getBalance({ address: vault });
  const msg = {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: owner.cosmos, toAddress: vaultQor, amount: [{ denom: "uqor", amount: "1" }] },
  };
  const hash = await broadcastNative(owner, "hybrid", [msg]);
  console.log(`native send: ${txLink(hash)}`);
  await new Promise((r) => setTimeout(r, 8000));
  const after = await client.getBalance({ address: vault });
  const delta = after - before;
  console.log(`vault EVM balance change: ${delta} wei (1 uqor = 10^12 wei)`);
  console.log(delta === 1_000_000_000_000n ? "OK: a native send reaches the vault." : "Not credited as expected: do not point QWAKK_TREASURY_ADDRESS at the vault.");
}

function help() {
  console.log(`Qwakk Pond Vault CLI (QoreChain Diana)

  status                                   account, PQC key, EVM window and vault state
  register [--approver]                    register the ML-DSA-87 key (with proof of possession)
  window deploy                            open an unscoped window for one deploy
  window vault [--txs N] [--deposit-qor X] open a window scoped to the vault only
  window close                             close the open window
  deploy                                   deploy PondVault (after forge build)
  deposit <QOR>                            send QOR to the vault
  queue <action> [options]                 sign an approval, then send it to the vault (EVM tx)
  queue --approval <file>                  queue an approval signed elsewhere
  approve <action> [options] [--out file]  sign only (approver machine)
  execute <id> | cancel <id> | pause       manage queued actions
  smoke                                    live end-to-end test (3 EVM transactions)
  native-send-test                         send 1 uqor natively to the vault's qor1 address

  actions: withdraw --token QOR|fUSD|fETH|fBTC|0x.. --to 0x.. --amount 1.5
           cap --token .. --amount ..   timelock --seconds N   owner --to 0x..
           approver --to 0x..   guardian [--to 0x..] (no --to removes the guardian)   unpause
  add --yes to skip the confirmation prompt`);
}

const commands: Record<string, () => Promise<unknown>> = {
  status,
  register,
  window: windowCommand,
  deploy,
  deposit,
  queue,
  approve,
  execute: () => idCommand("execute"),
  cancel: () => idCommand("cancel"),
  pause,
  smoke,
  "native-send-test": nativeSendTest,
  help: async () => help(),
};

const run = commands[positional[0] ?? "help"];
if (!run) {
  help();
  process.exitCode = 1;
} else {
  run().catch((error: unknown) => {
    // viem errors carry a one-line shortMessage; never dump a multi-line node answer.
    const e = error as { shortMessage?: string; message?: string };
    console.error((e?.shortMessage ?? e?.message ?? String(error)).split("\n")[0]);
    process.exitCode = 1;
  });
}

export type { VaultActionId };

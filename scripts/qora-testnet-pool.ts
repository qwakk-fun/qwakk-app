import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  createClient,
  deriveUnifiedAccount,
  getPqcStatus,
  waitForTx,
  type EthBroadcaster,
} from "@qorechain/sdk";

import { buildCreatePoolPlan } from "../lib/qora-pool-route";

const CHAIN_ID = "qorechain-diana";
const REST_URL = (process.env.QORECHAIN_REST_URL ?? "https://api-testnet.qore.host").replace(/\/$/, "");
const RPC_URL = (process.env.QORECHAIN_RPC_URL ?? "https://rpc-testnet.qore.host").replace(/\/$/, "");
const EVM_RPC_URL = (process.env.QORECHAIN_EVM_RPC_URL ?? "https://evm-testnet.qore.host").replace(/\/$/, "");
const TX_FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "1000000" };

type AccountInfo = { accountNumber: bigint; sequence: bigint };
type BroadcastEnvelope = {
  tx_response?: {
    code?: number | string;
    txhash?: string;
    height?: number | string;
    raw_log?: string;
    gas_used?: string;
    gas_wanted?: string;
  };
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required`);
  if (!/^\d+$/.test(value) || BigInt(value) <= BigInt(0)) throw new Error(`${name} must be a positive integer`);
  return value;
}

function hexBytes(value: string) {
  const clean = value.replace(/^0x/, "");
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) throw new Error("Invalid public key");
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function findAccountInfo(value: unknown): AccountInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const accountNumber = record.account_number ?? record.accountNumber;
  const sequence = record.sequence;
  if ((typeof accountNumber === "string" || typeof accountNumber === "number") &&
      (typeof sequence === "string" || typeof sequence === "number")) {
    return { accountNumber: BigInt(accountNumber), sequence: BigInt(sequence) };
  }
  for (const nested of Object.values(record)) {
    const found = findAccountInfo(nested);
    if (found) return found;
  }
  return null;
}

async function readAccount(address: string) {
  const response = await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Fund the Qora testnet wallet before preparing a pool transaction");
  const info = findAccountInfo(await response.json());
  if (!info) throw new Error("Diana returned an unsupported account response");
  return info;
}

async function readBalances(address: string) {
  const response = await fetch(`${REST_URL}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Unable to read the Qora testnet wallet balance");
  const data = await response.json() as { balances?: Array<{ denom?: string; amount?: string }> };
  return new Map((data.balances ?? []).map((coin) => [coin.denom ?? "", coin.amount ?? "0"]));
}

const broadcaster: EthBroadcaster = {
  async broadcastTx(rawTx) {
    const response = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tx_bytes: Buffer.from(rawTx).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Diana rejected the transaction submission");
    const result = (await response.json()) as BroadcastEnvelope;
    const txResult = result.tx_response;
    if (!txResult?.txhash) throw new Error("Diana did not return a transaction hash");
    return {
      code: Number(txResult.code ?? 0),
      transactionHash: txResult.txhash,
      height: txResult.height ? Number(txResult.height) : undefined,
      gasUsed: txResult.gas_used ? BigInt(txResult.gas_used) : undefined,
      gasWanted: txResult.gas_wanted ? BigInt(txResult.gas_wanted) : undefined,
      rawLog: txResult.raw_log,
    };
  },
};

async function main() {
  const mnemonic = required("QORA_TESTNET_MNEMONIC");
  const denomA = argument("--denom-a") ?? process.env.QORA_POOL_DENOM_A?.trim() ?? "uqor";
  const amountA = positiveInteger("--amount-a or QORA_POOL_AMOUNT_A", argument("--amount-a") ?? process.env.QORA_POOL_AMOUNT_A?.trim());
  const denomB = argument("--denom-b") ?? required("QORA_POOL_DENOM_B");
  const amountB = positiveInteger("--amount-b or QORA_POOL_AMOUNT_B", argument("--amount-b") ?? process.env.QORA_POOL_AMOUNT_B?.trim());
  const poolTypeValue = argument("--pool-type") ?? process.env.QORA_POOL_TYPE;
  const poolType = poolTypeValue === "stable_swap" ? "stable_swap" : "constant_product";
  const amplificationCoefficient = poolType === "stable_swap"
    ? Number(argument("--amplification") ?? process.env.QORA_POOL_AMPLIFICATION ?? "200")
    : 0;

  const account = await deriveUnifiedAccount(mnemonic);
  const plan = buildCreatePoolPlan({
    creator: account.cosmos,
    poolType,
    denomA,
    amountA,
    denomB,
    amountB,
    amplificationCoefficient,
  });
  const balances = await readBalances(account.cosmos);
  const client = createClient({
    network: "testnet",
    endpoints: { rest: REST_URL, rpc: RPC_URL, evmRpc: EVM_RPC_URL },
  });
  const pqcStatus = await getPqcStatus(client, account.cosmos);

  console.log(`Qora testnet wallet: ${account.cosmos}`);
  console.log(`Balance ${denomA}: ${balances.get(denomA) ?? "0"}`);
  console.log(`Balance ${denomB}: ${balances.get(denomB) ?? "0"}`);
  console.log(`PQC registered: ${pqcStatus.registered ? "yes" : "no"}`);
  console.log(`Pool: ${amountA}${denomA} / ${amountB}${denomB} (${plan.poolType})`);

  if (!process.argv.includes("--broadcast")) {
    console.log("Dry run complete. Add --broadcast only after verifying the wallet, balances and pool amounts.");
    return;
  }

  let auth = await readAccount(account.cosmos);
  if (!pqcStatus.registered) {
    const registration = buildRegisterPqcKeyMsg(account.cosmos, {
      pqcKeypair: account.pqc,
      ecdsaPubkey: hexBytes(account.publicKey),
      keyType: "hybrid",
    });
    const classicalSigner = new EthNativeSigner(account, { signMode: "classical" });
    const result = await classicalSigner.signAndBroadcast(broadcaster, {
      chainId: CHAIN_ID,
      accountNumber: auth.accountNumber,
      sequence: auth.sequence,
      messages: [registration],
      fee: TX_FEE,
      memo: "Qora testnet PQC registration",
    });
    await waitForTx(client.rest, result.transactionHash);
    console.log(`PQC registration confirmed: ${result.transactionHash}`);
    auth = await readAccount(account.cosmos);
  }

  const hybridSigner = new EthNativeSigner(account);
  const result = await hybridSigner.signAndBroadcast(broadcaster, {
    chainId: CHAIN_ID,
    accountNumber: auth.accountNumber,
    sequence: auth.sequence,
    messages: [plan.message],
    fee: TX_FEE,
    memo: "Qora first Diana AMM pool",
  });
  const included = await waitForTx(client.rest, result.transactionHash);
  console.log(`Pool transaction confirmed at height ${included.height}: ${included.txHash}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unable to prepare the Diana pool transaction";
  console.error(message);
  process.exitCode = 1;
});

# Qora

Qora is a non-custodial interface for QoreChain's native `x/amm` module. The
current target is the Diana testnet. Qora does not deploy or use a separate EVM
AMM contract.

## Current status

Qora is read-only today. Swap, pool creation and liquidity flows are built but
stay hidden until native signing works end to end (see Wallet actions below).

What works:

- Pool, market, account and transaction data are read from Diana.
- Swap quotes use the native AMM quote endpoint (`/qorechain/amm/v1/quote/exact_in`).
- Liquidity positions are read from the AMM LP balance query. The AMM keeps LP
  shares in its own store, not as bank tokens.
- The indexer stores pools, swaps and 1m, 5m, 1h, 6h and 1d candles in
  PostgreSQL. Pool pages chart 1m, 5m, 1h and 1d candles.
- Unsigned native transactions can be built for a QoreX account and relayed
  after the user signs them (`/api/native-tx/*`). The relay only accepts native
  AMM messages, plus the disclosed interface fee transfer on a swap.
- QOR/USD price, volume and market cap come from CoinGecko and are labeled as
  such wherever they appear.

What is blocking trading (checked on 2026-10-01):

- The native AMM keeper is live on Diana: a simulated `MsgCreatePool` now fails
  on balances instead of "not implemented". No pool exists yet.
- QoreX 0.3.3 (Chrome) and 0.3.4 (Firefox) always use `qorechain-vladi` for
  dApp requests, so `signDirect` for `qorechain-diana` is refused before any
  approval. QoreX also has no documented way for a third-party dApp to add the
  required post-quantum signature.
- Diana and mainnet only have `uqor` in bank supply. A second denom is expected
  once QoreChain bridges roll out.

### Wallet actions

Swap, pool creation and add or remove liquidity are implemented behind one
switch:

```text
QORA_NATIVE_ACTIONS=enabled
```

It is read at runtime, so it can be changed in CapRover without a rebuild.
While it is off, no wallet action is rendered and `/api/native-tx/prepare`
returns 404. When it is on, every action is built on the server, simulated
against QoreChain Diana (so a failing transaction is explained before the
wallet opens, and the fee comes from simulated gas), signed in QoreX, relayed
and followed into a block. Turn it on only after the signing probe below
succeeds.

### Signing probe

`/dev/signing-probe` is available in development only. It asks QoreX to sign a
native AMM swap against a pool that does not exist and reports whether Diana
accepts the signature. No tokens move. The network fee is 0.06 QOR. Run it again
once the blockers above are resolved.

Never add a mnemonic or private key to the repository, browser, PostgreSQL or
CapRover. Qora only needs public wallet addresses.

## Requirements

- Node.js `>=22.13.0`
- PostgreSQL 16 for the indexer
- Docker for the production image

## Local verification

```bash
npm ci
npm test
npm run lint
npm run typecheck
```

To run the full local stack:

```bash
docker compose up --build
```

The web application is available on port `3001`, the indexer on port `4400`
and PostgreSQL on port `5438`.

## Architecture

The same root Docker image can run in two roles:

- `QORA_PROCESS_ROLE=web`: starts the Qora web application on port `3000`.
- `QORA_PROCESS_ROLE=indexer`: starts the QoreChain indexer on port `4400`.

The indexer reads Diana REST/RPC data and writes normalized pools, swaps and
candles to PostgreSQL. The web application reads that indexed data through the
indexer and queries Diana server-side for live account and quote data.

## CapRover deployment

Create three CapRover apps. Suggested names below are also used by CapRover's
internal service discovery.

### 1. PostgreSQL

Create a one-click PostgreSQL app named `qora-postgres` with a persistent
volume. Create a strong password and keep the database private to the CapRover
network.

Recommended database values:

```text
POSTGRES_DB=qora
POSTGRES_USER=qora
POSTGRES_PASSWORD=<strong-password>
```

### 2. Indexer

Create `qora-indexer`, deploy this repository and set its container HTTP port
to `4400`. Configure:

```text
QORA_PROCESS_ROLE=indexer
DATABASE_URL=postgresql://qora:<url-encoded-password>@srv-captain--qora-postgres:5432/qora
QORECHAIN_REST_URL=https://api-testnet.qore.host
QORECHAIN_RPC_URL=https://rpc-testnet.qore.host
QORA_INDEXER_PORT=4400
# Optional: first block to index on a fresh database. It must still be kept by
# the node. Without it the indexer starts from the current height.
QORA_INDEXER_START_HEIGHT=
```

The indexer health endpoint is `/health`.

### 3. Web application

Create `qora-web`, deploy the same repository and set its container HTTP port
to `3000`. Configure:

```text
QORA_PROCESS_ROLE=web
QORA_INDEXER_URL=http://srv-captain--qora-indexer:4400
QORECHAIN_REST_URL=https://api-testnet.qore.host
QORECHAIN_RPC_URL=https://rpc-testnet.qore.host
QORA_TREASURY_ADDRESS=<public-qor-address>
QORA_SWAP_FEE_BPS=5
# Leave unset until the signing probe succeeds on Diana.
QORA_NATIVE_ACTIONS=
# Optional CoinGecko demo key for higher market data limits.
COINGECKO_API_KEY=
PORT=3000
```

`QORA_SWAP_FEE_BPS=5` means a disclosed 0.05% interface fee. If the public
treasury address is missing or invalid, the fee route stays disabled. The web
health endpoint is `/api/health` and reports both Diana and indexer readiness.

After configuring both applications, deploy the same branch to each:

```bash
caprover deploy -n <captain-machine-name> -a qora-indexer -b main
caprover deploy -n <captain-machine-name> -a qora-web -b main
```

The root `captain-definition` uses the production `Dockerfile`; the environment
role selects which process starts.

## First Diana pool

The bootstrap command uses the official QoreChain SDK and creates a native
`MsgCreatePool`. It performs a dry run unless `--broadcast` is explicitly
provided.

Set `QORA_TESTNET_MNEMONIC` only in the current trusted terminal session. Do not
put it in `.env`, shell history, CapRover or source control.

```bash
npm run pool:testnet -- --denom-a uqor --amount-a 100000000 --denom-b <second-denom> --amount-b <base-units>
npm run pool:testnet -- --denom-a uqor --amount-a 100000000 --denom-b <second-denom> --amount-b <base-units> --broadcast
```

The wallet must have enough QOR for the current 100 QOR pool creation fee,
initial liquidity and transaction gas. Use a separate testnet-only wallet.

## Useful commands

- `npm run build`: build the production application.
- `npm test`: build and run SSR plus native AMM calculation tests.
- `npm run lint`: lint the full project.
- `npm run typecheck`: type-check the full project. The build does not type-check.
- `npm run indexer`: start only the local indexer.
- `npm run pool:testnet`: prepare or broadcast the first native Diana pool.

Native AMM reference: <https://docs.qorechain.io/architecture/amm/>

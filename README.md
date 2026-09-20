# Qora

Qora is a non-custodial interface for QoreChain's native `x/amm` module. The
current target is the Diana testnet. Qora does not deploy or use a separate EVM
AMM contract.

## Current status

- Pool, market, account and transaction data are read from Diana.
- Swap quotes use the native AMM quote endpoint.
- Pool creation and liquidity actions produce native `x/amm` messages.
- The indexer stores market history in PostgreSQL.
- Public transaction submission is waiting for QoreX to expose third-party PQC
  signing for native AMM messages.
- Diana needs a second native test denom before the first usable pool can be
  created. Its current bank supply only contains `uqor`.

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
- `npm run indexer`: start only the local indexer.
- `npm run pool:testnet`: prepare or broadcast the first native Diana pool.

Native AMM reference: <https://docs.qorechain.io/architecture/amm/>

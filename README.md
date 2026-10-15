# Qwakk

Swap it. Qwakk it.

Qwakk is a non-custodial interface for QoreChain's native `x/amm` module. The
current target is the Diana testnet. Qwakk does not deploy or use a separate EVM
AMM contract.

## Current status

Qwakk is read-only today. Swap, pool creation and liquidity flows are built but
stay hidden until native signing works end to end (see Wallet actions below).

What works:

- Pool, market, account and transaction data are read from Diana.
- Swap quotes use the native AMM quote endpoint (`/qorechain/amm/v1/quote/exact_in`),
  which the live keeper answers (it returns "pool not found" until a pool
  exists). Qwakk adds price impact, blocks swaps above the chain's
  `max_swap_impact_bps` cap and re-quotes before the wallet opens.
- Liquidity positions are read from the AMM LP balance query. The AMM keeps LP
  shares in its own store, not as bank tokens.
- The indexer stores pools, swaps and 1m, 5m, 1h, 6h and 1d candles in
  PostgreSQL. Pool pages chart 1m, 5m, 1h and 1d candles.
- Native actions are prepared on the server (`/api/native-tx/prepare`): it
  builds the messages, simulates them against Diana and returns them for QoreX
  `signAndBroadcast` (QoreX 0.3.5 or newer). QoreX asks the user to approve,
  adds its post-quantum layer, signs and broadcasts. Qwakk never signs or relays
  a transaction. The server only prepares native AMM messages, plus the
  disclosed interface fee transfer on a swap.
- QOR/USD price, volume and market cap come from CoinGecko and are labeled as
  such wherever they appear.

What is blocking trading (checked on 2026-10-12):

- The native AMM keeper is live on Diana: a simulated `MsgCreatePool` fails on
  balances instead of "not implemented". No pool exists yet.
- Diana only has `uqor` in bank supply, so no pool can be opened. There is no
  token factory, ERC20 registration is permissioned
  (`permissionless_registration: false`), there are no IBC channels and every
  bridge is `pending`. QoreChain has been asked for a test denom.
- QoreX 0.3.5 refuses bare classical `signDirect` on QoreChain networks. Qwakk
  now uses QoreX `signAndBroadcast`, where the wallet adds the post-quantum
  layer. This path is built but not yet verified end to end on Diana: run the
  signing probe below.

### Wallet actions

Swap, pool creation and add or remove liquidity are implemented behind one
switch:

```text
QWAKK_NATIVE_ACTIONS=enabled
```

It is read at runtime, so it can be changed in CapRover without a rebuild.
While it is off, no wallet action is rendered and `/api/native-tx/prepare`
returns 404. When it is on, every action is built on the server, simulated against QoreChain
Diana (so a failing transaction is explained before the wallet opens, and the
gas limit comes from simulated gas), then approved, signed and broadcast by
QoreX and followed into a block. Turn it on only after the signing probe below
succeeds.

QoreX must be 0.3.5 or newer and set to QoreChain Diana (in QoreX: turn on
Developer mode, then Switch to testnet (diana)). Otherwise Qwakk shows an update
or network instruction instead of opening the wallet.

Gas: the prepare route sets `gasLimit = simulated gas x 1.3 + 100000`, clamped to
QoreX's 100000 to 5000000 range. Simulation runs without the post-quantum layer,
which costs about 77k to 91k extra gas on Diana, so the 100k headroom covers it.
QoreX prices the fee itself at 0.15 uqor per gas. If an account has no
post-quantum key on chain yet, QoreX first registers one in a separate
transaction with its own fee.

### Signing probe

`/dev/signing-probe` is available in development only and runs only when you
click "Run probe". It asks QoreX to approve, sign and broadcast a 1 uqor
transfer from the connected wallet to itself on QoreChain Diana, so no pool is
needed. It proves the wallet-built post-quantum transaction and the bank
transfer used for the interface fee. It shows the transaction hash, result
code, block height and an explorer link. The network fee is about 0.03 QOR.

Never add a mnemonic or private key to the repository, browser, PostgreSQL or
CapRover. Qwakk only needs public wallet addresses.

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

- `QWAKK_PROCESS_ROLE=web`: starts the Qwakk web application on port `3000`.
- `QWAKK_PROCESS_ROLE=indexer`: starts the QoreChain indexer on port `4400`.

The indexer reads Diana REST/RPC data and writes normalized pools, swaps and
candles to PostgreSQL. The web application reads that indexed data through the
indexer and queries Diana server-side for live account and quote data.

## CapRover deployment

Create three CapRover apps. Suggested names below are also used by CapRover's
internal service discovery.

### 1. PostgreSQL

Create a one-click PostgreSQL app named `qwakk-postgres` with a persistent
volume. Create a strong password and keep the database private to the CapRover
network.

Recommended database values:

```text
POSTGRES_DB=qwakk
POSTGRES_USER=qwakk
POSTGRES_PASSWORD=<strong-password>
```

### 2. Indexer

Create `qwakk-indexer`, deploy this repository and set its container HTTP port
to `4400`. Configure:

```text
QWAKK_PROCESS_ROLE=indexer
DATABASE_URL=postgresql://qwakk:<url-encoded-password>@srv-captain--qwakk-postgres:5432/qwakk
QORECHAIN_REST_URL=https://api-testnet.qore.host
QORECHAIN_RPC_URL=https://rpc-testnet.qore.host
QWAKK_INDEXER_PORT=4400
# Optional: first block to index on a fresh database. It must still be kept by
# the node. Without it the indexer starts from the current height.
QWAKK_INDEXER_START_HEIGHT=
# Testnet points. Leave unset until the program works end to end; set it on
# the web app too. LP snapshots and scoring run either way.
QWAKK_POINTS_ENABLED=
# Owner and test wallets kept off the leaderboard (comma separated qor1 addresses).
QWAKK_POINTS_EXCLUDED_ADDRESSES=
```

The indexer health endpoint is `/health`.

#### Points settings

Points rank on-chain activity on Qwakk pools and have no monetary value. Every
rule is an indexer environment variable. Leave a variable empty to use the
default. A change applies on the next indexer start, and the whole season is
rescored from the stored swaps, liquidity events and hourly LP snapshots.
Pools without a QOR side score 0 for now.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_POINTS_ENABLED` | off | `enabled` turns on the public points API (web app and indexer) |
| `QWAKK_POINTS_SEASON` | `testnet-1` | Season name |
| `QWAKK_POINTS_SEASON_START_HEIGHT` | `0` | First block of the season (0 = first indexed block) |
| `QWAKK_POINTS_SEASON_END_HEIGHT` | open | Last block of the season |
| `QWAKK_POINTS_EXCLUDED_ADDRESSES` | none | Addresses kept off the leaderboard; `QWAKK_TREASURY_ADDRESS` is added when set |
| `QWAKK_POINTS_MIN_SWAP_QOR` | `1` | Smallest swap (QOR side) that counts |
| `QWAKK_POINTS_SWAP_POINTS_PER_QOR` | `1` | Points per QOR of counted swap volume |
| `QWAKK_POINTS_SWAP_DAILY_FULL_QOR` | `1000` | Daily volume per address at the full rate |
| `QWAKK_POINTS_SWAP_DAILY_MAX_QOR` | `10000` | Daily volume per address above which nothing counts |
| `QWAKK_POINTS_SWAP_EXCESS_FACTOR_BPS` | `2000` | Rate between the full and max daily volume (20%) |
| `QWAKK_POINTS_ROUND_TRIP_WINDOW_SECONDS` | `1800` | A reversal in the same pool within this window is a round trip |
| `QWAKK_POINTS_ROUND_TRIP_FACTOR_BPS` | `1000` | Weight of round trip volume on both legs (10%) |
| `QWAKK_POINTS_LP_POINTS_PER_QOR_HOUR` | `0.01` | Points per QOR of position value per hour held |
| `QWAKK_POINTS_LP_HOURLY_FULL_QOR` | `5000` | Hourly position value per address at the full rate |
| `QWAKK_POINTS_LP_HOURLY_MAX_QOR` | `50000` | Hourly position value per address above which nothing counts |
| `QWAKK_POINTS_LP_EXCESS_FACTOR_BPS` | `2000` | Rate between the full and max hourly value (20%) |
| `QWAKK_POINTS_LP_MIN_HOLD_HOURS` | `6` | Consecutive hours a position must be held before any hour counts |
| `QWAKK_POINTS_LP_MAX_INTERVAL_HOURS` | `3` | Longest gap between two snapshots that is still credited |
| `QWAKK_POINTS_POOL_BONUS` | `500` | One-time points for a created pool once it is used |
| `QWAKK_POINTS_POOL_BONUS_MIN_TRADERS` | `5` | Other addresses with counted swaps needed to unlock the bonus |
| `QWAKK_POINTS_POOL_BONUS_MAX_PER_ADDRESS` | `3` | Most pool bonuses per creator in a season |
| `QWAKK_POINTS_ACTIVE_DAY_POINTS` | `50` | Points per UTC day with a qualifying action |
| `QWAKK_POINTS_MIN_ACTION_QOR` | `1` | Smallest liquidity add or pool creation (QOR side) that counts as activity |

### 3. Web application

Create `qwakk-web`, deploy the same repository and set its container HTTP port
to `3000`. Configure:

```text
QWAKK_PROCESS_ROLE=web
QWAKK_INDEXER_URL=http://srv-captain--qwakk-indexer:4400
QORECHAIN_REST_URL=https://api-testnet.qore.host
QORECHAIN_RPC_URL=https://rpc-testnet.qore.host
QWAKK_TREASURY_ADDRESS=<public-qor-address>
QWAKK_SWAP_FEE_BPS=10
# Leave unset until the signing probe succeeds on Diana.
QWAKK_NATIVE_ACTIONS=
# Optional CoinGecko demo key for higher market data limits.
COINGECKO_API_KEY=
# Leave unset until the points program works end to end; must match the indexer.
QWAKK_POINTS_ENABLED=
PORT=3000
```

`QWAKK_SWAP_FEE_BPS=10` means a disclosed 0.10% interface fee. The code caps it
at 30 (0.30%), the limit promised on the public `/fees` page. If the public
treasury address is missing or invalid, the fee route stays disabled. The web
health endpoint is `/api/health` and reports both Diana and indexer readiness.

After configuring both applications, deploy the same branch to each:

```bash
caprover deploy -n <captain-machine-name> -a qwakk-indexer -b main
caprover deploy -n <captain-machine-name> -a qwakk-web -b main
```

The root `captain-definition` uses the production `Dockerfile`; the environment
role selects which process starts.

## First Diana pool

The bootstrap command uses the official QoreChain SDK and creates a native
`MsgCreatePool`. It performs a dry run unless `--broadcast` is explicitly
provided.

Set `QWAKK_TESTNET_MNEMONIC` only in the current trusted terminal session. Do not
put it in `.env`, shell history, CapRover or source control.

```bash
npm run pool:testnet -- --denom-a uqor --amount-a 100000000 --denom-b <second-denom> --amount-b <base-units>
npm run pool:testnet -- --denom-a uqor --amount-a 100000000 --denom-b <second-denom> --amount-b <base-units> --broadcast
```

The wallet must have enough QOR for the current 100 QOR pool creation fee,
initial liquidity and transaction gas. Use a separate testnet-only wallet.

## Launch-day AMM check

Once a pool exists, run the keyless verifier before turning
`QWAKK_NATIVE_ACTIONS` on. It never signs or broadcasts. It compares Qwakk's
swap, add-liquidity and remove-liquidity math with QoreChain's quote and with
simulated keeper events, simulates the interface fee transfer and the swap in
one transaction, and prints a pass/fail table:

```bash
npm run verify:amm -- --pool <id> --address <qor1 address holding both tokens>
```

Use an address that holds both pool tokens and some QOR so the simulations get
past the bank step. The script header lists every option.

## Useful commands

- `npm run build`: build the production application.
- `npm test`: build and run SSR plus native AMM calculation tests.
- `npm run lint`: lint the full project.
- `npm run typecheck`: type-check the full project. The build does not type-check.
- `npm run indexer`: start only the local indexer.
- `npm run pool:testnet`: prepare or broadcast the first native Diana pool.
- `npm run verify:amm`: check Qwakk's AMM math and messages against a live pool without signing.

Native AMM reference: <https://docs.qorechain.io/architecture/amm/>

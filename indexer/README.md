# Qwakk indexer

Reads QoreChain blocks (RPC) and AMM state (REST), writes pools, swaps,
liquidity events, candles and LP snapshots to PostgreSQL, and serves them on
port 4400. `schema.sql` is applied on every start and only ever adds things.

Run it locally with `npm run indexer` from `qwakk-app` (or `./dev.sh`).

## Network

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_NETWORK` | `testnet` | `testnet` (QoreChain Diana, `qorechain-diana`) or `mainnet` (`qorechain-vladi`). Picks the default endpoints and the curated token list. |
| `QORECHAIN_REST_URL` | network preset | Overrides the REST endpoint (for example a private node). The other network's public endpoint is ignored with a warning. |
| `QORECHAIN_RPC_URL` | network preset | Same, for the RPC endpoint. |
| `QWAKK_INDEXER_ADOPT_CHAIN_ID` | unset | Only for an old database written before chain ids were recorded: confirms which chain it holds. Without it such a database is treated as testnet data. |

The presets mirror `lib/qwakk-network.ts` (the indexer image ships only this
folder, so it keeps its own copy in `indexer-config.ts`).

### Chain id guard

On start the indexer reads the chain id from the RPC (`/status`,
`node_info.network`) and the REST gateway (`/cosmos/base/tendermint/v1beta1/node_info`).
It refuses to start, with a clear error, when:

- the node serves a different chain than `QWAKK_NETWORK` names,
- REST and RPC serve different chains,
- the database is labelled with another chain (`indexer_state.chain_id`).

A new database is labelled on its first start. Every sync tick checks the RPC
chain id again and writes nothing if it changed. Use one database per network.

## Start height

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_INDEXER_START_HEIGHT` | unset | First block to index on a fresh database. |

On a fresh database without `QWAKK_INDEXER_START_HEIGHT`, indexing starts at
the earliest pool's creation block when pools already exist (no swap can be
older than its pool), otherwise at the chain tip. It never starts below the
node's earliest kept block.

- **Testnet (Diana)** prunes old blocks (about 6 days kept on 2026-10-31). If a
  saved height falls behind the earliest kept block, the gap is logged, stored
  in `indexer_state.pruned_gap` and indexing resumes at the earliest kept block.
- **Mainnet** keeps every block (earliest height 1) and had no pools and only
  `uqor` on 2026-10-31. Start at the tip, the default. If pools exist by the
  time the mainnet indexer first runs, the default above starts at the first
  pool's creation block. To keep history from before the first pool (for
  example a token's registration), set `QWAKK_INDEXER_START_HEIGHT` to that
  block on the first start only.

A fresh database records its first indexed block in
`indexer_state.history_start_height`. Databases created before that key
existed do not have it; readers fall back to the earliest stored swap or
liquidity event (see `GET /pnl/:address`).

Far behind the tip, the indexer finds AMM blocks with the RPC `tx_search` and
reads only those. Before trusting the search it checks that it finds an AMM
event already known to the database; otherwise it scans every block.

## Health

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWAKK_INDEXER_MAX_LAG` | `600` | Blocks behind the tip before `/health` is not ok. Same default as the web's deep health check. |
| `QWAKK_INDEXER_MAX_SYNC_AGE_SECONDS` | `120` | Seconds without sync progress before `/health` reports `stalled`. |

- `GET /livez`: `200 {"ok":true}` while the process answers. Use it for container restarts.
- `GET /health`: `200` when ok, `503` otherwise.

```json
{
  "network": "testnet",
  "ok": true,
  "status": "ok",
  "chainId": "qorechain-diana",
  "height": "9236634",
  "chainHeight": "9236650",
  "lag": 16,
  "maxLag": 600,
  "lastSyncAt": "2026-10-31T20:00:00.000Z",
  "lastErrorAt": null
}
```

`status` is `starting` (no sync yet), `ok`, `lagging` (more than `maxLag`
behind) or `stalled` (no progress for `maxSyncAgeSeconds`). `height` is the
last indexed block.

## Retention

A job runs every `QWAKK_RETENTION_INTERVAL_MINUTES` and logs what it pruned.
Raw swaps and liquidity events are never deleted.

| Variable | Default | What is pruned |
| --- | --- | --- |
| `QWAKK_RETENTION` | on | `off` disables the whole job. |
| `QWAKK_RETENTION_INTERVAL_MINUTES` | `60` | How often the job runs (minimum 5). |
| `QWAKK_RETENTION_CANDLES_1M_DAYS` | `7` | 1m candles older than this. The API serves 24 hours of them (minimum 2). |
| `QWAKK_RETENTION_CANDLES_5M_DAYS` | `14` | 5m candles older than this. The API serves 3 days of them (minimum 4). |
| `QWAKK_RETENTION_SWAP_RAW_EVENT_DAYS` | `30` | `swaps.raw_event` of older swaps is emptied to `{}`. Amounts, denoms, sender and price stay. |
| `QWAKK_RETENTION_LP_SNAPSHOT_DAYS` | `90` | LP snapshots older than this, only when no season is set (`QWAKK_POINTS_SEASON_START_HEIGHT` is 0 or unset). When a season start height is set, only snapshots below it are pruned, whether or not points are public, because scoring rebuilds the season from them either way. The latest snapshot of every position is always kept. |

Setting any period to `0` keeps that data forever. The 1h, 4h and 1d candles
are not pruned; latest prices are read from 1h candles so they survive 1m
pruning.

4h candles replaced 6h. On every start, before the first sync, the indexer
fills 4h candles that are missing from the stored 1h candles (open of the first
hour, close of the last, high and low extremes, summed volume and trades), so
history indexed before 4h existed gets charts without a reindex or manual SQL.
Buckets that already have a 4h row are left untouched. Old 6h rows stay in the
table, are no longer written or served, and `interval=6h` answers 400.

## Endpoints

- `GET /markets`: every pool with quote-oriented prices, volume, TVL and `low_liquidity`.
- `GET /pools/:id?interval=1m|5m|1h|4h|1d`: one pool, its candles (`candles` B per A, `quote_candles` quote per base) and its latest 60 swaps.
- `GET /positions/:address`: the address's open LP positions from indexed data:

```json
{
  "address": "qor1...",
  "indexedHeight": "9236634",
  "positions": [
    {
      "poolId": "1",
      "tokenA": "erc20:0x0229...",
      "tokenB": "uqor",
      "tokenASymbol": "fETH",
      "tokenBSymbol": "QOR",
      "tokenADecimals": 18,
      "tokenBDecimals": 6,
      "lpDenom": "amm-lp/1",
      "lpBalance": "1000022",
      "lpSupply": "1000022",
      "reserveA": "980129",
      "reserveB": "1020319",
      "source": "snapshot_and_events",
      "asOfHeight": "9005181"
    }
  ]
}
```

  The balance is the latest hourly LP snapshot (the chain's LP balance query)
  plus LP minted and burned by the address's later events, or the sum of its
  events when no snapshot exists yet (`source`: `snapshot`,
  `snapshot_and_events`, `events`). `lpBalance` is `null` with `source`
  `incomplete` when an event did not carry an LP amount; read that pool from
  the chain. Positions opened while the indexer was not indexing (for example
  inside a pruned gap) only appear once they have an indexed event.
- `GET /pnl/:address`: per-token cost basis and profit and loss of a wallet,
  in QOR, with the average-cost method (engine: `cost-basis.ts`, queries: `wallet-pnl.ts`). The web app
  serves it as `GET /api/pnl?address=qor1...` (same body; 400 bad address,
  422 more than 50,000 swaps, 503 unavailable, always fixed copy).

```json
{
  "address": "qor1...",
  "method": "average_cost",
  "unit": { "denom": "uqor", "symbol": "QOR", "decimals": 6 },
  "history": {
    "fromHeight": 9000001,
    "fromTime": "2026-11-12T08:14:03.512Z",
    "source": "indexer_start",
    "indexedHeight": 9300000,
    "gap": null
  },
  "swapsCounted": 3,
  "totals": {
    "valueUqor": "300000000",
    "costBasisUqor": "200000000",
    "unrealizedPnlUqor": "100000000",
    "unrealizedPnlPercent": "50",
    "realizedPnlUqor": "50000000",
    "unpricedTokens": 0,
    "coverage": "complete"
  },
  "tokens": [
    {
      "denom": "erc20:0x97143b771d34ddb9130b807b135ae675a5a963ca",
      "symbol": "fUSD",
      "decimals": 6,
      "held": "200000000",
      "bought": "250000000",
      "sold": "50000000",
      "buys": 2,
      "sells": 1,
      "costBasisAmount": "200000000",
      "costBasisUqor": "200000000",
      "averageCostQor": "1",
      "unknownCostAmount": "0",
      "untrackedOutflowAmount": "0",
      "price": { "qorPerToken": "1.5", "poolId": "2", "source": "last_trade", "lowLiquidity": false },
      "valueUqor": "300000000",
      "unrealizedPnlUqor": "100000000",
      "unrealizedPnlPercent": "50",
      "realizedPnlUqor": "50000000",
      "realizedUnknownAmount": "0",
      "costCoverage": "complete",
      "dust": false
    }
  ]
}
```

  Units: token amounts (`held`, `bought`, `sold`, `*Amount`) are base-unit
  integer strings (divide by `10^decimals`); `*Uqor` are signed uqor integer
  strings (divide by `10^6` for QOR); `averageCostQor` and
  `price.qorPerToken` are QOR per whole token; `*Percent` are percent with 2
  decimals, truncated. `decimals` is `null` for an unknown token: its amounts
  are raw base units and it is unpriced.

  Method and edge cases:
  - Swaps are the wallet's indexed `amm_swap` events (any interface,
    `MsgSwapExactIn` and `MsgSwapExactOut` alike, by executed amounts),
    replayed oldest first. QOR is the unit of account and has no row.
  - A swap with QOR on one side costs or pays exactly its QOR side, even in a
    low-liquidity pool: those are the amounts that really changed hands. A
    swap between two other tokens is valued through the input token's QOR
    pool price at that time (the newer of that pool's last trade and reserve
    snapshot at or before the swap), else the output token's. That pool must
    not have been low liquidity at the time, judged on its last snapshot at or
    before the swap (no snapshot: not usable). With neither side usable, the
    bought side gets unknown cost and the sold side unknown proceeds.
  - A token's QOR pool is one pairing it with QOR that is not low liquidity
    (the markets page rule: unknown decimals, an empty or dust side, or TVL
    under 10 QOR), then the one holding the most QOR now. The current price is
    that pool's last trade, else its reserves (`price.source`), as on the
    markets page.
  - `price.lowLiquidity: true` means only low-liquidity QOR pools exist for
    the token. The price is returned for display only and is NOT used:
    `valueUqor`, `unrealizedPnlUqor` and `unrealizedPnlPercent` are `null`, the
    token is left out of every total and counts in `totals.unpricedTokens`.
    No QOR pool, or unknown decimals: `price` is `null`, same treatment.
  - Selling takes from the known-cost and unknown-cost parts of the position
    in proportion. Realized PnL is booked only on the known-cost part with
    known proceeds; the rest is `realizedUnknownAmount`, including units sold
    beyond the swap position (bought before indexed history, faucet,
    transfers, LP withdrawals).
  - Holdings are the live bank balance. Units held beyond the swap position
    are `unknownCostAmount`, never part of PnL. When less is held than the swap
    position (sent away, added to a pool, paid as the Qwakk fee), the held part
    keeps the average cost and the rest is `untrackedOutflowAmount`, not a sale.
  - `unrealizedPnlUqor` is value minus cost of `costBasisAmount` only. Totals
    sum priced tokens; `totals.unrealizedPnlPercent` is over
    `totals.costBasisUqor`.
  - `costCoverage` and `totals.coverage`: `complete` (every holding and sale
    has a known cost, and in totals every holding is priced), `partial`, or
    `none` (nothing with a known cost, including an empty wallet).
  - `history.fromHeight` is the first indexed block (`source`
    `indexer_start`), or on older databases the earliest stored event
    (`earliest_event`, a conservative bound). `fromTime` is the time of the
    earliest stored event. `gap` is a pruned range the indexer skipped.
    Activity outside indexed history shows up only as unknown cost.
  - The Qwakk interface fee is a separate bank transfer, not part of the swap
    event, and is not in the cost basis (0.10 percent of a Qwakk swap by
    default: a QOR fee on a buy is left out of the cost, a token fee on a sell
    shows as untracked outflow). The AMM's own fee is already inside the swap
    amounts.
  - `dust`: a held balance below one millionth of a token (at least 1000
    base units), the pools' dust rule. It is still counted.
- `GET /points/...`: only while `QWAKK_POINTS_ENABLED` is on.

## Rebuilding candles

When a token's decimals change, affected pools are listed in
`indexer_state.stale_candle_pools`. `rebuild-candles.ts` rebuilds their swap
prices and candles from raw swaps; see its header. It is never run automatically.
It refuses to run when `QWAKK_NETWORK` does not match the database's
`indexer_state.chain_id`, or when the database has no label and
`--assume-chain-id` is not given.

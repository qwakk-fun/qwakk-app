CREATE TABLE IF NOT EXISTS indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  denom TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  decimals INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pools (
  id BIGINT PRIMARY KEY,
  pool_type TEXT NOT NULL,
  creator TEXT,
  token_a TEXT NOT NULL,
  token_b TEXT NOT NULL,
  lp_denom TEXT,
  status TEXT NOT NULL,
  created_at_chain TIMESTAMPTZ,
  amplification_coefficient INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PoolView.created_at is the creation block height. Older databases created
-- the unused created_at_chain column; it is kept so the upgrade is additive.
ALTER TABLE pools ADD COLUMN IF NOT EXISTS created_height BIGINT;

CREATE TABLE IF NOT EXISTS pool_snapshots (
  id BIGSERIAL PRIMARY KEY,
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reserve_a NUMERIC NOT NULL,
  reserve_b NUMERIC NOT NULL,
  lp_supply NUMERIC NOT NULL,
  weighted_avg_price NUMERIC,
  UNIQUE (pool_id, observed_at)
);

CREATE INDEX IF NOT EXISTS pool_snapshots_pool_observed_idx ON pool_snapshots (pool_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS swaps (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  height BIGINT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  sender TEXT,
  denom_in TEXT NOT NULL,
  amount_in NUMERIC NOT NULL,
  denom_out TEXT NOT NULL,
  amount_out NUMERIC NOT NULL,
  price_b_per_a NUMERIC,
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS swaps_pool_executed_idx ON swaps (pool_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS candles (
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  interval TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume_qor NUMERIC,
  transactions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pool_id, interval, start_time)
);

CREATE INDEX IF NOT EXISTS candles_pool_interval_time_idx ON candles (pool_id, interval, start_time DESC);

-- Testnet points program. Raw tables keep what the chain said; derived
-- points_* tables are rebuilt from them on every scoring run, so the rules can
-- change and a whole season can be rescored. Every statement is additive.

-- amm_pool_created, amm_liquidity_added and amm_liquidity_removed events.
-- pool_id and the amounts are nullable because the closed AMM keeper does not
-- document which attributes each event carries; raw_event keeps all of them.
CREATE TABLE IF NOT EXISTS liquidity_events (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  pool_id BIGINT,
  height BIGINT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  sender TEXT,
  coins TEXT,
  qor_amount NUMERIC,
  lp_amount NUMERIC,
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS liquidity_events_pool_sender_idx ON liquidity_events (pool_id, sender, height);
CREATE INDEX IF NOT EXISTS liquidity_events_height_idx ON liquidity_events (height);

-- Hourly LP balance per (pool, address), read from the AMM LP balance query,
-- with the pool reserves and LP supply read in the same run.
CREATE TABLE IF NOT EXISTS lp_snapshots (
  id BIGSERIAL PRIMARY KEY,
  pool_id BIGINT NOT NULL,
  address TEXT NOT NULL,
  snapshot_hour TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  height BIGINT NOT NULL,
  lp_balance NUMERIC NOT NULL,
  lp_supply NUMERIC NOT NULL,
  reserve_a NUMERIC NOT NULL,
  reserve_b NUMERIC NOT NULL,
  UNIQUE (pool_id, address, snapshot_hour)
);

CREATE INDEX IF NOT EXISTS lp_snapshots_address_hour_idx ON lp_snapshots (address, pool_id, snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS lp_snapshots_height_idx ON lp_snapshots (height);

CREATE INDEX IF NOT EXISTS swaps_height_idx ON swaps (height);
CREATE INDEX IF NOT EXISTS swaps_sender_idx ON swaps (sender);

-- Derived. One row per season with the latest scoring run.
CREATE TABLE IF NOT EXISTS points_runs (
  season TEXT PRIMARY KEY,
  computed_at TIMESTAMPTZ NOT NULL,
  through_height BIGINT NOT NULL,
  config_hash TEXT NOT NULL,
  config JSONB NOT NULL,
  participants INTEGER NOT NULL
);

-- Derived. Points are exact decimals (6 places); volumes and values are uqor.
CREATE TABLE IF NOT EXISTS points_scores (
  season TEXT NOT NULL,
  address TEXT NOT NULL,
  rank INTEGER NOT NULL,
  total_points NUMERIC NOT NULL,
  swap_points NUMERIC NOT NULL,
  liquidity_points NUMERIC NOT NULL,
  pool_points NUMERIC NOT NULL,
  activity_points NUMERIC NOT NULL,
  active_days INTEGER NOT NULL,
  swap_volume_uqor NUMERIC NOT NULL,
  round_trip_volume_uqor NUMERIC NOT NULL,
  liquidity_uqor_hours NUMERIC NOT NULL,
  pools_created INTEGER NOT NULL,
  pools_unlocked INTEGER NOT NULL,
  first_height BIGINT NOT NULL,
  last_height BIGINT NOT NULL,
  PRIMARY KEY (season, address)
);

CREATE INDEX IF NOT EXISTS points_scores_rank_idx ON points_scores (season, rank);

CREATE TABLE IF NOT EXISTS points_daily (
  season TEXT NOT NULL,
  address TEXT NOT NULL,
  day DATE NOT NULL,
  swap_volume_uqor NUMERIC NOT NULL,
  round_trip_volume_uqor NUMERIC NOT NULL,
  swap_points NUMERIC NOT NULL,
  liquidity_points NUMERIC NOT NULL,
  active BOOLEAN NOT NULL,
  PRIMARY KEY (season, address, day)
);

CREATE TABLE IF NOT EXISTS points_pool_bonuses (
  season TEXT NOT NULL,
  pool_id BIGINT NOT NULL,
  creator TEXT NOT NULL,
  created_height BIGINT NOT NULL,
  distinct_traders INTEGER NOT NULL,
  status TEXT NOT NULL,
  unlocked_height BIGINT,
  points NUMERIC NOT NULL,
  PRIMARY KEY (season, pool_id)
);

CREATE INDEX IF NOT EXISTS points_pool_bonuses_creator_idx ON points_pool_bonuses (season, creator);

-- Volume in the pool's quote token (QOR, then fUSD, otherwise token B), display
-- units. Rows written before this column only have volume_qor, which is the
-- quote volume whenever it is set, so readers use COALESCE(volume_quote, volume_qor).
ALTER TABLE candles ADD COLUMN IF NOT EXISTS volume_quote NUMERIC;

-- Decimals are NULL when unknown: a token without a curated entry whose chain
-- metadata lists only the exponent 0 base unit, or no metadata at all. Market
-- math leaves such pools unpriced instead of guessing. Relaxing the constraint
-- changes no stored value and is safe to repeat.
ALTER TABLE tokens ALTER COLUMN decimals DROP NOT NULL;
ALTER TABLE tokens ALTER COLUMN decimals DROP DEFAULT;

-- Interface fee check per swap, for the points rule "only swaps made through
-- Qwakk count". sender_transfers holds every bank transfer the swap sender made
-- in the same transaction outside AMM messages (recipient, then denom, then
-- amount), such as Qwakk's interface fee MsgSend; {} when none. It does not
-- depend on any config, so the treasury list and minimum fee can change without
-- reading the chain again. fee_check_status is 'checked' once read,
-- 'unavailable' when the node no longer keeps the block, NULL until then. New
-- swaps are checked when their block is indexed; older in-season swaps by the
-- pass that runs before each scoring run. Adding nullable columns rewrites no row.
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS sender_transfers JSONB;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS fee_check_status TEXT;
CREATE INDEX IF NOT EXISTS swaps_fee_unchecked_idx ON swaps (height) WHERE fee_check_status IS NULL;

-- Derived, rebuilt on every scoring run: volume at or above the minimum size
-- that scored nothing, by reason.
ALTER TABLE points_scores ADD COLUMN IF NOT EXISTS not_on_qwakk_volume_uqor NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE points_scores ADD COLUMN IF NOT EXISTS extra_in_tx_volume_uqor NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE points_scores ADD COLUMN IF NOT EXISTS too_soon_volume_uqor NUMERIC NOT NULL DEFAULT 0;

-- Derived, rebuilt on every scoring run: addresses left off the leaderboard
-- as automated, with the signals that flagged them.
CREATE TABLE IF NOT EXISTS points_flags (
  season TEXT NOT NULL,
  address TEXT NOT NULL,
  reasons TEXT[] NOT NULL,
  PRIMARY KEY (season, address)
);

-- Liquidity rewards (indexer/rewards-*.ts). New tables only, nothing existing
-- is touched. Programs mirror QWAKK_REWARDS_PROGRAMS on every start. Epoch and
-- allocation rows are written only by indexer/rewards-cli.ts finalize, from
-- the raw lp_snapshots and liquidity_events, and are never rewritten once an
-- epoch is registered on chain. Amounts are base units of the reward denom.
CREATE TABLE IF NOT EXISTS reward_programs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  pool_id BIGINT NOT NULL,
  reward_denom TEXT NOT NULL,
  reward_symbol TEXT NOT NULL,
  reward_decimals INTEGER NOT NULL,
  epoch_budget NUMERIC NOT NULL,
  epoch_anchor TIMESTAMPTZ NOT NULL,
  epoch_seconds INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per finalized epoch. status: 'draft' (reserved), 'finalized' (tree
-- and proofs written, stage JSON handed to the contract CLI), 'registered'
-- (the owner registered the stage on chain). config freezes the exclusions and
-- holding rules used, so `rewards-cli verify` can recompute the same root.
CREATE TABLE IF NOT EXISTS reward_epochs (
  program_id TEXT NOT NULL REFERENCES reward_programs(id),
  epoch_number INTEGER NOT NULL,
  pool_id BIGINT NOT NULL,
  reward_denom TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  budget NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'finalized', 'registered')),
  contract_address TEXT,
  stage_id BIGINT,
  merkle_root TEXT,
  total_allocated NUMERIC,
  dust NUMERIC,
  recipients INTEGER,
  total_share_seconds NUMERIC,
  excluded_share_seconds NUMERIC,
  data_through_height BIGINT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Claim window registered with the stage (the contract's start and end).
  claim_starts_at TIMESTAMPTZ,
  claim_ends_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ,
  register_tx_hash TEXT,
  PRIMARY KEY (program_id, epoch_number)
);

-- A stage id is assigned by the contract, so it is unique per contract.
CREATE UNIQUE INDEX IF NOT EXISTS reward_epochs_stage_idx ON reward_epochs (COALESCE(contract_address, ''), stage_id) WHERE stage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reward_allocations (
  program_id TEXT NOT NULL,
  epoch_number INTEGER NOT NULL,
  address TEXT NOT NULL,
  share_seconds NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  leaf TEXT NOT NULL,
  proof TEXT[] NOT NULL,
  PRIMARY KEY (program_id, epoch_number, address),
  FOREIGN KEY (program_id, epoch_number) REFERENCES reward_epochs (program_id, epoch_number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reward_allocations_address_idx ON reward_allocations (address);

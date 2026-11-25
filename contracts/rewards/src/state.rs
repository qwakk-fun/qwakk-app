use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub pending_owner: Option<Addr>,
    /// The id of the last registered stage. Stages are numbered from 1.
    pub stage_count: u64,
}

#[cw_serde]
pub struct Stage {
    pub id: u64,
    pub denom: String,
    /// Lowercase hex.
    pub merkle_root: String,
    /// What the owner funded the stage with. Claims never pay out more.
    pub total: Uint128,
    pub claimed: Uint128,
    /// Unix seconds. Claims are open in [start, end).
    pub start: u64,
    pub end: u64,
    pub pool_id: u64,
    pub label: String,
    pub paused: bool,
    /// Set by Reclaim. A closed stage pays nothing more.
    pub closed: bool,
    /// What Reclaim returned to the owner.
    pub reclaimed: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const STAGES: Map<u64, Stage> = Map::new("stages");
/// (stage id, claimant) to the amount claimed.
pub const CLAIMS: Map<(u64, &Addr), Uint128> = Map::new("claims");

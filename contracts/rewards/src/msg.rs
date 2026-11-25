use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};

use crate::state::Stage;

#[cw_serde]
pub struct InstantiateMsg {
    pub owner: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Owner only. Must carry exactly `total` of `denom` and nothing else.
    /// `merkle_root` is 64 hex characters. `start` and `end` are Unix seconds;
    /// claims are open from `start` (inclusive) to `end` (exclusive).
    RegisterStage {
        denom: String,
        merkle_root: String,
        total: Uint128,
        start: u64,
        end: u64,
        pool_id: u64,
        label: String,
    },
    /// Pays `amount` of the stage denom to the sender. No funds may be attached.
    Claim {
        stage_id: u64,
        amount: Uint128,
        proof: Vec<String>,
    },
    /// Owner only, once the stage has ended: sends the unclaimed rest to the owner and closes the stage.
    Reclaim { stage_id: u64 },
    /// Owner only: stops claims on one stage until resumed.
    PauseStage { stage_id: u64 },
    ResumeStage { stage_id: u64 },
    /// Owner only: step one of an ownership transfer. Replaces any earlier proposal.
    ProposeOwner { new_owner: String },
    /// Owner only: drops a pending proposal.
    CancelOwnerProposal {},
    /// The proposed owner only: step two.
    AcceptOwner {},
}

#[cw_serde]
pub struct MigrateMsg {}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(Stage)]
    Stage { id: u64 },
    #[returns(StagesResponse)]
    Stages {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    #[returns(IsClaimedResponse)]
    IsClaimed { stage_id: u64, address: String },
}

#[cw_serde]
pub struct ConfigResponse {
    pub owner: Addr,
    pub pending_owner: Option<Addr>,
    pub stage_count: u64,
}

#[cw_serde]
pub struct StagesResponse {
    pub stages: Vec<Stage>,
}

#[cw_serde]
pub struct IsClaimedResponse {
    pub claimed: bool,
    /// What the address claimed from this stage, 0 when it has not.
    pub amount: Uint128,
}

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Order, Response, StdResult, Uint128,
};
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::merkle::{leaf_hash, parse_hash, verify};
use crate::msg::{ConfigResponse, ExecuteMsg, InstantiateMsg, IsClaimedResponse, MigrateMsg, QueryMsg, StagesResponse};
use crate::state::{Config, Stage, CLAIMS, CONFIG, STAGES};

pub const CONTRACT_NAME: &str = "crates.io:qwakk-rewards";
pub const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_DENOM_LEN: usize = 128;
/// A proof of 64 hashes covers any tree that could ever be built.
pub const MAX_PROOF_LEN: usize = 64;
pub const DEFAULT_PAGE: u32 = 10;
pub const MAX_PAGE: u32 = 30;

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(deps: DepsMut, _env: Env, info: MessageInfo, msg: InstantiateMsg) -> Result<Response, ContractError> {
    if !info.funds.is_empty() {
        return Err(ContractError::FundsNotAllowed);
    }
    let owner = deps.api.addr_validate(&msg.owner)?;
    cw2::set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    CONFIG.save(deps.storage, &Config { owner: owner.clone(), pending_owner: None, stage_count: 0 })?;
    Ok(Response::new().add_attribute("action", "instantiate").add_attribute("owner", owner))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    if !matches!(msg, ExecuteMsg::RegisterStage { .. }) && !info.funds.is_empty() {
        return Err(ContractError::FundsNotAllowed);
    }
    match msg {
        ExecuteMsg::RegisterStage { denom, merkle_root, total, start, end, pool_id, label } => {
            register_stage(deps, env, info, denom, merkle_root, total, start, end, pool_id, label)
        }
        ExecuteMsg::Claim { stage_id, amount, proof } => claim(deps, env, info, stage_id, amount, proof),
        ExecuteMsg::Reclaim { stage_id } => reclaim(deps, env, info, stage_id),
        ExecuteMsg::PauseStage { stage_id } => set_paused(deps, info, stage_id, true),
        ExecuteMsg::ResumeStage { stage_id } => set_paused(deps, info, stage_id, false),
        ExecuteMsg::ProposeOwner { new_owner } => {
            let mut config = owner_config(deps.as_ref(), &info)?;
            let proposed = deps.api.addr_validate(&new_owner)?;
            config.pending_owner = Some(proposed.clone());
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new().add_attribute("action", "propose_owner").add_attribute("pending_owner", proposed))
        }
        ExecuteMsg::CancelOwnerProposal {} => {
            let mut config = owner_config(deps.as_ref(), &info)?;
            if config.pending_owner.take().is_none() {
                return Err(ContractError::NoPendingOwner);
            }
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new().add_attribute("action", "cancel_owner_proposal"))
        }
        ExecuteMsg::AcceptOwner {} => {
            let mut config = CONFIG.load(deps.storage)?;
            match &config.pending_owner {
                None => return Err(ContractError::NoPendingOwner),
                Some(pending) if *pending != info.sender => return Err(ContractError::Unauthorized),
                Some(_) => {}
            }
            config.owner = info.sender.clone();
            config.pending_owner = None;
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new().add_attribute("action", "accept_owner").add_attribute("owner", info.sender))
        }
    }
}

fn owner_config(deps: Deps, info: &MessageInfo) -> Result<Config, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized);
    }
    Ok(config)
}

#[allow(clippy::too_many_arguments)]
fn register_stage(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    denom: String,
    merkle_root: String,
    total: Uint128,
    start: u64,
    end: u64,
    pool_id: u64,
    label: String,
) -> Result<Response, ContractError> {
    let mut config = owner_config(deps.as_ref(), &info)?;
    if denom.is_empty() || denom.len() > MAX_DENOM_LEN {
        return Err(ContractError::InvalidStage("denom"));
    }
    let root = parse_hash(&merkle_root).ok_or(ContractError::InvalidStage("merkle_root"))?;
    if total.is_zero() {
        return Err(ContractError::InvalidStage("total"));
    }
    if end <= start || end <= env.block.time.seconds() {
        return Err(ContractError::InvalidStage("end"));
    }
    if label.len() > MAX_LABEL_LEN {
        return Err(ContractError::InvalidStage("label"));
    }
    // Exactly one coin: the stage denom, the stage total.
    if info.funds.len() != 1 || info.funds[0].denom != denom || info.funds[0].amount != total {
        return Err(ContractError::WrongFunding);
    }

    config.stage_count += 1;
    let stage = Stage {
        id: config.stage_count,
        denom,
        merkle_root: hex::encode(root),
        total,
        claimed: Uint128::zero(),
        start,
        end,
        pool_id,
        label,
        paused: false,
        closed: false,
        reclaimed: Uint128::zero(),
    };
    STAGES.save(deps.storage, stage.id, &stage)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "register_stage")
        .add_attribute("stage_id", stage.id.to_string())
        .add_attribute("denom", stage.denom)
        .add_attribute("total", stage.total)
        .add_attribute("merkle_root", stage.merkle_root)
        .add_attribute("start", stage.start.to_string())
        .add_attribute("end", stage.end.to_string())
        .add_attribute("pool_id", stage.pool_id.to_string()))
}

fn claim(deps: DepsMut, env: Env, info: MessageInfo, stage_id: u64, amount: Uint128, proof: Vec<String>) -> Result<Response, ContractError> {
    let mut stage = STAGES.may_load(deps.storage, stage_id)?.ok_or(ContractError::StageNotFound)?;
    if stage.closed {
        return Err(ContractError::Closed);
    }
    if stage.paused {
        return Err(ContractError::Paused);
    }
    let now = env.block.time.seconds();
    if now < stage.start {
        return Err(ContractError::NotStarted);
    }
    if now >= stage.end {
        return Err(ContractError::Ended);
    }
    if CLAIMS.has(deps.storage, (stage_id, &info.sender)) {
        return Err(ContractError::AlreadyClaimed);
    }
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount);
    }
    if proof.len() > MAX_PROOF_LEN {
        return Err(ContractError::InvalidProof);
    }
    let proof = proof.iter().map(|p| parse_hash(p)).collect::<Option<Vec<_>>>().ok_or(ContractError::InvalidProof)?;
    let root = parse_hash(&stage.merkle_root).ok_or(ContractError::InvalidProof)?;
    let leaf = leaf_hash(stage_id, info.sender.as_str(), amount.u128()).ok_or(ContractError::InvalidProof)?;
    if !verify(leaf, &proof, &root) {
        return Err(ContractError::InvalidProof);
    }
    // Per-stage accounting: a stage never pays out more than it was funded with.
    let claimed = stage.claimed.checked_add(amount).map_err(|_| ContractError::StageExhausted)?;
    if claimed > stage.total {
        return Err(ContractError::StageExhausted);
    }
    stage.claimed = claimed;
    STAGES.save(deps.storage, stage_id, &stage)?;
    CLAIMS.save(deps.storage, (stage_id, &info.sender), &amount)?;

    Ok(Response::new()
        .add_message(BankMsg::Send { to_address: info.sender.to_string(), amount: vec![Coin { denom: stage.denom.clone(), amount }] })
        .add_attribute("action", "claim")
        .add_attribute("stage_id", stage_id.to_string())
        .add_attribute("recipient", info.sender)
        .add_attribute("denom", stage.denom)
        .add_attribute("amount", amount))
}

fn reclaim(deps: DepsMut, env: Env, info: MessageInfo, stage_id: u64) -> Result<Response, ContractError> {
    let config = owner_config(deps.as_ref(), &info)?;
    let mut stage = STAGES.may_load(deps.storage, stage_id)?.ok_or(ContractError::StageNotFound)?;
    if stage.closed {
        return Err(ContractError::Closed);
    }
    if env.block.time.seconds() < stage.end {
        return Err(ContractError::StillRunning);
    }
    let rest = stage.total.checked_sub(stage.claimed).map_err(cosmwasm_std::StdError::from)?;
    stage.closed = true;
    stage.reclaimed = rest;
    STAGES.save(deps.storage, stage_id, &stage)?;

    let mut response = Response::new()
        .add_attribute("action", "reclaim")
        .add_attribute("stage_id", stage_id.to_string())
        .add_attribute("amount", rest);
    if !rest.is_zero() {
        response = response.add_message(BankMsg::Send { to_address: config.owner.to_string(), amount: vec![Coin { denom: stage.denom, amount: rest }] });
    }
    Ok(response)
}

fn set_paused(deps: DepsMut, info: MessageInfo, stage_id: u64, paused: bool) -> Result<Response, ContractError> {
    owner_config(deps.as_ref(), &info)?;
    let mut stage = STAGES.may_load(deps.storage, stage_id)?.ok_or(ContractError::StageNotFound)?;
    if stage.closed {
        return Err(ContractError::Closed);
    }
    stage.paused = paused;
    STAGES.save(deps.storage, stage_id, &stage)?;
    Ok(Response::new()
        .add_attribute("action", if paused { "pause_stage" } else { "resume_stage" })
        .add_attribute("stage_id", stage_id.to_string()))
}

/// Upgrades in place. Only the wasm admin can call it (the chain enforces that).
/// Refuses another contract's state and any downgrade; keeps all state.
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn migrate(deps: DepsMut, _env: Env, _msg: MigrateMsg) -> Result<Response, ContractError> {
    let previous = cw2::ensure_from_older_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)
        .map_err(|e| ContractError::Migration(e.to_string()))?;
    Ok(Response::new()
        .add_attribute("action", "migrate")
        .add_attribute("from_version", previous.to_string())
        .add_attribute("to_version", CONTRACT_VERSION))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => {
            let config = CONFIG.load(deps.storage)?;
            to_json_binary(&ConfigResponse { owner: config.owner, pending_owner: config.pending_owner, stage_count: config.stage_count })
        }
        QueryMsg::Stage { id } => to_json_binary(&STAGES.load(deps.storage, id)?),
        QueryMsg::Stages { start_after, limit } => {
            let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE) as usize;
            let stages = STAGES
                .range(deps.storage, start_after.map(Bound::exclusive), None, Order::Ascending)
                .take(limit)
                .map(|item| item.map(|(_, stage)| stage))
                .collect::<StdResult<Vec<_>>>()?;
            to_json_binary(&StagesResponse { stages })
        }
        QueryMsg::IsClaimed { stage_id, address } => {
            let address: Addr = deps.api.addr_validate(&address)?;
            let amount = CLAIMS.may_load(deps.storage, (stage_id, &address))?;
            to_json_binary(&IsClaimedResponse { claimed: amount.is_some(), amount: amount.unwrap_or_default() })
        }
    }
}

use cosmwasm_std::{coin, coins, to_json_binary, Addr, Binary, Coin, Deps, DepsMut, Empty, Env, MessageInfo, Response, StdResult, Timestamp, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor, MockApiBech32};
use serde::Deserialize;

use qwakk_rewards::contract::{execute, instantiate, migrate, query, CONTRACT_NAME, CONTRACT_VERSION};
use qwakk_rewards::merkle::{leaf_hash, node_hash, parse_hash, verify, Hash};
use qwakk_rewards::msg::{ConfigResponse, ExecuteMsg, InstantiateMsg, IsClaimedResponse, MigrateMsg, QueryMsg, StagesResponse};
use qwakk_rewards::state::Stage;

/// QWAKK's bank denom on Diana (x/erc20 pair of 0xa5b3...eE23).
const QWAKK: &str = "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";
const OTHER: &str = "uother";
const T0: u64 = 1_800_000_000;
const WEEK: u64 = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// The shared test vector (testdata/vector.json, made by testdata/vector.py)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Vector {
    stage: u64,
    root: String,
    claims: Vec<VectorClaim>,
}

#[derive(Deserialize)]
struct VectorClaim {
    address: String,
    amount: String,
    leaf: String,
    proof: Vec<String>,
}

fn vector() -> Vector {
    cosmwasm_std::from_json(include_str!("../testdata/vector.json")).unwrap()
}

/// The reference tree, written from the spec (and vector.py), independent of the contract's verifier.
fn build_tree(mut leaves: Vec<Hash>) -> Vec<Vec<Hash>> {
    leaves.sort();
    let mut levels = vec![leaves];
    while levels.last().unwrap().len() > 1 {
        let current = levels.last().unwrap();
        let next = current.chunks(2).map(|pair| if pair.len() == 2 { node_hash(&pair[0], &pair[1]) } else { pair[0] }).collect();
        levels.push(next);
    }
    levels
}

fn proof_for(levels: &[Vec<Hash>], leaf: &Hash) -> Vec<String> {
    let mut index = levels[0].iter().position(|l| l == leaf).unwrap();
    let mut proof = vec![];
    for level in &levels[..levels.len() - 1] {
        let sibling = index ^ 1;
        if sibling < level.len() {
            proof.push(hex::encode(level[sibling]));
        }
        index /= 2;
    }
    proof
}

/// Root and per-address proofs for a stage.
fn tree(stage_id: u64, entries: &[(&Addr, u128)]) -> (String, Vec<Vec<String>>) {
    let leaves: Vec<Hash> = entries.iter().map(|(a, m)| leaf_hash(stage_id, a.as_str(), *m).unwrap()).collect();
    let levels = build_tree(leaves.clone());
    let root = hex::encode(levels.last().unwrap()[0]);
    (root, leaves.iter().map(|l| proof_for(&levels, l)).collect())
}

#[test]
fn shared_vector_matches_contract_encoding() {
    let v = vector();
    assert_eq!(v.root, "a546da3d30ca80c9abe13be629e99630e0baac67f8a8ac1616c347d044eeacac");
    let root = parse_hash(&v.root).unwrap();
    let mut leaves = vec![];
    for c in &v.claims {
        let leaf = leaf_hash(v.stage, &c.address, c.amount.parse().unwrap()).unwrap();
        assert_eq!(hex::encode(leaf), c.leaf, "leaf of {}", c.address);
        let proof: Vec<Hash> = c.proof.iter().map(|p| parse_hash(p).unwrap()).collect();
        assert!(verify(leaf, &proof, &root), "proof of {}", c.address);
        // Bound to the stage id and the amount.
        assert!(!verify(leaf_hash(v.stage + 1, &c.address, c.amount.parse().unwrap()).unwrap(), &proof, &root));
        assert!(!verify(leaf_hash(v.stage, &c.address, c.amount.parse::<u128>().unwrap() + 1).unwrap(), &proof, &root));
        leaves.push(leaf);
    }
    let levels = build_tree(leaves);
    assert_eq!(hex::encode(levels.last().unwrap()[0]), v.root);
    for c in &v.claims {
        assert_eq!(proof_for(&levels, &parse_hash(&c.leaf).unwrap()), c.proof);
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn rewards_contract() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(execute, instantiate, query).with_migrate(migrate))
}

struct Suite {
    app: App<cw_multi_test::BankKeeper, MockApiBech32>,
    code_id: u64,
    contract: Addr,
    owner: Addr,
}

fn suite() -> Suite {
    let api = MockApiBech32::new("qor");
    let owner = api.addr_make("owner");
    let funded = owner.clone();
    let mut app = AppBuilder::new().with_api(api).build(|router, _api, storage| {
        router.bank.init_balance(storage, &funded, vec![coin(1_000_000_000_000, QWAKK), coin(1_000_000_000, OTHER), coin(1_000_000_000, "uqor")]).unwrap();
    });
    app.update_block(|b| b.time = Timestamp::from_seconds(T0));
    let code_id = app.store_code(rewards_contract());
    let contract = app
        .instantiate_contract(code_id, owner.clone(), &InstantiateMsg { owner: owner.to_string() }, &[], "qwakk-rewards", Some(owner.to_string()))
        .unwrap();
    Suite { app, code_id, contract, owner }
}

impl Suite {
    fn addr(&self, name: &str) -> Addr {
        self.app.api().addr_make(name)
    }

    fn set_time(&mut self, seconds: u64) {
        self.app.update_block(|b| b.time = Timestamp::from_seconds(seconds));
    }

    fn register(&mut self, root: &str, total: u128, start: u64, end: u64, funds: &[Coin]) -> anyhow_like::Result {
        let msg = ExecuteMsg::RegisterStage { denom: QWAKK.into(), merkle_root: root.into(), total: Uint128::new(total), start, end, pool_id: 7, label: "week 1".into() };
        self.app.execute_contract(self.owner.clone(), self.contract.clone(), &msg, funds).map(|_| ()).map_err(|e| e.root_cause().to_string())
    }

    fn register_ok(&mut self, root: &str, total: u128) -> u64 {
        self.register(root, total, T0, T0 + WEEK, &coins(total, QWAKK)).unwrap();
        self.config().stage_count
    }

    fn exec(&mut self, sender: &Addr, msg: ExecuteMsg, funds: &[Coin]) -> anyhow_like::Result {
        self.app.execute_contract(sender.clone(), self.contract.clone(), &msg, funds).map(|_| ()).map_err(|e| e.root_cause().to_string())
    }

    fn claim(&mut self, sender: &Addr, stage_id: u64, amount: u128, proof: &[String]) -> anyhow_like::Result {
        self.exec(sender, ExecuteMsg::Claim { stage_id, amount: Uint128::new(amount), proof: proof.to_vec() }, &[])
    }

    fn balance(&self, who: &Addr, denom: &str) -> u128 {
        self.app.wrap().query_balance(who, denom).unwrap().amount.u128()
    }

    fn config(&self) -> ConfigResponse {
        self.app.wrap().query_wasm_smart(&self.contract, &QueryMsg::Config {}).unwrap()
    }

    fn stage(&self, id: u64) -> Stage {
        self.app.wrap().query_wasm_smart(&self.contract, &QueryMsg::Stage { id }).unwrap()
    }

    fn is_claimed(&self, stage_id: u64, who: &Addr) -> IsClaimedResponse {
        self.app.wrap().query_wasm_smart(&self.contract, &QueryMsg::IsClaimed { stage_id, address: who.to_string() }).unwrap()
    }
}

mod anyhow_like {
    pub type Result = std::result::Result<(), String>;
}

fn assert_err(result: anyhow_like::Result, needle: &str) {
    match result {
        Ok(()) => panic!("expected an error containing {needle:?}"),
        Err(text) => assert!(text.contains(needle), "{text:?} does not contain {needle:?}"),
    }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

#[test]
fn happy_claims_with_shared_vector() {
    let mut s = suite();
    let v = vector();
    let total: u128 = v.claims.iter().map(|c| c.amount.parse::<u128>().unwrap()).sum();
    assert_eq!(s.register_ok(&v.root, total), v.stage);
    for c in &v.claims {
        let who = Addr::unchecked(&c.address);
        let amount: u128 = c.amount.parse().unwrap();
        assert!(!s.is_claimed(1, &who).claimed);
        s.claim(&who, 1, amount, &c.proof).unwrap();
        assert_eq!(s.balance(&who, QWAKK), amount);
        assert_eq!(s.is_claimed(1, &who), IsClaimedResponse { claimed: true, amount: Uint128::new(amount) });
    }
    let stage = s.stage(1);
    assert_eq!(stage.claimed.u128(), total);
    assert_eq!(s.balance(&s.contract.clone(), QWAKK), 0);
}

#[test]
fn double_claim_is_refused() {
    let mut s = suite();
    let v = vector();
    s.register_ok(&v.root, 3_500_007);
    let c = &v.claims[0];
    let who = Addr::unchecked(&c.address);
    s.claim(&who, 1, 1_000_000, &c.proof).unwrap();
    assert_err(s.claim(&who, 1, 1_000_000, &c.proof), "already claimed");
    assert_eq!(s.balance(&who, QWAKK), 1_000_000);
}

#[test]
fn wrong_proof_amount_or_sender_is_refused() {
    let mut s = suite();
    let v = vector();
    s.register_ok(&v.root, 3_500_007);
    let a = Addr::unchecked(&v.claims[0].address);
    // Someone else's proof.
    assert_err(s.claim(&a, 1, 1_000_000, &v.claims[2].proof), "invalid proof");
    // Wrong amount with the right proof.
    assert_err(s.claim(&a, 1, 1_000_001, &v.claims[0].proof), "invalid proof");
    assert_err(s.claim(&a, 1, 999_999, &v.claims[0].proof), "invalid proof");
    // Not hex, wrong length, empty, too long.
    assert_err(s.claim(&a, 1, 1_000_000, &["zz".repeat(32)]), "invalid proof");
    assert_err(s.claim(&a, 1, 1_000_000, &["00".into()]), "invalid proof");
    assert_err(s.claim(&a, 1, 1_000_000, &[]), "invalid proof");
    assert_err(s.claim(&a, 1, 1_000_000, &vec!["00".repeat(32); 65]), "invalid proof");
    // Another address using a's proof and amount.
    let thief = s.addr("thief");
    assert_err(s.claim(&thief, 1, 1_000_000, &v.claims[0].proof), "invalid proof");
    // Zero amount, unknown stage.
    assert_err(s.claim(&a, 1, 0, &v.claims[0].proof), "amount must be positive");
    assert_err(s.claim(&a, 9, 1_000_000, &v.claims[0].proof), "stage not found");
    // Upper-case proof hex is the same proof.
    let upper: Vec<String> = v.claims[0].proof.iter().map(|p| p.to_uppercase()).collect();
    s.claim(&a, 1, 1_000_000, &upper).unwrap();
}

#[test]
fn claim_refuses_attached_funds() {
    let mut s = suite();
    let v = vector();
    s.register_ok(&v.root, 3_500_007);
    let owner = s.owner.clone();
    let msg = ExecuteMsg::Claim { stage_id: 1, amount: Uint128::new(1), proof: vec![] };
    assert_err(s.exec(&owner, msg, &coins(1, "uqor")), "no funds may be attached");
}

#[test]
fn a_bad_root_cannot_touch_another_stage() {
    let mut s = suite();
    let a = s.addr("a");
    let b = s.addr("b");
    // Stage 1: the tree promises 100 + 100, but only 150 was funded.
    let (root1, proofs1) = tree(1, &[(&a, 100), (&b, 100)]);
    assert_eq!(s.register_ok(&root1, 150), 1);
    // Stage 2: same denom, funded properly.
    let (root2, proofs2) = tree(2, &[(&a, 400), (&b, 600)]);
    assert_eq!(s.register_ok(&root2, 1_000), 2);
    assert_eq!(s.balance(&s.contract.clone(), QWAKK), 1_150);

    s.claim(&a, 1, 100, &proofs1[0]).unwrap();
    assert_err(s.claim(&b, 1, 100, &proofs1[1]), "stage total exceeded");
    // Stage 2 is untouched and pays in full.
    assert_eq!(s.balance(&s.contract.clone(), QWAKK), 1_050);
    s.claim(&a, 2, 400, &proofs2[0]).unwrap();
    s.claim(&b, 2, 600, &proofs2[1]).unwrap();
    assert_eq!(s.balance(&s.contract.clone(), QWAKK), 50);
    // A stage-1 proof does not work on stage 2 (leaves bind the stage id).
    let c = s.addr("c");
    let (root3, proofs3) = tree(1, &[(&c, 10), (&a, 1)]);
    assert_eq!(s.register_ok(&root3, 11), 3);
    assert_err(s.claim(&c, 3, 10, &proofs3[0]), "invalid proof");
}

#[test]
fn claim_window_is_start_inclusive_end_exclusive() {
    let mut s = suite();
    let a = s.addr("a");
    let b = s.addr("b");
    let (root, proofs) = tree(1, &[(&a, 5), (&b, 6)]);
    s.register(&root, 11, T0 + 100, T0 + 200, &coins(11, QWAKK)).unwrap();
    assert_err(s.claim(&a, 1, 5, &proofs[0]), "claim window not open");
    s.set_time(T0 + 100);
    s.claim(&a, 1, 5, &proofs[0]).unwrap();
    s.set_time(T0 + 200);
    assert_err(s.claim(&b, 1, 6, &proofs[1]), "claim window ended");
    s.set_time(T0 + 10_000);
    assert_err(s.claim(&b, 1, 6, &proofs[1]), "claim window ended");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

#[test]
fn register_requires_exact_funding_and_valid_fields() {
    let mut s = suite();
    let root = vector().root;
    let end = T0 + WEEK;
    assert_err(s.register(&root, 100, T0, end, &[]), "attach exactly the stage total");
    assert_err(s.register(&root, 100, T0, end, &coins(99, QWAKK)), "attach exactly the stage total");
    assert_err(s.register(&root, 100, T0, end, &coins(101, QWAKK)), "attach exactly the stage total");
    assert_err(s.register(&root, 100, T0, end, &coins(100, OTHER)), "attach exactly the stage total");
    assert_err(s.register(&root, 100, T0, end, &[coin(100, QWAKK), coin(1, "uqor")]), "attach exactly the stage total");
    assert_err(s.register(&root, 0, T0, end, &[]), "invalid stage: total");
    assert_err(s.register("abcd", 100, T0, end, &coins(100, QWAKK)), "invalid stage: merkle_root");
    assert_err(s.register(&"x".repeat(64), 100, T0, end, &coins(100, QWAKK)), "invalid stage: merkle_root");
    assert_err(s.register(&root, 100, T0, T0, &coins(100, QWAKK)), "invalid stage: end");
    assert_err(s.register(&root, 100, T0 - 20, T0 - 10, &coins(100, QWAKK)), "invalid stage: end");
    // Nothing was stored and nothing kept.
    assert_eq!(s.config().stage_count, 0);
    assert_eq!(s.balance(&s.contract.clone(), QWAKK), 0);

    let stranger = s.addr("stranger");
    let msg = ExecuteMsg::RegisterStage { denom: QWAKK.into(), merkle_root: root.clone(), total: Uint128::new(1), start: T0, end, pool_id: 1, label: String::new() };
    s.app.send_tokens(s.owner.clone(), stranger.clone(), &coins(1, QWAKK)).unwrap();
    assert_err(s.exec(&stranger, msg, &coins(1, QWAKK)), "unauthorized");

    let long = ExecuteMsg::RegisterStage { denom: QWAKK.into(), merkle_root: root.clone(), total: Uint128::new(1), start: T0, end, pool_id: 1, label: "l".repeat(129) };
    let owner = s.owner.clone();
    assert_err(s.exec(&owner, long, &coins(1, QWAKK)), "invalid stage: label");

    // Ids count up from 1; the root is stored lowercase.
    assert_eq!(s.register_ok(&root.to_uppercase(), 10), 1);
    assert_eq!(s.register_ok(&root, 20), 2);
    let stage = s.stage(1);
    assert_eq!(stage.merkle_root, root);
    assert_eq!((stage.total.u128(), stage.pool_id, stage.start, stage.end), (10, 7, T0, end));
    let page: StagesResponse = s.app.wrap().query_wasm_smart(&s.contract, &QueryMsg::Stages { start_after: Some(1), limit: None }).unwrap();
    assert_eq!(page.stages.iter().map(|st| st.id).collect::<Vec<_>>(), vec![2]);
}

// ---------------------------------------------------------------------------
// Reclaim
// ---------------------------------------------------------------------------

#[test]
fn reclaim_is_owner_only_after_end_and_once() {
    let mut s = suite();
    let a = s.addr("a");
    let b = s.addr("b");
    let (root, proofs) = tree(1, &[(&a, 30), (&b, 70)]);
    s.register_ok(&root, 100);
    s.claim(&a, 1, 30, &proofs[0]).unwrap();
    let owner = s.owner.clone();
    let before = s.balance(&owner, QWAKK);

    assert_err(s.exec(&owner, ExecuteMsg::Reclaim { stage_id: 1 }, &[]), "stage still running");
    s.set_time(T0 + WEEK);
    assert_err(s.exec(&a, ExecuteMsg::Reclaim { stage_id: 1 }, &[]), "unauthorized");
    s.exec(&owner, ExecuteMsg::Reclaim { stage_id: 1 }, &[]).unwrap();
    assert_eq!(s.balance(&owner, QWAKK), before + 70);
    let stage = s.stage(1);
    assert!(stage.closed);
    assert_eq!(stage.reclaimed.u128(), 70);
    assert_err(s.exec(&owner, ExecuteMsg::Reclaim { stage_id: 1 }, &[]), "stage closed");
    assert_err(s.claim(&b, 1, 70, &proofs[1]), "stage closed");
    assert_err(s.exec(&owner, ExecuteMsg::PauseStage { stage_id: 1 }, &[]), "stage closed");
}

#[test]
fn reclaim_of_a_fully_claimed_stage_sends_nothing() {
    let mut s = suite();
    let a = s.addr("a");
    let (root, proofs) = tree(1, &[(&a, 30)]);
    assert!(proofs[0].is_empty());
    s.register_ok(&root, 30);
    s.claim(&a, 1, 30, &proofs[0]).unwrap();
    s.set_time(T0 + WEEK);
    let owner = s.owner.clone();
    s.exec(&owner, ExecuteMsg::Reclaim { stage_id: 1 }, &[]).unwrap();
    assert_eq!(s.stage(1).reclaimed.u128(), 0);
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_claims_until_resumed() {
    let mut s = suite();
    let a = s.addr("a");
    let (root, proofs) = tree(1, &[(&a, 5)]);
    s.register_ok(&root, 5);
    let owner = s.owner.clone();
    assert_err(s.exec(&a, ExecuteMsg::PauseStage { stage_id: 1 }, &[]), "unauthorized");
    s.exec(&owner, ExecuteMsg::PauseStage { stage_id: 1 }, &[]).unwrap();
    assert_err(s.claim(&a, 1, 5, &proofs[0]), "stage paused");
    assert_err(s.exec(&a, ExecuteMsg::ResumeStage { stage_id: 1 }, &[]), "unauthorized");
    s.exec(&owner, ExecuteMsg::ResumeStage { stage_id: 1 }, &[]).unwrap();
    s.claim(&a, 1, 5, &proofs[0]).unwrap();
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

#[test]
fn two_step_ownership_transfer() {
    let mut s = suite();
    let owner = s.owner.clone();
    let next = s.addr("next");
    let other = s.addr("other");
    assert_err(s.exec(&next, ExecuteMsg::ProposeOwner { new_owner: next.to_string() }, &[]), "unauthorized");
    assert_err(s.exec(&next, ExecuteMsg::AcceptOwner {}, &[]), "no pending owner");
    assert_err(s.exec(&owner, ExecuteMsg::ProposeOwner { new_owner: "not-an-address".into() }, &[]), "");
    assert_err(s.exec(&owner, ExecuteMsg::CancelOwnerProposal {}, &[]), "no pending owner");

    s.exec(&owner, ExecuteMsg::ProposeOwner { new_owner: other.to_string() }, &[]).unwrap();
    s.exec(&owner, ExecuteMsg::CancelOwnerProposal {}, &[]).unwrap();
    assert_err(s.exec(&other, ExecuteMsg::AcceptOwner {}, &[]), "no pending owner");

    s.exec(&owner, ExecuteMsg::ProposeOwner { new_owner: next.to_string() }, &[]).unwrap();
    assert_eq!(s.config().pending_owner, Some(next.clone()));
    assert_eq!(s.config().owner, owner);
    assert_err(s.exec(&other, ExecuteMsg::AcceptOwner {}, &[]), "unauthorized");
    s.exec(&next, ExecuteMsg::AcceptOwner {}, &[]).unwrap();
    let config = s.config();
    assert_eq!((config.owner, config.pending_owner), (next.clone(), None));

    // The old owner lost its rights; the new one has them.
    let root = vector().root;
    assert_err(s.register(&root, 1, T0, T0 + WEEK, &coins(1, QWAKK)), "unauthorized");
    s.app.send_tokens(owner, next.clone(), &coins(1, QWAKK)).unwrap();
    let msg = ExecuteMsg::RegisterStage { denom: QWAKK.into(), merkle_root: root, total: Uint128::new(1), start: T0, end: T0 + WEEK, pool_id: 1, label: String::new() };
    s.exec(&next, msg, &coins(1, QWAKK)).unwrap();
}

#[test]
fn instantiate_refuses_funds_and_bad_owner() {
    let mut s = suite();
    let owner = s.owner.clone();
    let code = s.code_id;
    let funded = s.app.instantiate_contract(code, owner.clone(), &InstantiateMsg { owner: owner.to_string() }, &coins(1, "uqor"), "x", None);
    assert!(funded.unwrap_err().root_cause().to_string().contains("no funds may be attached"));
    assert!(s.app.instantiate_contract(code, owner, &InstantiateMsg { owner: "nope".into() }, &[], "x", None).is_err());
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

fn fake_newer(deps: DepsMut, _: Env, _: MessageInfo, _: Empty) -> StdResult<Response> {
    cw2::set_contract_version(deps.storage, CONTRACT_NAME, "9.9.9")?;
    Ok(Response::new())
}

fn fake_foreign(deps: DepsMut, _: Env, _: MessageInfo, _: Empty) -> StdResult<Response> {
    cw2::set_contract_version(deps.storage, "crates.io:something-else", "0.0.1")?;
    Ok(Response::new())
}

fn noop_execute(_: DepsMut, _: Env, _: MessageInfo, _: Empty) -> StdResult<Response> {
    Ok(Response::new())
}

fn noop_query(_: Deps, _: Env, _: Empty) -> StdResult<Binary> {
    to_json_binary(&())
}

#[test]
fn migrate_keeps_state_and_is_admin_only() {
    let mut s = suite();
    let a = s.addr("a");
    let b = s.addr("b");
    let (root, proofs) = tree(1, &[(&a, 5), (&b, 6)]);
    s.register_ok(&root, 11);
    s.claim(&a, 1, 5, &proofs[0]).unwrap();

    let new_code = s.app.store_code(rewards_contract());
    let contract = s.contract.clone();
    assert!(s.app.migrate_contract(a.clone(), contract.clone(), &MigrateMsg {}, new_code).is_err());
    s.app.migrate_contract(s.owner.clone(), contract.clone(), &MigrateMsg {}, new_code).unwrap();
    assert_eq!(s.app.wrap().query_wasm_contract_info(&contract).unwrap().code_id, new_code);
    let version = cw2::query_contract_info(&s.app.wrap(), &contract).unwrap();
    assert_eq!((version.contract.as_str(), version.version.as_str()), (CONTRACT_NAME, CONTRACT_VERSION));

    // State survived: a's claim, the stage, the owner.
    assert!(s.is_claimed(1, &a).claimed);
    assert_eq!(s.stage(1).claimed.u128(), 5);
    assert_eq!(s.config().owner, s.owner);
    assert_err(s.claim(&a, 1, 5, &proofs[0]), "already claimed");
    s.claim(&b, 1, 6, &proofs[1]).unwrap();
}

#[test]
fn migrate_refuses_downgrade_and_foreign_state() {
    let mut s = suite();
    let owner = s.owner.clone();
    let rewards = s.code_id;
    type InstantiateFn = fn(DepsMut, Env, MessageInfo, Empty) -> StdResult<Response>;
    for (label, init) in [("newer version", fake_newer as InstantiateFn), ("another contract", fake_foreign as InstantiateFn)] {
        let fake = s.app.store_code(Box::new(ContractWrapper::new(noop_execute, init, noop_query)));
        let addr = s.app.instantiate_contract(fake, owner.clone(), &Empty {}, &[], "fake", Some(owner.to_string())).unwrap();
        let err = s.app.migrate_contract(owner.clone(), addr, &MigrateMsg {}, rewards).unwrap_err();
        assert!(err.root_cause().to_string().contains("cannot migrate"), "{label}: {}", err.root_cause());
    }
}

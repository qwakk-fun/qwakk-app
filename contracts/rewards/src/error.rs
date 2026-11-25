use cosmwasm_std::StdError;
use thiserror::Error;

/// Every message starts with "qwakk-rewards: " so the app can map a refused
/// simulation to fixed copy without showing the node's text.
#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("qwakk-rewards: unauthorized")]
    Unauthorized,

    #[error("qwakk-rewards: no funds may be attached")]
    FundsNotAllowed,

    #[error("qwakk-rewards: attach exactly the stage total in the stage denom and nothing else")]
    WrongFunding,

    #[error("qwakk-rewards: invalid stage: {0}")]
    InvalidStage(&'static str),

    #[error("qwakk-rewards: stage not found")]
    StageNotFound,

    #[error("qwakk-rewards: claim window not open")]
    NotStarted,

    #[error("qwakk-rewards: claim window ended")]
    Ended,

    #[error("qwakk-rewards: stage still running")]
    StillRunning,

    #[error("qwakk-rewards: stage paused")]
    Paused,

    #[error("qwakk-rewards: stage closed")]
    Closed,

    #[error("qwakk-rewards: already claimed")]
    AlreadyClaimed,

    #[error("qwakk-rewards: invalid proof")]
    InvalidProof,

    #[error("qwakk-rewards: amount must be positive")]
    ZeroAmount,

    #[error("qwakk-rewards: stage total exceeded")]
    StageExhausted,

    #[error("qwakk-rewards: no pending owner")]
    NoPendingOwner,

    #[error("qwakk-rewards: cannot migrate: {0}")]
    Migration(String),
}

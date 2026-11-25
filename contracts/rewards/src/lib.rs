//! qwakk-rewards: weekly Qwakk liquidity rewards as Merkle claims.
//!
//! Every stage is funded on its own at registration with exactly its total,
//! and pays out at most that total, so a wrong root can only ever affect the
//! funds of its own stage. See README.md.

pub mod contract;
pub mod error;
pub mod merkle;
pub mod msg;
pub mod state;

pub use crate::error::ContractError;

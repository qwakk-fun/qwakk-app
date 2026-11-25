//! The Merkle encoding shared with the indexer (qwakk-rewards-v1).
//!
//! leaf = sha256("qwakk-rewards-v1" || u64_be(stage_id) || u8(len(address)) || address (UTF-8) || u128_be(amount))
//! node = sha256(min(a, b) || max(a, b))   (byte-wise comparison, sorted pair)
//!
//! The tree sorts its leaves ascending, pairs neighbours and carries an odd
//! last node up unchanged. Verification folds the proof into the leaf.

use sha2::{Digest, Sha256};

pub const LEAF_DOMAIN: &[u8] = b"qwakk-rewards-v1";

pub type Hash = [u8; 32];

/// The leaf for one claim. None when the address is longer than 255 bytes
/// (its length must fit the one-byte prefix).
pub fn leaf_hash(stage_id: u64, address: &str, amount: u128) -> Option<Hash> {
    let address = address.as_bytes();
    let len = u8::try_from(address.len()).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(LEAF_DOMAIN);
    hasher.update(stage_id.to_be_bytes());
    hasher.update([len]);
    hasher.update(address);
    hasher.update(amount.to_be_bytes());
    Some(hasher.finalize().into())
}

/// Parent of two nodes, order independent.
pub fn node_hash(a: &Hash, b: &Hash) -> Hash {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut hasher = Sha256::new();
    hasher.update(lo);
    hasher.update(hi);
    hasher.finalize().into()
}

pub fn verify(leaf: Hash, proof: &[Hash], root: &Hash) -> bool {
    proof.iter().fold(leaf, |acc, sibling| node_hash(&acc, sibling)) == *root
}

/// Exactly 64 hex characters (either case) to 32 bytes.
pub fn parse_hash(text: &str) -> Option<Hash> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(text, &mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_is_order_independent() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        assert_eq!(node_hash(&a, &b), node_hash(&b, &a));
    }

    #[test]
    fn parse_hash_rejects_bad_input() {
        assert!(parse_hash("00").is_none());
        assert!(parse_hash(&"g".repeat(64)).is_none());
        assert!(parse_hash(&"A".repeat(64)).is_some());
    }

    #[test]
    fn leaf_refuses_overlong_address() {
        assert!(leaf_hash(1, &"a".repeat(256), 1).is_none());
        assert!(leaf_hash(1, &"a".repeat(255), 1).is_some());
    }
}

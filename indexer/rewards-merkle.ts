/**
 * Merkle tree for Qwakk reward claims. It must match the CosmWasm rewards
 * contract byte for byte (shared vector: tests/fixtures/qwakk-rewards-vector.json).
 *
 * leaf = sha256("qwakk-rewards-v1" || u64_be(stage_id) || u8(len(address)) || address (UTF-8 bech32) || u128_be(amount))
 * node = sha256(min(a, b) || max(a, b)), byte-wise sorted pair
 * Leaves are sorted ascending and paired left to right; an odd last node is
 * carried up unchanged. A proof lists sibling hashes bottom up, skipping the
 * levels where the node was carried. Verify: h = leaf; h = node(h, p) for
 * every p; h must equal the root.
 */

import { createHash } from "node:crypto";

export const REWARDS_LEAF_DOMAIN = "qwakk-rewards-v1";
const MAX_U64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_U128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const HEX_32 = /^[0-9a-f]{64}$/;

function sha256(...parts: Buffer[]) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function rewardLeaf(stageId: bigint | number, address: string, amount: bigint): Buffer {
  const stage = BigInt(stageId);
  if (stage < BigInt(1) || stage > MAX_U64) throw new Error("Stage id must be a positive u64");
  if (amount < BigInt(0) || amount > MAX_U128) throw new Error("Amount must fit in u128");
  const addressBytes = Buffer.from(address, "utf8");
  if (addressBytes.length === 0 || addressBytes.length > 255) throw new Error("Address must be 1 to 255 bytes");
  const stageBytes = Buffer.alloc(8);
  stageBytes.writeBigUInt64BE(stage);
  const amountBytes = Buffer.alloc(16);
  amountBytes.writeBigUInt64BE(amount >> BigInt(64), 0);
  amountBytes.writeBigUInt64BE(amount & MAX_U64, 8);
  return sha256(Buffer.from(REWARDS_LEAF_DOMAIN, "utf8"), stageBytes, Buffer.from([addressBytes.length]), addressBytes, amountBytes);
}

export function hashPair(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0 ? sha256(a, b) : sha256(b, a);
}

export type RewardClaimInput = { address: string; amount: bigint };
export type RewardClaimProof = { address: string; amount: bigint; leaf: string; proof: string[] };
export type RewardTree = { stageId: bigint; root: string; claims: RewardClaimProof[] };

/** Builds the tree for one stage. Claims keep the input order; addresses must be unique. */
export function buildRewardTree(stageId: bigint | number, claims: RewardClaimInput[]): RewardTree {
  if (!claims.length) throw new Error("A reward tree needs at least one claim");
  if (new Set(claims.map((claim) => claim.address)).size !== claims.length) throw new Error("Each address may appear once per stage");
  const leaves = claims.map((claim) => rewardLeaf(stageId, claim.address, claim.amount));
  const levels: Buffer[][] = [[...leaves].sort(Buffer.compare)];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(index + 1 < current.length ? hashPair(current[index], current[index + 1]) : current[index]);
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];
  const positions = new Map(levels[0].map((leaf, index) => [leaf.toString("hex"), index]));
  return {
    stageId: BigInt(stageId),
    root: root.toString("hex"),
    claims: claims.map((claim, claimIndex) => {
      const leafHex = leaves[claimIndex].toString("hex");
      let index = positions.get(leafHex) as number;
      const proof: string[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = index ^ 1;
        if (sibling < level.length) proof.push(level[sibling].toString("hex"));
        index = Math.floor(index / 2);
      }
      return { address: claim.address, amount: claim.amount, leaf: leafHex, proof };
    }),
  };
}

export function verifyRewardProof(leafHex: string, proof: string[], rootHex: string): boolean {
  if (!HEX_32.test(leafHex) || !HEX_32.test(rootHex) || !proof.every((entry) => HEX_32.test(entry))) return false;
  let hash: Buffer = Buffer.from(leafHex, "hex");
  for (const entry of proof) hash = hashPair(hash, Buffer.from(entry, "hex"));
  return hash.toString("hex") === rootHex;
}

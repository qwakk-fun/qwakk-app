/**
 * What the /vault queue shows for each action. Pure, browser safe, and kept
 * free of BigInt literals (the app targets ES2017).
 */
import type { VaultActionRow } from "./qwakk-vault";

/** PondVault.GRACE_PERIOD: a queued action that waits longer than this after its eta can never run. */
export const VAULT_GRACE_SECONDS = 7 * 24 * 3600;

export type VaultChipTone = "done" | "off" | "wait" | "ready" | "blocked";

export function vaultDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function overCap(row: VaultActionRow, remainingToday: Readonly<Record<string, string>>): boolean {
  if (row.action !== "Withdraw" || !row.amountRaw || !row.token) return false;
  const left = remainingToday[row.token.toLowerCase()];
  if (left === undefined || !/^\d+$/.test(left) || !/^\d+$/.test(row.amountRaw)) return false;
  return BigInt(row.amountRaw) > BigInt(left);
}

/**
 * The state of one queued action, as the contract would treat an `execute`
 * right now: a withdrawal is blocked while the vault is paused, and when it is
 * larger than what is left of today's cap for its token.
 */
export function vaultActionState(
  row: VaultActionRow,
  now: number,
  ctx: { paused: boolean; remainingToday: Readonly<Record<string, string>> },
): { label: string; tone: VaultChipTone } {
  if (row.status === "executed") return { label: "Executed", tone: "done" };
  if (row.status === "cancelled") return { label: "Cancelled", tone: "off" };
  if (now > row.eta + VAULT_GRACE_SECONDS) return { label: "Expired", tone: "off" };
  if (row.action === "Withdraw" && ctx.paused) return { label: "Blocked: vault paused", tone: "blocked" };
  const capped = overCap(row, ctx.remainingToday);
  if (now < row.eta) {
    const wait = `Ready in ${vaultDuration(row.eta - now)}`;
    // The cap may reset at 00:00 UTC before then, so this is a heads-up, not a block.
    return capped ? { label: `${wait}, over today's cap`, tone: "wait" } : { label: wait, tone: "wait" };
  }
  if (capped) return { label: "Blocked: over today's cap", tone: "blocked" };
  return { label: "Ready to execute", tone: "ready" };
}

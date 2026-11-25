"use client";

import type { ReactNode } from "react";
import { TokenIcon } from "./TokenIcon";
import { RewardClaimAction, useRewardClaimFlow } from "./RewardClaim";
import { useFeatures } from "./useFeatures";
import { usePointsClock } from "./usePoints";
import { useAddressRewards, useRewardPrograms } from "./useRewards";
import { BRAND } from "../lib/brand";
import type { QwakkRewardClaim, QwakkRewardProgram } from "../lib/qwakk-rewards";
import { REWARDS_HONESTY, REWARDS_POOL } from "../lib/qwakk-rewards-copy";
import { formatRewardHero, formatRewardTime, formatSharePpm, formatTimeLeft, nextRewardClaim, warmingHoursLeft } from "../lib/qwakk-rewards-view";

type Props = {
  poolId: string;
  walletAddress: string;
  /** True when the add-liquidity form is on this page (`#pool-liquidity`). */
  canAddLiquidity: boolean;
};

/**
 * Weekly LP rewards for one pool: one hero number (what this wallet earns
 * this week, or the weekly pot when it earns nothing yet), quiet facts beside
 * it and at most one primary action. Renders nothing unless the program and
 * claims are both switched on and this pool has a program.
 */
export function RewardsPoolCard(props: Props) {
  const { rewards } = useFeatures();
  return rewards ? <RewardsPoolCardBody {...props} /> : null;
}

function RewardsPoolCardBody(props: Props) {
  const programs = useRewardPrograms(true);
  const program = programs.data?.programs.find((entry) => entry.poolId === props.poolId) ?? null;
  // Nothing while loading or unavailable: the card never promises a program it cannot show.
  if (!program || !programs.data) return null;
  return <RewardsStrip {...props} program={program} />;
}

/** Scrolls to the add-liquidity form, without the glide when reduced motion is asked for. */
function scrollToLiquidity() {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("pool-liquidity")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

type Hero = { label: string; value: string; chip: boolean; note?: string };

function RewardsStrip({ program, walletAddress, canAddLiquidity }: Props & { program: QwakkRewardProgram }) {
  const rewards = useAddressRewards(walletAddress, true);
  const flow = useRewardClaimFlow(walletAddress, rewards.contract);
  const now = usePointsClock();
  const epoch = program.currentEpoch;
  const symbol = program.rewardSymbol;
  const pot = formatRewardHero(epoch?.budget ?? program.epochBudget, program.rewardDecimals) ?? "";
  const left = formatTimeLeft(epoch?.endsAt, now);
  const accrual = rewards.data?.current.find((entry) => entry.programId === program.id) ?? null;
  const excluded = Boolean(rewards.data?.excluded) || accrual?.status === "excluded";

  // The claim to offer here: the open week whose window closes first, kept on screen while it is being sent.
  const claims = (rewards.data?.claims ?? []).filter((claim) => claim.programId === program.id);
  const claimedFor = (claim: QwakkRewardClaim) => rewards.isClaimed(claim.stageId);
  const claim = flow.pinned ?? nextRewardClaim(claims, claimedFor, now).claim;
  // The program's decimals stand in when the week's own are missing; never a base-unit amount.
  const claimAmount = claim ? formatRewardHero(claim.amount, claim.rewardDecimals ?? program.rewardDecimals) : null;

  const facts: Array<[string, ReactNode]> = [];
  let hero: Hero = { label: REWARDS_POOL.pot, value: pot, chip: true };
  if (!epoch) {
    hero = { label: REWARDS_POOL.firstWeek, value: formatRewardTime(program.firstEpochStartsAt) ?? "", chip: false };
    facts.push([REWARDS_POOL.potLabel, `${pot} ${symbol}`]);
  } else if (accrual?.status === "earning" && !excluded) {
    hero = { label: REWARDS_POOL.earning, value: formatRewardHero(accrual.estimatedAmount, accrual.rewardDecimals) ?? "", chip: true };
    const share = formatSharePpm(accrual.sharePpm);
    if (share) facts.push([REWARDS_POOL.share, share]);
    facts.push([REWARDS_POOL.potLabel, `${pot} ${symbol}`]);
  } else if (accrual?.status === "warming_up" && !excluded) {
    hero = { label: REWARDS_POOL.warming, value: REWARDS_POOL.warmingValue(warmingHoursLeft(accrual.warmingUpHours, accrual.minHoldHours)), chip: false, note: REWARDS_POOL.warmingNote(accrual.minHoldHours) };
    facts.push([REWARDS_POOL.potLabel, `${pot} ${symbol}`]);
  } else {
    hero.note = !walletAddress ? REWARDS_POOL.connectNote
      : excluded ? REWARDS_POOL.excludedNote(BRAND.name)
      : rewards.status === "unavailable" ? REWARDS_POOL.unavailableNote
      : rewards.status === "ready" ? REWARDS_POOL.idleNote
      : undefined;
  }
  if (epoch && left) facts.push([REWARDS_POOL.weekEnds(epoch.number), left]);
  // Who else is in matters while this wallet is not earning yet.
  if (epoch && hero.label === REWARDS_POOL.pot) facts.push([REWARDS_POOL.wallets, new Intl.NumberFormat("en-US").format(epoch.participants)]);

  // At most one primary action: a claim first, then the way in.
  const action = claim && claimAmount && walletAddress
    ? <RewardClaimAction flow={flow} claim={claim} amount={`${claimAmount} ${symbol}`} label={REWARDS_POOL.claimButton(`${claimAmount} ${symbol}`)} />
    : !walletAddress && epoch
      ? <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>{REWARDS_POOL.connectButton}</button>
      : epoch && canAddLiquidity && rewards.status === "ready" && !excluded && (!accrual || accrual.status === "not_earning")
        ? <button type="button" className="btn btn-primary btn-block btn-lg" onClick={scrollToLiquidity}>{REWARDS_POOL.addButton}</button>
        : null;

  return <section className={`panel rewards-strip${action ? " has-action" : ""}`} aria-labelledby="rewards-strip-title">
    <div className="rewards-strip-head">
      <h2 className="panel-title" id="rewards-strip-title">{REWARDS_POOL.title}</h2>
    </div>
    <div className="rewards-strip-body">
      <div className="quote-field rewards-hero">
        <span className="quote-field-top"><span>{hero.label}</span></span>
        <span className="quote-field-row">
          <output className="rewards-hero-value">{hero.value}</output>
          {hero.chip && <span className="token-chip"><TokenIcon denom={program.rewardDenom} size="small" />{symbol}</span>}
        </span>
        {hero.note && <span className="rewards-hero-note">{hero.note}</span>}
      </div>
      {facts.length > 0 && <dl className="rewards-facts">
        {facts.map(([label, value]) => <div className="quote-meta-row" key={label}><dt>{label}</dt><dd className="num">{value}</dd></div>)}
      </dl>}
      {action && <div className="rewards-action">{action}</div>}
    </div>
    <p className="rewards-foot">{REWARDS_HONESTY}</p>
  </section>;
}

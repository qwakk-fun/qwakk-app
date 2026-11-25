"use client";

import { ExternalLink } from "lucide-react";
import { RewardClaimAction, useRewardClaimFlow } from "./RewardClaim";
import { TokenIcon } from "./TokenIcon";
import { useFeatures } from "./useFeatures";
import { usePointsClock } from "./usePoints";
import { useAddressRewards, useRewardPrograms } from "./useRewards";
import { explorerTxUrl } from "../lib/qwakk-network";
import type { QwakkRewardClaim } from "../lib/qwakk-rewards";
import { REWARDS_HONESTY, REWARDS_PORTFOLIO } from "../lib/qwakk-rewards-copy";
import { formatRewardAmount, formatRewardDay, formatRewardHero, formatRewardRange, formatSharePpm, formatTimeLeft, nextRewardClaim, rewardClaimState, warmingHoursLeft } from "../lib/qwakk-rewards-view";

/**
 * The connected wallet's LP rewards on the portfolio page: what is ready to
 * claim (with the page's one Claim button), this week so far, then a quiet
 * list of past weeks. Renders nothing unless the program and claims are both
 * switched on.
 */
export function RewardsPortfolio({ address }: { address: string }) {
  const { rewards } = useFeatures();
  return rewards && address ? <RewardsPortfolioBody address={address} /> : null;
}

const sameClaim = (a: QwakkRewardClaim | null, b: QwakkRewardClaim) => a !== null && a.programId === b.programId && a.stageId === b.stageId;

function RewardsPortfolioBody({ address }: { address: string }) {
  const programs = useRewardPrograms(true);
  const rewards = useAddressRewards(address, true);
  const flow = useRewardClaimFlow(address, rewards.contract);
  const now = usePointsClock();

  const head = <div className="panel-head"><h2 className="panel-title" id="rewards-title">{REWARDS_PORTFOLIO.title}</h2></div>;
  if (rewards.status === "unavailable" || (rewards.status === "ready" && !rewards.data)) {
    return <section className="panel rewards-portfolio" id="rewards" aria-labelledby="rewards-title">{head}
      <div className="empty rewards-empty"><p>{REWARDS_PORTFOLIO.unavailable}</p><button type="button" className="btn btn-ghost btn-sm" onClick={rewards.reload}>{REWARDS_PORTFOLIO.retry}</button></div>
    </section>;
  }
  if (!rewards.data) {
    return <section className="panel rewards-portfolio" id="rewards" aria-labelledby="rewards-title" aria-busy="true">{head}<div className="empty rewards-empty"><p>{REWARDS_PORTFOLIO.loading}</p></div></section>;
  }

  const programById = new Map((programs.data?.programs ?? []).map((program) => [program.id, program]));
  const decimalsFor = (claim: QwakkRewardClaim) => claim.rewardDecimals ?? programById.get(claim.programId)?.rewardDecimals ?? null;
  const symbolFor = (claim: QwakkRewardClaim) => claim.rewardSymbol ?? programById.get(claim.programId)?.rewardSymbol ?? "";
  const claimedFor = (claim: QwakkRewardClaim) => rewards.isClaimed(claim.stageId);

  const { claims, current } = rewards.data;
  // Only a week whose decimals are known is offered: its amount is never shown in base units next to a symbol.
  const next = nextRewardClaim(claims.filter((claim) => decimalsFor(claim) !== null), claimedFor, now);
  const ready = flow.pinned ?? next.claim;
  const readyAmount = ready ? formatRewardHero(ready.amount, decimalsFor(ready)) : null;
  const readyBy = ready ? formatRewardDay(ready.claimEndsAt) : null;
  const readySymbol = ready ? symbolFor(ready) : current[0]?.rewardSymbol ?? "QWAKK";
  const readyDenom = ready?.rewardDenom ?? current[0]?.rewardDenom ?? "";
  const more = ready && !flow.pinned ? next.open - 1 : 0;

  const week = current[0] ?? null;
  const weekLeft = week ? formatTimeLeft(week.endsAt, now) : null;
  const weekShare = week ? formatSharePpm(week.sharePpm) : null;
  const warming = week?.status === "warming_up" && !rewards.data.excluded;
  const weekValue = week?.status === "earning" ? formatRewardHero(week.estimatedAmount, week.rewardDecimals)
    : warming && week ? REWARDS_PORTFOLIO.warmingValue(warmingHoursLeft(week.warmingUpHours, week.minHoldHours))
    : null;
  const weekNote = !week ? null
    : week.status === "earning" ? (weekShare && weekLeft ? REWARDS_PORTFOLIO.thisWeekNote(weekShare, weekLeft) : null)
    : warming ? REWARDS_PORTFOLIO.warmingNote(week.minHoldHours)
    : week.status === "excluded" || rewards.data.excluded ? REWARDS_PORTFOLIO.excluded
    : REWARDS_PORTFOLIO.notEarning;

  const history = claims.filter((claim) => !sameClaim(ready, claim));

  return <section className="panel rewards-portfolio" id="rewards" aria-labelledby="rewards-title">
    {head}
    <div className="rewards-portfolio-top">
      <div className={`quote-field rewards-hero${ready ? " is-ready" : ""}`}>
        <span className="quote-field-top"><span>{REWARDS_PORTFOLIO.ready}</span></span>
        <span className="quote-field-row">
          <output className={`rewards-hero-value${ready && readyAmount ? "" : " is-zero"}`}>{ready && readyAmount ? readyAmount : "0"}</output>
          {readyDenom && <span className="token-chip"><TokenIcon denom={readyDenom} size="small" />{readySymbol}</span>}
        </span>
        <span className="rewards-hero-note">{ready && readyBy ? REWARDS_PORTFOLIO.readyNote(ready.epoch, readyBy) : REWARDS_PORTFOLIO.nothingReady}</span>
        {ready && readyAmount && <div className="rewards-hero-action">
          <RewardClaimAction flow={flow} claim={ready} amount={`${readyAmount} ${readySymbol}`} label={REWARDS_PORTFOLIO.claimButton} />
          {more > 0 && <span className="rewards-hero-note">{REWARDS_PORTFOLIO.moreReady(more)}</span>}
        </div>}
      </div>
      {week && <div className="quote-field rewards-hero">
        <span className="quote-field-top"><span>{warming ? REWARDS_PORTFOLIO.warmingLabel : REWARDS_PORTFOLIO.thisWeek}</span></span>
        <span className="quote-field-row">
          <output className={`rewards-hero-value${weekValue ? "" : " is-zero"}`}>{weekValue ?? "0"}</output>
          {!warming && <span className="token-chip"><TokenIcon denom={week.rewardDenom} size="small" />{week.rewardSymbol}</span>}
        </span>
        {weekNote && <span className="rewards-hero-note">{weekNote}</span>}
      </div>}
    </div>

    {history.length > 0 && <>
      <h3 className="rewards-subhead">{REWARDS_PORTFOLIO.history}</h3>
      <ul className="rewards-history">{history.map((claim) => {
        // The clock is zero until mounted: nothing reads as open before it ticks.
        const state = now > 0 ? rewardClaimState(claim, claimedFor(claim), now) : "pending";
        const amount = formatRewardAmount(claim.amount, decimalsFor(claim));
        const hash = state === "claimed" ? rewards.claimTx(claim.stageId) : null;
        const opens = state === "upcoming" ? formatRewardDay(claim.claimStartsAt) : null;
        return <li key={`${claim.programId}|${claim.stageId}`}>
          <span className="rewards-history-week"><b>{REWARDS_PORTFOLIO.week(claim.epoch)}</b><small>{formatRewardRange(claim.startsAt, claim.endsAt)}</small></span>
          <span className="rewards-history-amount num">{amount ? `${amount} ${symbolFor(claim)}` : REWARDS_PORTFOLIO.amountUnknown(claim.amount)}</span>
          <span className={`rewards-history-state is-${state}`}>{state === "claimed"
            ? hash ? <a href={explorerTxUrl(hash)} target="_blank" rel="noreferrer">{REWARDS_PORTFOLIO.claimed}<ExternalLink size={12} aria-hidden="true" /></a> : REWARDS_PORTFOLIO.claimed
            : state === "claimable" ? REWARDS_PORTFOLIO.ready_short
            : state === "expired" ? REWARDS_PORTFOLIO.expired
            : state === "closed" ? REWARDS_PORTFOLIO.closed
            : opens ? REWARDS_PORTFOLIO.opens(opens) : REWARDS_PORTFOLIO.pending}</span>
        </li>;
      })}</ul>
    </>}
    <p className="rewards-foot">{REWARDS_HONESTY}</p>
  </section>;
}

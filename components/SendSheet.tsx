"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown, ClipboardPaste, ShieldAlert } from "lucide-react";
import { BRAND } from "../lib/brand";
import { groupDigits } from "../lib/qwakk-pnl-display";
import { QOR_SEND_RESERVE_TEXT, baseToInput, checkRecipient, checkSendAmount, maxSendable } from "../lib/qwakk-send-form";
import { sendAction } from "../lib/qwakk-send-action";
import { assetDecimalsUnknownCopy, qorexNetworkCopy } from "../lib/qwakk-tx-copy";
import type { WalletNetworkState } from "../lib/qwakk-wallet-network";
import { formatVisibleAmount } from "../lib/qwakk-assets";
import { BottomSheet, useSheetClose } from "./BottomSheet";
import { useNetworkCopy } from "./NetworkContext";
import { TestnetNote } from "./TestnetNote";
import { TokenIcon } from "./TokenIcon";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";

/** A token the wallet holds and may send (QOR or an `erc20:0x…` bank token). */
export type SendableToken = { denom: string; symbol: string; name: string; decimals: number | null; balance: bigint };

function balanceText(token: SendableToken) {
  return token.decimals === null ? `${groupDigits(token.balance.toString())} base units` : groupDigits(formatVisibleAmount(token.balance.toString(), token.decimals, 6));
}

/**
 * Send flow for the portfolio page: pick a token, amount and recipient, review
 * every detail in plain words, then QoreX signs and sends one bank transfer
 * (lib/qwakk-native-send.ts). Progress and the result use the shared
 * TxProgress, and the page reloads balances on `qwakk:tx-confirmed`.
 */
export function SendSheet({ address, tokens, initialDenom, qorBalance, walletNetwork, onClose }: {
  address: string;
  tokens: readonly SendableToken[];
  initialDenom: string | null;
  qorBalance: bigint;
  walletNetwork: WalletNetworkState;
  onClose: () => void;
}) {
  const { network, label } = useNetworkCopy();
  const tx = useNativeTransaction();
  const ids = useId();
  const amountRef = useRef<HTMLInputElement>(null);
  const [denom, setDenom] = useState(() => initialDenom && tokens.some((token) => token.denom === initialDenom) ? initialDenom : tokens[0]?.denom ?? "");
  const [picking, setPicking] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [recipientText, setRecipientText] = useState("");
  const [recipientDone, setRecipientDone] = useState(false);
  // Everything the review states, frozen when it opens, so a balance refresh never changes what was approved.
  const [review, setReview] = useState<Review | null>(null);
  const [pasteBlocked, setPasteBlocked] = useState(false);

  // A balance refresh can drop the chosen token (sent in full elsewhere): fall back to the first one.
  const token = tokens.find((item) => item.denom === denom) ?? tokens[0] ?? null;
  const amount = token && token.decimals !== null ? checkSendAmount(amountText, token.decimals, token.denom, token.balance, token.symbol) : null;
  const recipient = checkRecipient(recipientText, address, recipientDone);
  const wrongNetwork = walletNetwork.check === "wrong";
  const noFeeQor = qorBalance <= BigInt(0);
  const max = token ? maxSendable(token.denom, token.balance) : BigInt(0);

  const blocker = !token ? "Nothing to send"
    : token.decimals === null ? "Amount on hold"
    : noFeeQor ? "No QOR for the fee"
    : amount?.state === "empty" ? "Enter an amount"
    : amount?.state === "too_much" ? `Not enough ${token.symbol}`
    : amount?.state === "invalid" ? "Check the amount"
    : recipient.state === "empty" ? "Add a recipient"
    : recipient.state !== "ok" ? "Check the address"
    : null;

  const busy = tx.busy;
  const phase = tx.state.phase;
  const title = phase === "success" ? "Sent" : phase === "failed" ? "Transfer not confirmed" : phase !== "idle" ? "Sending" : review ? "Check the details" : "Send tokens";

  function openReview() {
    setRecipientDone(true);
    const final = checkRecipient(recipientText, address, true);
    if (blocker || wrongNetwork || !token || token.decimals === null || amount?.state !== "ok" || final.state !== "ok") return;
    setReview({ denom: token.denom, symbol: token.symbol, amount: amount.amount, shown: groupDigits(formatVisibleAmount(amount.amount, token.decimals, token.decimals)), toAddress: final.address });
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      setRecipientText(text.trim());
      setRecipientDone(true);
      setPasteBlocked(false);
    } catch {
      setPasteBlocked(true);
    }
  }

  function confirm() {
    if (!review || wrongNetwork || busy) return;
    void tx.run(sendAction({ toAddress: review.toAddress, denom: review.denom, amount: review.amount }));
  }

  const amountId = `${ids}-amount`;
  const recipientId = `${ids}-recipient`;
  const recipientHelp = `${ids}-recipient-help`;
  const amountHelp = `${ids}-amount-help`;

  return <BottomSheet title={title} titleId={`${ids}-title`} className="send-sheet" locked={busy} onClose={onClose}>
    {phase !== "idle" ? <div className="send-progress">
      {review && <SendSummary review={review} label={label} compact />}
      <SendProgress state={tx.state} reset={tx.reset} />
    </div>
      : review ? <div className="send-review">
        <SendSummary review={review} label={label} />
        <dl className="send-facts">
          <div><dt>Network fee</dt><dd>Usually about 0.04 QOR. QoreX shows the exact fee before you approve.</dd></div>
          <div><dt>{BRAND.name} fee</dt><dd>None</dd></div>
        </dl>
        <TestnetNote />
        <p className="send-final"><ShieldAlert size={16} aria-hidden="true" /><span>Transfers are final. Nobody, {BRAND.name} included, can reverse one or recover tokens sent to a wrong address.</span></p>
        {wrongNetwork && <p className="form-error" role="alert">{qorexNetworkCopy(network, undefined, walletNetwork.wallet)}</p>}
        <div className="review-actions">
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => setReview(null)}>Back</button>
          <button type="button" className="btn btn-primary btn-lg" disabled={wrongNetwork} onClick={confirm}>Confirm in QoreX</button>
        </div>
      </div>
      : <form className="send-form" noValidate onSubmit={(event) => { event.preventDefault(); openReview(); }}>
        <p className="sheet-lead">Move tokens from this wallet to any qor1 address on {label}.</p>

        {token && <div className="send-token">
          <button type="button" className="send-token-btn" aria-expanded={picking} aria-controls={`${ids}-tokens`} onClick={() => setPicking((open) => !open)} disabled={tokens.length < 2}>
            <TokenIcon denom={token.denom} size="regular" />
            <span className="send-token-name"><b>{token.symbol}</b><small className="num">{balanceText(token)} available</small></span>
            {tokens.length > 1 && <ChevronDown size={16} aria-hidden="true" className="send-token-chevron" />}
          </button>
          {picking && <ul className="send-token-list" id={`${ids}-tokens`} role="listbox" aria-label="Token to send">
            {tokens.map((item) => <li key={item.denom} role="option" aria-selected={item.denom === token.denom}>
              <button type="button" onClick={() => { setDenom(item.denom); setAmountText(""); setPicking(false); amountRef.current?.focus(); }}>
                <TokenIcon denom={item.denom} size="regular" />
                <span className="send-token-name"><b>{item.symbol}</b>{item.name !== item.symbol && <small>{item.name}</small>}</span>
                <span className="num send-token-balance">{balanceText(item)}</span>
              </button>
            </li>)}
          </ul>}
        </div>}

        <div className="quote-field send-amount">
          <span className="quote-field-top">
            <label htmlFor={amountId}>Amount</label>
            {token && token.decimals !== null && <span className="quick-amounts"><button type="button" disabled={max <= BigInt(0)} aria-pressed={amountText !== "" && amountText === baseToInput(max, token.decimals)} onClick={() => setAmountText(baseToInput(max, token.decimals ?? 0))}>Max</button></span>}
          </span>
          <span className="quote-field-row">
            <input ref={amountRef} id={amountId} inputMode="decimal" autoComplete="off" placeholder="0" value={amountText} aria-describedby={amountHelp} aria-invalid={amount?.state === "invalid" || amount?.state === "too_much"} disabled={!token || token.decimals === null}
              onChange={(event) => setAmountText(event.target.value.replace(",", ".").replace(/[^\d.]/g, ""))} />
            {token && <span className="token-chip"><TokenIcon denom={token.denom} size="small" />{token.symbol}</span>}
          </span>
        </div>
        <p id={amountHelp} className={`send-help${amount?.state === "invalid" || amount?.state === "too_much" ? " is-error" : ""}`} aria-live="polite">
          {!token ? "This wallet holds no tokens that can be sent."
            : token.decimals === null ? assetDecimalsUnknownCopy(token.symbol)
            : amount?.state === "invalid" || amount?.state === "too_much" ? amount.message
            : noFeeQor ? "Every transfer pays a small network fee in QOR, and this wallet has none."
            : token.denom === "uqor" && amount?.state === "ok" && amount.tight ? `This leaves under ${QOR_SEND_RESERVE_TEXT} for network fees. QoreX stops the transfer if the fee does not fit.`
            : token.denom === "uqor" ? `Max keeps ${QOR_SEND_RESERVE_TEXT} back for network fees.`
            : "The network fee is paid in QOR, not in this token."}
        </p>

        <div className="field send-recipient">
          <label htmlFor={recipientId}>Recipient</label>
          <span className="send-recipient-row">
            <input id={recipientId} type="text" inputMode="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="qor1…" value={recipientText}
              aria-describedby={recipientHelp} aria-invalid={recipient.state === "invalid" || recipient.state === "self"}
              onChange={(event) => { setRecipientText(event.target.value); setRecipientDone(false); }} onBlur={() => setRecipientDone(true)} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void paste()}><ClipboardPaste size={14} aria-hidden="true" />Paste</button>
          </span>
          <span id={recipientHelp} className={`send-help${recipient.state === "invalid" || recipient.state === "self" ? " is-error" : ""}`} aria-live="polite">
            {recipient.state === "invalid" || recipient.state === "self" ? recipient.message
              : pasteBlocked ? "Pasting is blocked here. Press and hold the field to paste."
              : recipient.state === "ok" ? "Valid QoreChain address. Check it matches the one you were given."
              : "A QoreChain wallet address, starting with qor1."}
          </span>
        </div>

        {wrongNetwork && <p className="form-error" role="alert">{qorexNetworkCopy(network, undefined, walletNetwork.wallet)}</p>}
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={Boolean(blocker) || wrongNetwork}>{wrongNetwork ? "Wrong network in QoreX" : blocker ?? "Review transfer"}</button>
      </form>}
  </BottomSheet>;
}

/** Done closes the sheet; Close after a stop goes back to the review, details intact. */
function SendProgress({ state, reset }: { state: ReturnType<typeof useNativeTransaction>["state"]; reset: () => void }) {
  const close = useSheetClose();
  return <TxProgress state={state} onDone={() => { if (state.phase === "success") close(); else reset(); }} />;
}

type Review = { denom: string; symbol: string; amount: string; shown: string; toAddress: string };

function SendSummary({ review, label, compact = false }: { review: Review; label: string; compact?: boolean }) {
  return <div className={`send-summary${compact ? " is-compact" : ""}`}>
    <span className="send-summary-amount"><TokenIcon denom={review.denom} size={compact ? "regular" : "large"} /><b className="num">{review.shown} {review.symbol}</b></span>
    <dl className="send-facts">
      <div className="send-to"><dt>To</dt><dd className="mono">{review.toAddress}</dd></div>
      {!compact && <div><dt>Network</dt><dd>{label}</dd></div>}
    </dl>
  </div>;
}

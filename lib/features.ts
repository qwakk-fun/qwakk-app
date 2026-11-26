/**
 * Wallet actions stay off until native signing works end to end on QoreChain.
 *
 * `QWAKK_NATIVE_ACTIONS` is read per request, so CapRover can change it without
 * a rebuild:
 * - unset, empty or `off`: every wallet action is off (the default);
 * - `enabled`, `true` or `all`: every trading action is on (not `rewards_claim`
 *   or `send`);
 * - a comma list of `swap`, `liquidity` (both add and remove),
 *   `add_liquidity`, `remove_liquidity`, `create_pool`, `rewards_claim` and
 *   `send`: only those are on.
 *
 * `rewards_claim` and `send` are only ever on when listed by name, so the live
 * `enabled` setting never opens them before they are verified with QoreX.
 * `rewards_claim` also needs `QWAKK_REWARDS_CONTRACT_ADDRESS`
 * (lib/qwakk-native-rewards.ts). `send` is a plain token transfer
 * (lib/qwakk-native-send.ts).
 *   Unknown entries are ignored with a warning, never treated as "all".
 */

export const NATIVE_ACTION_SWITCHES = ["swap", "add_liquidity", "remove_liquidity", "create_pool", "rewards_claim", "send"] as const;
export type NativeActionSwitch = (typeof NATIVE_ACTION_SWITCHES)[number];
export type NativeActionSwitches = Record<NativeActionSwitch, boolean>;

/** Switches that `enabled` / `all` do not turn on: they must be listed by name. */
const EXPLICIT_ONLY: ReadonlySet<NativeActionSwitch> = new Set(["rewards_claim", "send"]);

const ALL_ON = new Set(["enabled", "true", "all"]);
const ALL_OFF = new Set(["", "off", "false", "disabled", "none"]);

export function parseNativeActionSwitches(value: string | undefined): { actions: NativeActionSwitches; warnings: string[] } {
  const actions: NativeActionSwitches = { swap: false, add_liquidity: false, remove_liquidity: false, create_pool: false, rewards_claim: false, send: false };
  const warnings: string[] = [];
  const text = value?.trim().toLowerCase() ?? "";
  if (ALL_OFF.has(text)) return { actions, warnings };
  if (ALL_ON.has(text)) {
    for (const key of NATIVE_ACTION_SWITCHES) actions[key] = !EXPLICIT_ONLY.has(key);
    return { actions, warnings };
  }
  for (const entry of text.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (entry === "liquidity") {
      actions.add_liquidity = true;
      actions.remove_liquidity = true;
    } else if ((NATIVE_ACTION_SWITCHES as readonly string[]).includes(entry)) {
      actions[entry as NativeActionSwitch] = true;
    } else {
      warnings.push(`QWAKK_NATIVE_ACTIONS entry "${entry}" is not a known action. It is ignored.`);
    }
  }
  return { actions, warnings };
}

const warned = new Set<string>();

/** Which wallet actions this deployment allows right now. */
export function nativeActionSwitches(): NativeActionSwitches {
  const { actions, warnings } = parseNativeActionSwitches(process.env.QWAKK_NATIVE_ACTIONS);
  for (const warning of warnings) {
    if (warned.has(warning)) continue;
    warned.add(warning);
    console.warn(`[qwakk-features] ${warning}`);
  }
  return actions;
}

/** True when at least one wallet action is on. */
export function nativeActionsEnabled() {
  return Object.values(nativeActionSwitches()).some(Boolean);
}

/** True when this action kind may be prepared. */
export function nativeActionAllowed(kind: NativeActionSwitch) {
  return nativeActionSwitches()[kind] === true;
}

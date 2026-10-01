/**
 * Wallet actions stay off until native signing works end to end on QoreChain.
 * Set QORA_NATIVE_ACTIONS=enabled in the deployment to turn them on.
 */
export function nativeActionsEnabled() {
  return process.env.QORA_NATIVE_ACTIONS?.trim() === "enabled";
}

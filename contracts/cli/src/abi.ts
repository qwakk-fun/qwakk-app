/**
 * The Pond Vault ABI the CLI uses. `test/abi.test.ts` checks it against the
 * Foundry artifact (`forge build`), so it cannot drift from the contract.
 */
import { parseAbi } from "viem";

export const POND_VAULT_ABI = parseAbi([
  "constructor(address owner_, address approver_, address guardian_, uint256 timelock_, uint256 nativeDailyCap_)",
  "function owner() view returns (address)",
  "function approver() view returns (address)",
  "function guardian() view returns (address)",
  "function paused() view returns (bool)",
  "function timelock() view returns (uint64)",
  "function nonce() view returns (uint64)",
  "function actionCount() view returns (uint256)",
  "function dailyCap(address token) view returns (uint256)",
  "function spentToday(address token) view returns (uint256)",
  "function remainingToday(address token) view returns (uint256)",
  "function keyStatus(address account) view returns (bool usable, bytes pubkey)",
  "function getAction(uint256 id) view returns ((uint8 action, uint8 status, uint64 nonce, uint64 eta, address token, address to, uint256 amount))",
  "function approvalMessage(uint8 action, address token, address to, uint256 amount, uint256 approvalNonce, uint256 deadline) view returns (bytes)",
  "function queue(uint8 action, address token, address to, uint256 amount, uint256 deadline, bytes signature) returns (uint256 id)",
  "function unpause(uint256 deadline, bytes signature)",
  "function execute(uint256 id)",
  "function cancel(uint256 id)",
  "function pause()",
  "function depositToken(address token, uint256 amount)",
  "event Deposited(address indexed token, address indexed from, uint256 amount)",
  "event ApprovalVerified(uint64 indexed nonce, address indexed approver, uint8 action, bytes32 messageHash)",
  "event ActionQueued(uint256 indexed id, uint8 indexed action, address token, address to, uint256 amount, uint64 nonce, uint64 eta)",
  "event ActionExecuted(uint256 indexed id, uint8 indexed action)",
  "event ActionCancelled(uint256 indexed id, address indexed by)",
  "event Withdrawn(uint256 indexed id, address indexed token, address indexed to, uint256 amount)",
  "event Paused(address indexed by)",
  "event Unpaused(address indexed by)",
  "error NotOwner()",
  "error NotOwnerOrGuardian()",
  "error VaultPaused()",
  "error VaultNotPaused()",
  "error ApprovalExpired()",
  "error ApprovalTooLong()",
  "error InvalidApproval()",
  "error ApproverKeyUnavailable(address account)",
  "error InvalidParameters()",
  "error NotQueued(uint256 id)",
  "error TimelockActive(uint64 eta)",
  "error ActionExpired(uint256 id)",
  "error DailyCapExceeded(address token, uint256 remaining)",
  "error GuardianCannotCancel(uint256 id)",
  "error TransferFailed()",
  "error Reentrancy()",
]);

/** `pqcKeyStatus` with the fourth value Diana returns (see src/interfaces/IQorePQC.sol). */
export const PQC_KEY_STATUS_ABI = parseAbi([
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);

export const ERC20_READ_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
]);

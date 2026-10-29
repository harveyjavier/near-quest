/**
 * USDC deposits on NEAR.
 *
 * The player sends `ft_transfer` on the USDC contract to the treasury from
 * their own wallet, then hands us the transaction hash. We read the final
 * transaction from RPC and credit only what it actually moved. The client
 * never says how much; the chain does.
 */

import { nearRpc } from '../auth/near.js';
import { DEPOSITS, NEAR_ARCHIVAL_RPC_URL } from '../config/near.config.js';
import { ValidationError } from '../util/validate.js';

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const UNITS_PER_CENT = 10n ** BigInt(DEPOSITS.usdcDecimals - 2);

const fail = (code, message) => {
  throw new ValidationError(code, message);
};

/** NEAR answers an unknown or garbage-collected hash with one of these. */
function isUnknownTransaction(error) {
  const cause = error?.cause;
  return cause?.name === 'UNKNOWN_TRANSACTION'
    || (cause?.name === 'TIMEOUT_ERROR' && cause.info?.cause === 'NOT_OBSERVED');
}

export function validateTxHash(raw) {
  if (typeof raw !== 'string' || !TX_HASH.test(raw)) fail('BAD_TX', 'That is not a NEAR transaction hash.');
  return raw;
}

/**
 * Resolves with `{ units, usdg }` for USDC that `accountId` sent to the
 * treasury in this transaction, or throws ValidationError.
 *
 * Checked per receipt, not per transaction: a MetaMask (NEP-518) transfer is
 * signed by a relayer and reaches USDC as a receipt from the player's wallet
 * contract. Every successful `ft_transfer` receipt on the USDC contract whose
 * predecessor is the player moved the player's own tokens, whoever relayed it.
 * `senderId` is the transaction signer, used only to look the transaction up.
 */
export async function verifyUsdcDeposit(
  { txHash, accountId, senderId = accountId },
  { rpc = nearRpc, deposits = DEPOSITS, archivalUrl = NEAR_ARCHIVAL_RPC_URL } = {},
) {
  // FINAL so a transfer can't be credited and then dropped.
  const lookup = (url) => rpc(
    'EXPERIMENTAL_tx_status',
    { tx_hash: txHash, sender_account_id: senderId, wait_until: 'FINAL' },
    { timeoutMs: 15_000, url },
  );
  // Regular nodes drop transactions after a few days, but the client retries
  // claims for 7, so an unknown hash may simply be old. For an old hash the main
  // node often holds the request until our timeout rather than saying so; an
  // archival node also has recent transactions, so either way it is asked next.
  let body = await lookup().catch(() => null);
  if ((!body || isUnknownTransaction(body.error)) && archivalUrl) {
    body = await lookup(archivalUrl).catch(() => body);
  }
  if (!body) fail('NEAR_UNAVAILABLE', 'Could not reach the NEAR network. Your deposit is safe; it will be checked again.');
  if (body?.error || !body?.result) {
    fail('TX_PENDING', 'That transaction is not final yet. It will be checked again.');
  }

  const { transaction, transaction_outcome: txOutcome, receipts = [], receipts_outcome: outcomes = [] } = body.result;
  const statusById = new Map(outcomes.map((entry) => [entry.id, entry.outcome?.status]));

  const calls = new Map(receipts.map((receipt) => [receipt.receipt_id, {
    predecessor: receipt.predecessor_id,
    receiver: receipt.receiver_id,
    actions: receipt.receipt?.Action?.actions ?? [],
  }]));
  // The transaction's own first receipt is not always in `receipts`.
  const firstId = txOutcome?.outcome?.receipt_ids?.[0];
  if (firstId && transaction && !calls.has(firstId)) {
    calls.set(firstId, { predecessor: transaction.signer_id, receiver: transaction.receiver_id, actions: transaction.actions ?? [] });
  }

  let units = 0n;
  for (const [id, call] of calls) {
    if (call.predecessor !== accountId || call.receiver !== deposits.usdcContract) continue;
    const status = statusById.get(id);
    if (!status || !('SuccessValue' in status)) continue;
    for (const action of call.actions) {
      const fn = action?.FunctionCall;
      if (fn?.method_name !== 'ft_transfer') continue;
      let args;
      try {
        args = JSON.parse(Buffer.from(fn.args, 'base64').toString('utf8'));
      } catch {
        continue;
      }
      if (args?.receiver_id === deposits.treasury && typeof args.amount === 'string' && /^\d{1,30}$/.test(args.amount)) {
        units += BigInt(args.amount);
      }
    }
  }

  if (units === 0n) fail('TX_NOT_DEPOSIT', 'That transaction has no USDC transfer from your account to the game treasury.');
  const cents = units / UNITS_PER_CENT;
  if (cents < 1n) fail('AMOUNT_INVALID', 'That transfer is less than one cent.');
  return { units: units.toString(), usdg: Number(cents) / 100 };
}

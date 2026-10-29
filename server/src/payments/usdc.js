/**
 * USDC deposits on NEAR.
 *
 * The player sends `ft_transfer` on the USDC contract to the treasury from
 * their own wallet, then hands us the transaction hash. We read the final
 * transaction from RPC and credit only what it actually moved. The client
 * never says how much; the chain does.
 */

import { nearRpc } from '../auth/near.js';
import { DEPOSITS } from '../config/near.config.js';
import { ValidationError } from '../util/validate.js';

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const UNITS_PER_CENT = 10n ** BigInt(DEPOSITS.usdcDecimals - 2);

const fail = (code, message) => {
  throw new ValidationError(code, message);
};

export function validateTxHash(raw) {
  if (typeof raw !== 'string' || !TX_HASH.test(raw)) fail('BAD_TX', 'That is not a NEAR transaction hash.');
  return raw;
}

/**
 * Resolves with `{ units, usdg }` for a final, successful USDC transfer from
 * `accountId` to the treasury, or throws ValidationError. `units` is the raw
 * token amount as a string, `usdg` is dollars rounded down to the cent.
 */
export async function verifyUsdcDeposit({ txHash, accountId }, { rpc = nearRpc, deposits = DEPOSITS } = {}) {
  let body;
  try {
    // FINAL so a transfer can't be credited and then dropped by a reorg.
    body = await rpc('tx', { tx_hash: txHash, sender_account_id: accountId, wait_until: 'FINAL' }, { timeoutMs: 20_000 });
  } catch {
    fail('NEAR_UNAVAILABLE', 'Could not reach the NEAR network. Your deposit is safe; it will be checked again.');
  }
  if (body?.error || !body?.result) {
    fail('TX_PENDING', 'That transaction is not final yet. It will be checked again.');
  }

  const { transaction, status } = body.result;
  if (transaction?.signer_id !== accountId) fail('TX_NOT_YOURS', 'That transaction was not sent from your account.');
  if (transaction.receiver_id !== deposits.usdcContract) fail('TX_NOT_USDC', 'That transaction is not a USDC transfer.');
  if (!status || !('SuccessValue' in status)) fail('TX_FAILED', 'That transfer failed on-chain.');

  const calls = (transaction.actions ?? []).map((action) => action?.FunctionCall);
  if (calls.length !== 1 || calls[0]?.method_name !== 'ft_transfer') {
    fail('TX_NOT_USDC', 'That transaction is not a single USDC transfer.');
  }

  let args;
  try {
    args = JSON.parse(Buffer.from(calls[0].args, 'base64').toString('utf8'));
  } catch {
    fail('TX_NOT_USDC', 'Could not read the transfer.');
  }
  if (args?.receiver_id !== deposits.treasury) fail('TX_WRONG_RECEIVER', 'That transfer did not go to the game treasury.');
  if (typeof args.amount !== 'string' || !/^\d{1,30}$/.test(args.amount)) fail('TX_NOT_USDC', 'Could not read the amount.');

  const units = BigInt(args.amount);
  const cents = units / UNITS_PER_CENT;
  if (cents < 1n) fail('AMOUNT_INVALID', 'That transfer is less than one cent.');
  return { units: args.amount, usdg: Number(cents) / 100 };
}

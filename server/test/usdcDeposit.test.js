/**
 * USDC deposit verification against hand-built RPC `tx` responses.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { validateTxHash, verifyUsdcDeposit } from '../src/payments/usdc.js';

const deposits = { usdcContract: 'usdc.testnet', usdcDecimals: 6, treasury: 'treasury.testnet' };
const TX = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';

function txResult({ signer = 'bob.testnet', receiver = 'usdc.testnet', method = 'ft_transfer', to = 'treasury.testnet', amount = '12345678', status = { SuccessValue: '' } } = {}) {
  const args = Buffer.from(JSON.stringify({ receiver_id: to, amount })).toString('base64');
  return {
    result: {
      status,
      transaction: { signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args, deposit: '1' } }] },
    },
  };
}

const check = (response, accountId = 'bob.testnet') =>
  verifyUsdcDeposit({ txHash: TX, accountId }, { rpc: async () => response, deposits });

describe('verifyUsdcDeposit', () => {
  it('credits the on-chain amount, rounded down to the cent', async () => {
    assert.deepEqual(await check(txResult()), { units: '12345678', usdg: 12.34 });
  });

  it('rejects transfers that are not ours to credit', async () => {
    await assert.rejects(check(txResult({ signer: 'eve.testnet' })), { code: 'TX_NOT_YOURS' });
    await assert.rejects(check(txResult({ receiver: 'fake-usdc.testnet' })), { code: 'TX_NOT_USDC' });
    await assert.rejects(check(txResult({ method: 'ft_transfer_call' })), { code: 'TX_NOT_USDC' });
    await assert.rejects(check(txResult({ to: 'eve.testnet' })), { code: 'TX_WRONG_RECEIVER' });
    await assert.rejects(check(txResult({ status: { Failure: {} } })), { code: 'TX_FAILED' });
    await assert.rejects(check(txResult({ amount: '9999' })), { code: 'AMOUNT_INVALID' });
  });

  it('reports a transaction that is not final or an RPC outage as retryable', async () => {
    await assert.rejects(check({ error: { name: 'HANDLER_ERROR' } }), { code: 'TX_PENDING' });
    const down = verifyUsdcDeposit({ txHash: TX, accountId: 'bob.testnet' }, { rpc: async () => { throw new Error('timeout'); }, deposits });
    await assert.rejects(down, { code: 'NEAR_UNAVAILABLE' });
  });

  it('validates the hash shape', () => {
    assert.equal(validateTxHash(TX), TX);
    assert.throws(() => validateTxHash('0xdeadbeef'), { code: 'BAD_TX' });
  });
});

describe('deposit mode', () => {
  // Read once at import, so each case runs in its own process.
  const modeWith = (env) => execFileSync(process.execPath, [
    '--input-type=module', '-e',
    "const { DEPOSITS } = await import('./src/config/near.config.js'); process.stdout.write(DEPOSITS.mode);",
  ], { env: { PATH: process.env.PATH, ...env } }).toString();

  it('is off unless a treasury is set or fake deposits are asked for', () => {
    assert.equal(modeWith({}), 'off');
    assert.equal(modeWith({ NEAR_TREASURY_ACCOUNT: 'treasury.testnet' }), 'chain');
    assert.equal(modeWith({ ALLOW_FAKE_DEPOSITS: 'true' }), 'fake');
  });

  it('never fakes deposits in production', () => {
    assert.equal(modeWith({ ALLOW_FAKE_DEPOSITS: 'true', NODE_ENV: 'production' }), 'off');
  });
});


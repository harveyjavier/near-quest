/**
 * USDC deposit verification against hand-built EXPERIMENTAL_tx_status results.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { validateTxHash, verifyUsdcDeposit } from '../src/payments/usdc.js';

const deposits = { usdcContract: 'usdc.testnet', usdcDecimals: 6, treasury: 'treasury.testnet' };
const TX = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
const ok = { SuccessValue: '' };

const transfer = (to = 'treasury.testnet', amount = '12345678', method = 'ft_transfer') => ({
  FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify({ receiver_id: to, amount })).toString('base64'), deposit: '1' },
});

/** A wallet-signed transfer: the transaction itself is the ft_transfer. */
function direct({ signer = 'bob.testnet', receiver = 'usdc.testnet', action = transfer(), status = ok } = {}) {
  return {
    result: {
      transaction: { signer_id: signer, receiver_id: receiver, actions: [action] },
      transaction_outcome: { outcome: { receipt_ids: ['r1'] } },
      receipts: [],
      receipts_outcome: [{ id: 'r1', outcome: { status } }],
    },
  };
}

/** A MetaMask (NEP-518) transfer: a relayer calls rlp_execute, the wallet contract calls USDC. */
function relayed({ predecessor = '0xabc0000000000000000000000000000000000001', status = ok } = {}) {
  return {
    result: {
      transaction: { signer_id: 'relayer.testnet', receiver_id: predecessor, actions: [{ FunctionCall: { method_name: 'rlp_execute', args: '' } }] },
      transaction_outcome: { outcome: { receipt_ids: ['r1'] } },
      receipts: [
        { receipt_id: 'r2', predecessor_id: predecessor, receiver_id: 'usdc.testnet', receipt: { Action: { actions: [transfer()] } } },
      ],
      receipts_outcome: [{ id: 'r1', outcome: { status: ok } }, { id: 'r2', outcome: { status } }],
    },
  };
}

const check = (response, accountId = 'bob.testnet') =>
  verifyUsdcDeposit({ txHash: TX, accountId }, { rpc: async () => response, deposits });

describe('verifyUsdcDeposit', () => {
  it('credits a direct transfer, rounded down to the cent', async () => {
    assert.deepEqual(await check(direct()), { units: '12345678', usdg: 12.34 });
  });

  it('credits a relayed MetaMask transfer from the player wallet contract', async () => {
    const eth = '0xabc0000000000000000000000000000000000001';
    assert.deepEqual(await check(relayed(), eth), { units: '12345678', usdg: 12.34 });
  });

  it('rejects anything that did not move the player\'s USDC to the treasury', async () => {
    const none = { code: 'TX_NOT_DEPOSIT' };
    await assert.rejects(check(direct({ signer: 'eve.testnet' })), none);
    await assert.rejects(check(direct({ receiver: 'fake-usdc.testnet' })), none);
    await assert.rejects(check(direct({ action: transfer('treasury.testnet', '1', 'ft_transfer_call') })), none);
    await assert.rejects(check(direct({ action: transfer('eve.testnet') })), none);
    await assert.rejects(check(direct({ status: { Failure: {} } })), none);
    await assert.rejects(check(relayed({ status: { Failure: {} } }), '0xabc0000000000000000000000000000000000001'), none);
    await assert.rejects(check(relayed(), 'bob.testnet'), none);
    await assert.rejects(check(direct({ action: transfer('treasury.testnet', '9999') })), { code: 'AMOUNT_INVALID' });
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

describe('verifyUsdcDeposit against a real testnet response', () => {
  // EXPERIMENTAL_tx_status for testnet tx F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84,
  // captured from archival-rpc.testnet.near.org. A relayed transfer: near-stocks-seq
  // signs, the near-stocks contract then calls ft_transfer on Circle's testnet
  // USDC, sending 4.5 USDC to near-stocks-user1.
  const real = JSON.parse(readFileSync(new URL('./fixtures/testnet-usdc-ft_transfer.json', import.meta.url)));
  const testnet = {
    usdcContract: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    usdcDecimals: 6,
    treasury: 'near-stocks-user1.testnet',
  };
  const verify = (accountId, deposit = testnet) => verifyUsdcDeposit(
    { txHash: 'F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84', accountId, senderId: 'near-stocks-seq.testnet' },
    { rpc: async () => real, deposits: deposit },
  );

  it('credits the account whose tokens moved', async () => {
    assert.deepEqual(await verify('near-stocks.testnet'), { units: '4500000', usdg: 4.5 });
  });

  it('asks the archival RPC when the main RPC has forgotten the transaction', async () => {
    // What rpc.testnet.near.org actually answered for this hash once it aged out.
    const forgotten = { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR', info: { cause: 'NOT_OBSERVED' } } } };
    const asked = [];
    const rpc = async (method, params, { url } = {}) => {
      asked.push(url ?? 'main');
      return url === 'https://archive.example' ? real : forgotten;
    };
    const result = await verifyUsdcDeposit(
      { txHash: 'F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84', accountId: 'near-stocks.testnet', senderId: 'near-stocks-seq.testnet' },
      { rpc, deposits: testnet, archivalUrl: 'https://archive.example' },
    );
    assert.deepEqual(result, { units: '4500000', usdg: 4.5 });
    assert.deepEqual(asked, ['main', 'https://archive.example']);
  });

  it('asks the archival RPC when the main RPC times out on an old hash', async () => {
    const rpc = async (method, params, { url } = {}) => {
      if (url !== 'https://archive.example') throw new Error('The operation was aborted due to timeout');
      return real;
    };
    const result = await verifyUsdcDeposit(
      { txHash: 'F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84', accountId: 'near-stocks.testnet', senderId: 'near-stocks-seq.testnet' },
      { rpc, deposits: testnet, archivalUrl: 'https://archive.example' },
    );
    assert.deepEqual(result, { units: '4500000', usdg: 4.5 });
  });

  it('does not touch the archival RPC when the main one has the transaction', async () => {
    const asked = [];
    const rpc = async (method, params, { url } = {}) => { asked.push(url ?? 'main'); return real; };
    await verifyUsdcDeposit(
      { txHash: 'F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84', accountId: 'near-stocks.testnet', senderId: 'near-stocks-seq.testnet' },
      { rpc, deposits: testnet, archivalUrl: 'https://archive.example' },
    );
    assert.deepEqual(asked, ['main']);
  });

  it('gives nothing to the relayer that signed, or to a different treasury', async () => {
    await assert.rejects(verify('near-stocks-seq.testnet'), { code: 'TX_NOT_DEPOSIT' });
    await assert.rejects(verify('near-stocks.testnet', { ...testnet, treasury: 'treasury.testnet' }), { code: 'TX_NOT_DEPOSIT' });
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


/**
 * NEAR wallet sign-in: signs a real NEP-413 payload with a throwaway ed25519
 * key and stubs only the chain lookup.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { before, describe, it } from 'node:test';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, WALLET_SESSION_TTL_MS, assertAuthRate, issueNonce, nep413Hash, signInWithNear,
  ethSignInMessage, signInWithEthereum, signOutNear, verifyEthSignIn, verifyNearSignIn,
} from '../src/auth/near.js';
import { connectDatabase, createPlayerRecord, getRepo } from '../src/db/repo.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (value > 0n) { out = B58[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY = `ed25519:${base58(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'))}`;
const fullAccess = { fetchAccessKey: async () => ({ permission: 'FullAccess' }) };

function signedBody(accountId, extra = {}) {
  const nonce = issueNonce();
  const hash = nep413Hash({
    message: SIGN_IN_MESSAGE, nonce: Buffer.from(nonce, 'base64'), recipient: SIGN_IN_RECIPIENT, callbackUrl: extra.callbackUrl ?? null,
  });
  return { accountId, publicKey: PUBLIC_KEY, nonce, signature: sign(null, hash, privateKey).toString('base64'), ...extra };
}

describe('verifyNearSignIn', () => {
  it('accepts a valid signature from a full-access key', async () => {
    assert.equal(await verifyNearSignIn(signedBody('alice.testnet'), fullAccess), 'alice.testnet');
  });

  it('rejects a forged signature', async () => {
    const body = { ...signedBody('alice.testnet'), signature: Buffer.alloc(64).toString('base64') };
    await assert.rejects(verifyNearSignIn(body, fullAccess), { code: 'BAD_SIGNATURE' });
  });

  it('rejects a key the account does not hold with full access', async () => {
    const functionCall = { fetchAccessKey: async () => ({ permission: { FunctionCall: {} } }) };
    await assert.rejects(verifyNearSignIn(signedBody('alice.testnet'), functionCall), { code: 'KEY_NOT_OWNED' });
    await assert.rejects(verifyNearSignIn(signedBody('alice.testnet'), { fetchAccessKey: async () => null }), { code: 'KEY_NOT_OWNED' });
  });

  it('accepts a payload that includes the callbackUrl (MyNearWallet)', async () => {
    const body = signedBody('alice.testnet', { callbackUrl: 'https://game.example/' });
    assert.equal(await verifyNearSignIn(body, fullAccess), 'alice.testnet');
  });

  it('reports an unreachable RPC distinctly', async () => {
    const down = { fetchAccessKey: async () => { throw new Error('ECONNRESET'); } };
    await assert.rejects(verifyNearSignIn(signedBody('alice.testnet'), down), { code: 'NEAR_UNAVAILABLE' });
  });

  it('rejects an expired nonce', async () => {
    await assert.rejects(verifyNearSignIn(signedBody('alice.testnet'), { ...fullAccess, now: Date.now() + 6 * 60_000 }), { code: 'BAD_NONCE' });
  });
});

const ethAccount = privateKeyToAccount(generatePrivateKey());
const ETH_ADDRESS = ethAccount.address.toLowerCase();

async function ethBody(address = ETH_ADDRESS, signer = ethAccount) {
  const nonce = issueNonce();
  const signature = await signer.signMessage({ message: ethSignInMessage({ address, nonce }) });
  return { address, nonce, signature };
}

describe('verifyEthSignIn', () => {
  it('accepts a personal_sign from the address it names', async () => {
    assert.equal(await verifyEthSignIn(await ethBody()), ETH_ADDRESS);
  });

  it('rejects a signature from a different key', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(verifyEthSignIn(await ethBody(ETH_ADDRESS, other)), { code: 'BAD_SIGNATURE' });
  });

  it('rejects a replayed nonce', async () => {
    const body = await ethBody();
    await verifyEthSignIn(body);
    await assert.rejects(verifyEthSignIn(body), { code: 'BAD_NONCE' });
  });

  it('rejects mixed-case and banned addresses', async () => {
    await assert.rejects(verifyEthSignIn({ ...(await ethBody()), address: ethAccount.address }), { code: 'BAD_ACCOUNT' });
    const banned = '0x0048501436e6325eff9756d804160dce4aaf3f3f';
    await assert.rejects(verifyEthSignIn(await ethBody(banned)), { code: 'BANNED_ADDRESS' });
  });
});

describe('assertAuthRate', () => {
  it('allows 20 requests per IP per minute', () => {
    for (let i = 0; i < 20; i += 1) assertAuthRate('203.0.113.9', 1000);
    assert.throws(() => assertAuthRate('203.0.113.9', 1000), { code: 'RATE_LIMITED' });
    assert.doesNotThrow(() => assertAuthRate('203.0.113.10', 1000));
    assert.doesNotThrow(() => assertAuthRate('203.0.113.9', 61_000));
  });
});

describe('signInWithNear', () => {
  before(() => connectDatabase({ mongoUrl: '', allowMemory: true }));

  it('binds the guest save and rotates its token on every sign-in', async () => {
    const guest = createPlayerRecord('Guesty');
    await getRepo().insertPlayer(guest);
    const released = [];
    const options = { ...fullAccess, releaseSession: async (token) => { released.push(token); } };

    const first = await signInWithNear(signedBody('bob.testnet', { sessionToken: guest.sessionToken }), options);
    assert.notEqual(first.sessionToken, guest.sessionToken);
    assert.equal(first.source, 'guest');
    assert.deepEqual(released, [guest.sessionToken]);
    assert.equal(await getRepo().findPlayerByToken(guest.sessionToken), null);

    // A stale room flush under the old token must neither resurrect it nor drop the binding.
    await getRepo().savePlayer({ ...guest, gold: 5 });
    assert.equal(await getRepo().findPlayerByToken(guest.sessionToken), null);

    const again = await signInWithNear(signedBody('bob.testnet'), options);
    assert.notEqual(again.sessionToken, first.sessionToken);
    assert.equal(again.source, 'existing');
    assert.equal(await getRepo().findPlayerByToken(first.sessionToken), null);
    const current = await getRepo().findPlayerByToken(again.sessionToken);
    assert.equal(current.nearAccountId, 'bob.testnet');
    assert.ok(Math.abs(current.sessionExpiresAt - (Date.now() + WALLET_SESSION_TTL_MS)) < 5000);
  });

  it('never rebinds a save that already belongs to another wallet', async () => {
    const owned = await getRepo().findPlayerByNearAccount('bob.testnet');
    const result = await signInWithNear(signedBody('carol.testnet', { sessionToken: owned.sessionToken, displayName: 'Carol' }), fullAccess);
    assert.notEqual(result.sessionToken, owned.sessionToken);
    assert.equal(result.displayName, 'Carol');
    assert.equal(result.source, 'new');
    assert.equal((await getRepo().findPlayerByNearAccount('bob.testnet')).sessionToken, owned.sessionToken);
  });

  it('a nonce is spent by a sign-in that commits, so it cannot be replayed', async () => {
    const body = signedBody('erin.testnet');
    await signInWithNear(body, fullAccess);
    await assert.rejects(signInWithNear(body, fullAccess), { code: 'BAD_NONCE' });
  });

  it('asks before leaving a guest save behind, without rotating anything', async () => {
    const owned = await signInWithNear(signedBody('frank.testnet'), fullAccess);
    const guest = createPlayerRecord('Leftbehind');
    await getRepo().insertPlayer(guest);
    const released = [];
    const options = { ...fullAccess, releaseSession: async (t) => { released.push(t); } };

    const body = signedBody('frank.testnet', { sessionToken: guest.sessionToken });
    await assert.rejects(signInWithNear(body, options), (error) => {
      assert.equal(error.code, 'SWITCH_REQUIRED');
      assert.deepEqual(error.details, { accountId: 'frank.testnet', displayName: owned.displayName });
      return true;
    });
    // Nothing moved: the wallet's token still works, nobody was kicked, the guest is untouched.
    assert.deepEqual(released, []);
    assert.ok(await getRepo().findPlayerByToken(owned.sessionToken));
    assert.equal((await getRepo().findPlayerByToken(guest.sessionToken)).nearAccountId, undefined);

    // Confirming resends the same signature; the nonce was not spent by the refusal.
    const confirmed = await signInWithNear({ ...body, allowSwitch: true }, options);
    assert.equal(confirmed.source, 'existing');
    assert.deepEqual(released, [owned.sessionToken]);
    assert.ok(await getRepo().findPlayerByToken(guest.sessionToken), 'the guest save is left as it was');
  });

  it('sign-out kills a wallet token but never a guest token', async () => {
    const { sessionToken } = await signInWithNear(signedBody('dave.testnet'), fullAccess);
    const released = [];
    await signOutNear(sessionToken, { releaseSession: async (t) => { released.push(t); } });
    assert.deepEqual(released, [sessionToken]);
    assert.equal(await getRepo().findPlayerByToken(sessionToken), null);
    assert.equal((await getRepo().findPlayerByNearAccount('dave.testnet')).sessionExpiresAt, 0);

    const guest = createPlayerRecord('Stays');
    await getRepo().insertPlayer(guest);
    await signOutNear(guest.sessionToken);
    assert.ok(await getRepo().findPlayerByToken(guest.sessionToken));
  });

  it('MetaMask sign-in binds the eth-implicit account like any wallet', async () => {
    const guest = createPlayerRecord('Metamasker');
    await getRepo().insertPlayer(guest);
    const result = await signInWithEthereum({ ...(await ethBody()), sessionToken: guest.sessionToken });
    assert.equal(result.source, 'guest');
    assert.equal(result.accountId, ETH_ADDRESS);
    assert.equal((await getRepo().findPlayerByToken(result.sessionToken)).nearAccountId, ETH_ADDRESS);
  });
});

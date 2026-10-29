/**
 * NEAR wallet sign-in (NEP-413).
 *
 * The wallet signs a server-issued one-time nonce; we check the ed25519
 * signature, then ask the chain whether that key is a full-access key of the
 * claimed account. Nothing goes on-chain and no transaction is sent: this
 * only proves "whoever is at this browser controls that account".
 *
 * The result is the same opaque sessionToken guests already use, so the room
 * join path does not change at all.
 */

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

import { createPlayerRecord, getRepo } from '../db/repo.js';
import { log } from '../util/logger.js';
import { token } from '../util/rng.js';
import { ValidationError, coerceDisplayName, isValidSessionToken } from '../util/validate.js';

export const NEAR_NETWORK = process.env.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || `https://rpc.${NEAR_NETWORK}.near.org`;

/** Shown in the wallet's signing prompt; must match what the client signs. */
export const SIGN_IN_MESSAGE = "Sign in to Robin's Club";
export const SIGN_IN_RECIPIENT = process.env.NEAR_AUTH_RECIPIENT || 'robins-club';

const NONCE_TTL_MS = 5 * 60_000;
/** Wallet sessions end after this and need a fresh signature. Guests never expire: they have no way back in. */
export const WALLET_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
// Unauthenticated endpoint issues these, so the map is capped.
const MAX_PENDING_NONCES = 10_000;
const NEP413_TAG = 2 ** 31 + 413;

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** base64 nonce -> expiresAt */
const pending = new Map();

const AUTH_WINDOW_MS = 60_000;
const AUTH_REQUESTS_PER_WINDOW = 20;
/** ip -> { windowStart, count } */
const authRate = new Map();

/** Per-IP cap on both auth endpoints, so one client cannot exhaust the nonce pool or the RPC. */
export function assertAuthRate(ip, now = Date.now()) {
  if (authRate.size > 50_000) {
    for (const [key, entry] of authRate) if (now - entry.windowStart >= AUTH_WINDOW_MS) authRate.delete(key);
  }
  const entry = authRate.get(ip);
  if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
    authRate.set(ip, { windowStart: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > AUTH_REQUESTS_PER_WINDOW) {
    throw new ValidationError('RATE_LIMITED', 'Too many sign-in attempts. Wait a minute.');
  }
}

export function issueNonce(now = Date.now()) {
  if (pending.size >= MAX_PENDING_NONCES) {
    for (const [nonce, expiresAt] of pending) if (expiresAt <= now) pending.delete(nonce);
    if (pending.size >= MAX_PENDING_NONCES) throw new ValidationError('BUSY', 'Too many sign-ins in progress.');
  }
  const nonce = randomBytes(32).toString('base64');
  pending.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

function nonceIsLive(nonce, now) {
  return pending.get(nonce) > now;
}

/**
 * Spends a nonce. Only done once a session is actually issued, so a sign-in
 * refused with SWITCH_REQUIRED can be confirmed without signing again. Check
 * and delete happen in one synchronous step, so two requests can't both win.
 */
function consumeNonce(nonce, now) {
  const live = nonceIsLive(nonce, now);
  pending.delete(nonce);
  return live;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(text) {
  let value = 0n;
  for (const char of text) {
    const digit = B58.indexOf(char);
    if (digit < 0) throw new ValidationError('BAD_SIGNATURE', 'Malformed public key.');
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16);
  const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const leadingZeros = text.length - text.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(leadingZeros), value === 0n ? Buffer.alloc(0) : bytes]);
}

function borshString(text) {
  const bytes = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** sha256 of the borsh-serialised NEP-413 payload -- the bytes the wallet signs. */
export function nep413Hash({ message, nonce, recipient, callbackUrl = null }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  return createHash('sha256').update(Buffer.concat([
    tag,
    borshString(message),
    nonce,
    borshString(recipient),
    callbackUrl === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]),
  ])).digest();
}

/** One JSON-RPC call. Resolves with `{ result, error }` as NEAR returns them. */
export async function nearRpc(method, params) {
  const response = await fetch(NEAR_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'game', method, params }),
    signal: AbortSignal.timeout(8000),
  });
  return response.json();
}

async function rpcAccessKey(accountId, publicKey) {
  const { result } = await nearRpc('query', {
    request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey,
  });
  return result ?? null;
}

/**
 * Resolves with the verified accountId, or throws ValidationError.
 * `fetchAccessKey` is injectable so tests never touch the network.
 */
export async function verifyNearSignIn(body, { fetchAccessKey = rpcAccessKey, now = Date.now() } = {}) {
  const { accountId, publicKey, signature, nonce, callbackUrl = null } = body ?? {};
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
    throw new ValidationError('BAD_ACCOUNT', 'Invalid NEAR account id.');
  }
  if (typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:')) {
    throw new ValidationError('BAD_SIGNATURE', 'Only ed25519 keys are supported.');
  }
  if (typeof signature !== 'string' || typeof nonce !== 'string') {
    throw new ValidationError('BAD_SIGNATURE', 'Missing signature.');
  }
  if (callbackUrl !== null && (typeof callbackUrl !== 'string' || callbackUrl.length > 2048)) {
    throw new ValidationError('BAD_SIGNATURE', 'Invalid callback URL.');
  }
  if (!nonceIsLive(nonce, now)) {
    throw new ValidationError('BAD_NONCE', 'Sign-in expired. Please try again.');
  }

  const rawKey = base58Decode(publicKey.slice('ed25519:'.length));
  if (rawKey.length !== 32) throw new ValidationError('BAD_SIGNATURE', 'Malformed public key.');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') }, format: 'jwk' });

  // Some wallets (MyNearWallet) fold the page URL into the payload, others sign None.
  const payload = { message: SIGN_IN_MESSAGE, nonce: Buffer.from(nonce, 'base64'), recipient: SIGN_IN_RECIPIENT };
  const signatureBytes = Buffer.from(signature, 'base64');
  const signedBy = (url) => verify(null, nep413Hash({ ...payload, callbackUrl: url }), key, signatureBytes);
  if (!signedBy(null) && (callbackUrl === null || !signedBy(callbackUrl))) {
    throw new ValidationError('BAD_SIGNATURE', 'Signature does not match.');
  }

  // A function-call key can be minted by any dapp the user once approved, so
  // only a full-access key proves control of the account.
  let accessKey;
  try {
    accessKey = await fetchAccessKey(accountId, publicKey);
  } catch (error) {
    log.warn('NEAR RPC lookup failed:', error.message);
    throw new ValidationError('NEAR_UNAVAILABLE', 'Could not reach the NEAR network. Try again in a moment.');
  }
  if (accessKey?.permission !== 'FullAccess') {
    throw new ValidationError('KEY_NOT_OWNED', 'That key does not control this account.');
  }
  return accountId;
}

/**
 * Verified wallet -> a fresh sessionToken to play as.
 *
 * 1. The wallet already owns a player: that one, wherever it was made.
 * 2. Otherwise the guest save on this device (if unbound) is bound to it.
 * 3. Otherwise a fresh player is created for the wallet.
 * `source` says which, so the client can warn before leaving a guest save behind.
 *
 * Every sign-in rotates the token, so any earlier copy of it (another device,
 * a leaked localStorage) stops working. `releaseSession` saves and evicts a
 * live seat on the old token first, so the room never writes back under it.
 */
/** Refused before anything changes, so the player can still say no. */
function switchRequired(player) {
  const error = new ValidationError('SWITCH_REQUIRED', 'This wallet already has a save.');
  error.details = { accountId: player.nearAccountId, displayName: player.displayName };
  return error;
}

export async function signInWithNear(body, { releaseSession = async () => {}, ...options } = {}) {
  const now = options.now ?? Date.now();
  const sessionExpiresAt = now + WALLET_SESSION_TTL_MS;
  const accountId = await verifyNearSignIn(body, options);
  const repo = getRepo();

  let player = await repo.findPlayerByNearAccount(accountId);

  // The wallet owns a save and this device holds a different, unbound guest
  // save: switching would leave the guest behind, so ask first.
  if (player && body.allowSwitch !== true && isValidSessionToken(body.sessionToken)
      && body.sessionToken !== player.sessionToken) {
    const guest = await repo.findPlayerByToken(body.sessionToken);
    if (guest && !guest.nearAccountId) throw switchRequired(player);
  }

  // Everything above is read-only. From here on the sign-in commits.
  if (!consumeNonce(body.nonce, options.now ?? Date.now())) {
    throw new ValidationError('BAD_NONCE', 'Sign-in expired. Please try again.');
  }

  let source = 'existing';
  if (!player && isValidSessionToken(body.sessionToken) && await repo.bindNearAccount(body.sessionToken, accountId)) {
    player = await repo.findPlayerByToken(body.sessionToken);
    source = 'guest';
    log.info(`Bound guest "${player.displayName}" to ${accountId}.`);
  }

  if (!player) {
    const record = {
      ...createPlayerRecord(coerceDisplayName(body.displayName, accountId.slice(0, 4))),
      nearAccountId: accountId,
      sessionExpiresAt,
    };
    await repo.insertPlayer(record);
    log.info(`New wallet player "${record.displayName}" for ${accountId}.`);
    return { sessionToken: record.sessionToken, displayName: record.displayName, accountId, source: 'new' };
  }

  await releaseSession(player.sessionToken);
  const sessionToken = token(32);
  if (!await repo.rotateSessionToken(player.sessionToken, sessionToken, sessionExpiresAt)) {
    throw new ValidationError('BUSY', 'Sign-in raced another sign-in. Try again.');
  }
  return { sessionToken, displayName: player.displayName, accountId, source };
}

/**
 * Ends a wallet session on the server: the token is replaced by one nobody
 * holds. Guest tokens are left alone, since revoking one would delete the save.
 * Answers the same either way so it can't be used to probe tokens.
 */
export async function signOutNear(sessionToken, { releaseSession = async () => {} } = {}) {
  if (!isValidSessionToken(sessionToken)) return;
  const player = await getRepo().findPlayerByToken(sessionToken);
  if (!player?.nearAccountId) return;
  await releaseSession(sessionToken);
  await getRepo().rotateSessionToken(sessionToken, token(32), 0);
  log.info(`Signed out ${player.nearAccountId}.`);
}

/**
 * NEAR wallet sign-in.
 *
 * The wallet signs a one-time server challenge (NEP-413, no transaction, no
 * gas); the server verifies it and answers with the sessionToken to play as.
 * Loaded on demand from main.js so guests never download the wallet code.
 */

import { Buffer } from 'buffer';

import { SERVER_URL } from '../config.js';

// The wallet selector reads Node's Buffer as a global.
globalThis.Buffer ??= Buffer;

const HTTP_URL = SERVER_URL.replace(/^ws/, 'http');

let selectorPromise = null;

async function getSelector(network) {
  selectorPromise ??= (async () => {
    const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupHereWallet }, { setupMyNearWallet }] = await Promise.all([
      import('@near-wallet-selector/core'),
      import('@near-wallet-selector/modal-ui'),
      import('@near-wallet-selector/meteor-wallet'),
      import('@near-wallet-selector/here-wallet'),
      import('@near-wallet-selector/my-near-wallet'),
      import('@near-wallet-selector/modal-ui/styles.css'),
    ]);
    const selector = await setupWalletSelector({
      network,
      modules: [setupMeteorWallet(), setupHereWallet(), setupMyNearWallet()],
    });
    return { selector, modal: setupModal(selector, {}) };
  })();
  return selectorPromise;
}

/** Opens the wallet picker unless a wallet is already connected. */
function connectWallet({ selector, modal }) {
  if (selector.isSignedIn()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const signedIn = selector.on('signedIn', () => { cleanup(); resolve(); });
    const hidden = modal.on('onHide', ({ hideReason }) => {
      if (hideReason === 'user-triggered') { cleanup(); reject(new Error('Wallet connection cancelled.')); }
    });
    const cleanup = () => { signedIn.remove(); hidden.remove(); };
    modal.show();
  });
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Sign-in failed (${response.status}).`);
  return body;
}

/**
 * Posts a signed sign-in. When the wallet already owns a different save than
 * this device's guest, the server refuses without changing anything; this
 * resolves with `{ switchRequired, accountId, displayName, confirm }` and
 * `confirm()` resends the same signature with permission to switch.
 */
async function submitSignIn(path, body) {
  const response = await fetch(`${HTTP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.clone().json().catch(() => ({}));
  if (response.status === 409 && result.code === 'SWITCH_REQUIRED') {
    return {
      switchRequired: true,
      accountId: result.accountId,
      displayName: result.displayName,
      confirm: () => submitSignIn(path, { ...body, allowSwitch: true }),
    };
  }
  return readJson(response);
}

/**
 * Resolves with `{ sessionToken, displayName, accountId }`. The guest token, if
 * any, is sent so a first wallet sign-in keeps this device's progress.
 */
export async function signInWithNear({ sessionToken, displayName }) {
  const challenge = await readJson(await fetch(`${HTTP_URL}/auth/near/challenge`));
  const wallets = await getSelector(challenge.network);
  await connectWallet(wallets);

  const wallet = await wallets.selector.wallet();
  // Passed explicitly so the server hashes exactly the URL a wallet may fold into the payload.
  const callbackUrl = `${window.location.origin}${window.location.pathname}`;
  let signed;
  try {
    signed = await wallet.signMessage({
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: Buffer.from(challenge.nonce, 'base64'),
      callbackUrl,
    });
  } finally {
    // We only need the one signature; disconnecting lets the next sign-in pick another account.
    await wallet.signOut().catch(() => {});
  }
  if (!signed?.signature) throw new Error('The wallet did not return a signature.');

  return submitSignIn('/auth/near', {
    accountId: signed.accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    nonce: challenge.nonce,
    callbackUrl,
    sessionToken,
    displayName,
  });
}

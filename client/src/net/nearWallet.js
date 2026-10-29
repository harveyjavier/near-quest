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

/** NEAR's Ethereum-compatible RPC, which MetaMask talks to. */
const NEAR_EVM_CHAINS = {
  mainnet: {
    id: 397,
    name: 'NEAR Protocol',
    nativeCurrency: { decimals: 18, name: 'NEAR', symbol: 'NEAR' },
    rpcUrls: { default: { http: ['https://eth-rpc.mainnet.near.org'] } },
    blockExplorers: { default: { name: 'NEAR Explorer', url: 'https://eth-explorer.near.org' } },
  },
  testnet: {
    id: 398,
    name: 'NEAR Protocol Testnet',
    nativeCurrency: { decimals: 18, name: 'NEAR', symbol: 'NEAR' },
    rpcUrls: { default: { http: ['https://eth-rpc.testnet.near.org'] } },
    blockExplorers: { default: { name: 'NEAR Explorer', url: 'https://eth-explorer-testnet.near.org' } },
    testnet: true,
  },
};

async function getSelector(network) {
  selectorPromise ??= (async () => {
    const [
      { setupWalletSelector, actionCreators }, { setupModal }, { setupMeteorWallet }, { setupHereWallet },
      { setupMyNearWallet }, { setupEthereumWallets }, wagmi, { defineChain },
    ] = await Promise.all([
      import('@near-wallet-selector/core'),
      import('@near-wallet-selector/modal-ui'),
      import('@near-wallet-selector/meteor-wallet'),
      import('@near-wallet-selector/here-wallet'),
      import('@near-wallet-selector/my-near-wallet'),
      import('@near-wallet-selector/ethereum-wallets'),
      import('@wagmi/core'),
      import('viem'),
      import('@near-wallet-selector/modal-ui/styles.css'),
    ]);
    const chain = defineChain(NEAR_EVM_CHAINS[network]);
    const wagmiConfig = wagmi.createConfig({
      chains: [chain],
      transports: { [chain.id]: wagmi.http() },
      connectors: [wagmi.injected({ shimDisconnect: true })],
    });
    const selector = await setupWalletSelector({
      network,
      modules: [
        setupMeteorWallet(), setupHereWallet(), setupMyNearWallet(),
        // MetaMask and other injected Ethereum wallets, on NEAR's EVM-compatible RPC (NEP-518).
        setupEthereumWallets({ wagmiConfig, wagmiCore: wagmi, skipSignInAccessKey: true }),
      ],
    });
    return { selector, modal: setupModal(selector, {}), actionCreators };
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

/** Revokes a wallet session on the server. Best effort: local sign-out happens regardless. */
export async function signOutNear(sessionToken) {
  await fetch(`${HTTP_URL}/auth/signout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  }).catch(() => {});
}

/**
 * Sends `usdg` dollars of USDC from the player's wallet to the treasury and
 * resolves with the transaction hash. The server credits it from the chain.
 * The connected wallet must be the account this save is bound to.
 */
export async function sendUsdcDeposit({ deposits, accountId, usdg }) {
  const wallets = await getSelector(deposits.network);
  await connectWallet(wallets);
  let wallet = await wallets.selector.wallet();

  const [connected] = await wallet.getAccounts();
  if (connected?.accountId !== accountId) {
    await wallet.signOut().catch(() => {});
    await connectWallet(wallets);
    wallet = await wallets.selector.wallet();
    const [retry] = await wallet.getAccounts();
    if (retry?.accountId !== accountId) throw new Error(`Connect ${accountId} to deposit into this save.`);
  }

  // Whole cents in, token units out: 1 cent = 10^(decimals - 2) units.
  const units = BigInt(Math.round(usdg * 100)) * 10n ** BigInt(deposits.usdcDecimals - 2);
  const outcome = await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: deposits.usdcContract,
    actions: [wallets.actionCreators.functionCall(
      'ft_transfer',
      { receiver_id: deposits.treasury, amount: units.toString(), memo: 'deposit' },
      30_000_000_000_000n,
      1n, // ft_transfer requires exactly 1 yoctoNEAR
    )],
  });
  const txHash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
  if (!txHash) throw new Error('The wallet did not return a transaction.');
  // MetaMask transfers are signed by a relayer; the server needs it to look the transaction up.
  return { txHash, senderId: outcome.transaction?.signer_id ?? accountId };
}

/** Hex-encodes UTF-8 text for personal_sign. */
export function utf8ToHex(text) {
  return `0x${[...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * MetaMask sign-in. MetaMask can't sign NEP-413, so it signs the server's
 * challenge text with personal_sign; the server recovers the address, which is
 * also the player's NEAR account id (an eth-implicit account).
 */
export async function signInWithMetaMask({ sessionToken, displayName }) {
  const { ethereum } = window;
  if (!ethereum?.request) throw new Error('MetaMask is not installed in this browser.');

  const [address] = await ethereum.request({ method: 'eth_requestAccounts' });
  if (!address) throw new Error('MetaMask did not share an account.');
  const accountId = address.toLowerCase();

  const challenge = await readJson(await fetch(`${HTTP_URL}/auth/near/challenge?address=${accountId}`));
  if (!challenge.ethMessage) throw new Error('The server did not send a sign-in message.');
  const signature = await ethereum.request({ method: 'personal_sign', params: [utf8ToHex(challenge.ethMessage), address] });

  return submitSignIn('/auth/eth', { address: accountId, nonce: challenge.nonce, signature, sessionToken, displayName });
}

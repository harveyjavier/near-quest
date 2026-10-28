/**
 * NEAR network settings, read once from the environment.
 *
 * Deposits are on-chain only when NEAR_TREASURY_ACCOUNT is set. Without it the
 * fake deposit (credits USDG for nothing) works only if ALLOW_FAKE_DEPOSITS is
 * "true", which is meant for local development.
 */

export const NEAR_NETWORK = process.env.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
export const NEAR_RPC_URL = process.env.NEAR_RPC_URL || `https://rpc.${NEAR_NETWORK}.near.org`;

/** Circle's native USDC on NEAR. Check against Circle's docs before going live. */
const USDC_CONTRACTS = {
  mainnet: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  testnet: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
};

const treasury = (process.env.NEAR_TREASURY_ACCOUNT || '').trim();

export const DEPOSITS = Object.freeze({
  // 'chain' | 'fake' | 'off'
  mode: treasury ? 'chain' : process.env.ALLOW_FAKE_DEPOSITS === 'true' ? 'fake' : 'off',
  network: NEAR_NETWORK,
  usdcContract: process.env.NEAR_USDC_CONTRACT || USDC_CONTRACTS[NEAR_NETWORK],
  usdcDecimals: 6,
  treasury: treasury || null,
});

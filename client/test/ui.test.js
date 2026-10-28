/**
 * Browser test of the wallet UI: a real game server (memory store), the Vite
 * dev server and headless Chromium. MetaMask is a stub `window.ethereum` that
 * signs with a real key, so the server's signature check runs for real.
 *
 *   npm --prefix client run test:ui
 *
 * Needs a Chromium: CHROME_PATH, or /usr/bin/chromium by default.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const SERVER_PORT = 2611;
const CLIENT_PORT = 4611;
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));
const clientDir = fileURLToPath(new URL('../', import.meta.url));

const account = privateKeyToAccount(generatePrivateKey());
const address = account.address.toLowerCase();

let server;
let vite;
let browser;

async function waitFor(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} never came up`);
}

/** A page with a fake MetaMask whose signatures come from `account`. */
async function openGame() {
  const page = await browser.newPage();
  await page.exposeFunction('__signMessage', (hex) => account.signMessage({ message: { raw: hex } }));
  await page.addInitScript((addr) => {
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [addr];
        if (method === 'personal_sign') return window.__signMessage(params[0]);
        throw new Error(`unexpected ${method}`);
      },
    };
  }, account.address);
  await page.goto(`http://127.0.0.1:${CLIENT_PORT}/`);
  return page;
}

describe('wallet UI', { skip: !existsSync(CHROME) && `no Chromium at ${CHROME}` }, () => {
  before(async () => {
    server = spawn('node', ['src/index.js'], {
      cwd: serverDir,
      // Every variable set, even to '', so nothing comes from server/.env (dotenv never overrides).
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        MONGO_URL: '',
        MONGODB_URI: '',
        ALLOW_MEMORY_DB: 'true',
        CORS_ORIGIN: '',
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: 'http://127.0.0.1:9', // nothing listens: the test must not reach the real network
        NEAR_ARCHIVAL_RPC_URL: 'http://127.0.0.1:9',
        NEAR_TREASURY_ACCOUNT: '',
        ALLOW_FAKE_DEPOSITS: '',
      },
      stdio: process.env.UI_TEST_LOG ? 'inherit' : 'ignore',
    });
    vite = spawn('npx', ['vite', '--port', String(CLIENT_PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: clientDir,
      env: { ...process.env, VITE_SERVER_URL: `ws://127.0.0.1:${SERVER_PORT}` },
      stdio: 'ignore',
    });
    await waitFor(`http://127.0.0.1:${SERVER_PORT}/health`);
    await waitFor(`http://127.0.0.1:${CLIENT_PORT}/`);
    browser = await chromium.launch({ executablePath: CHROME });
  });

  after(async () => {
    await browser?.close();
    server?.kill();
    vite?.kill();
  });

  it('shows both wallet sign-in options on the start screen', async () => {
    const page = await openGame();
    assert.equal(await page.locator('#gate-wallet').textContent().then((t) => t.trim()), 'Sign in with NEAR wallet');
    assert.equal(await page.locator('#gate-metamask').textContent().then((t) => t.trim()), 'Sign in with MetaMask');
    await page.close();
  });

  it('signs in with MetaMask, shows the account, and signs out on the server', async () => {
    const page = await openGame();
    await page.fill('#gate-name', 'Masky');
    await page.click('#gate-metamask');

    await page.locator('#hud').waitFor({ state: 'visible', timeout: 20_000 })
      .catch(async (error) => { throw new Error(`${error.message}\ngate error: ${await page.locator('#gate-error').textContent()}`); });
    const chip = page.locator('#hud-near-account');
    await chip.waitFor({ state: 'visible' });
    assert.equal(await chip.getAttribute('title'), `Signed in with NEAR as ${address}`);
    assert.match(await chip.textContent(), /^0x[0-9a-f]{6}…[0-9a-f]{6}$/);

    // Deposits are off in this server: the button is there but does nothing.
    await page.click('#btn-deposit');
    const hint = page.locator('.wal-transfer__hint');
    await hint.waitFor({ state: 'visible' });
    assert.equal(await hint.textContent(), 'Deposits are not open yet.');
    assert.equal(await page.locator('.wal-transfer .gw-btn--primary').isDisabled(), true);

    // Back on the start screen the session is recognised, then revoked.
    await page.reload();
    assert.equal(await page.locator('#gate-returning').textContent(), `Signed in with NEAR as ${address}.`);
    const token = await page.evaluate(() => localStorage.getItem('fishing-idle.sessionToken'));
    await page.click('#gate-forget');
    await page.waitForFunction(() => !localStorage.getItem('fishing-idle.sessionToken'));
    assert.equal(await page.locator('#gate-returning').isHidden(), true);

    // The revoked token is dead on the server, and the client explains why.
    await page.evaluate(([t, a]) => {
      localStorage.setItem('fishing-idle.sessionToken', t);
      localStorage.setItem('fishing-idle.displayName', 'Masky');
      localStorage.setItem('fishing-idle.nearAccountId', a);
    }, [token, address]);
    await page.reload();
    await page.click('#gate-start');
    await page.locator('#gate-error').filter({ hasText: 'Your NEAR session has ended' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('fishing-idle.sessionToken')), null);
    await page.close();
  });
});

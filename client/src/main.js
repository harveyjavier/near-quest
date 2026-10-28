/**
 * Entry point: name gate -> connect -> boot Phaser.
 *
 * Nothing starts rendering until the socket is open, so the world never shows a
 * player state that the server has not confirmed.
 */

import './style.css';

import Phaser from 'phaser';

import { NAME_RULES, ROOM_NAME, SERVER_URL } from './config.js';
import {
  NetClient, forgetSession, storeSession, storedDisplayName, storedNearAccount, storedSessionToken,
} from './net/NetClient.js';
import { FONT_FAMILY } from './art/palette.js';
import { Hud } from './ui/hud.js';
import { BootScene } from './scenes/BootScene.js';
import { HarborScene } from './scenes/HarborScene.js';

const gate = {
  root: document.getElementById('gate'),
  input: document.getElementById('gate-name'),
  error: document.getElementById('gate-error'),
  start: document.getElementById('gate-start'),
  returning: document.getElementById('gate-returning'),
  forget: document.getElementById('gate-forget'),
  wallet: document.getElementById('gate-wallet'),
};

/** The server refused a wallet device's token because a later sign-in rotated it. */
const SESSION_EXPIRED = 4401;

/** Same rules the server enforces, checked here only to avoid a round trip. */
function validateName(raw) {
  const cleaned = String(raw).replace(/\s+/g, ' ').trim();

  if (cleaned.length < NAME_RULES.minLength) {
    return { ok: false, message: `At least ${NAME_RULES.minLength} characters.` };
  }
  if (cleaned.length > NAME_RULES.maxLength) {
    return { ok: false, message: `At most ${NAME_RULES.maxLength} characters.` };
  }
  if (!NAME_RULES.pattern.test(cleaned)) {
    return { ok: false, message: 'Letters, numbers, spaces, hyphens and underscores only.' };
  }
  return { ok: true, name: cleaned };
}

function prepareGate() {
  const savedName = storedDisplayName();
  const hasSession = Boolean(storedSessionToken());
  const nearAccount = storedNearAccount();

  gate.wallet.textContent = nearAccount ? 'Switch NEAR account' : 'Sign in with NEAR wallet';
  if (hasSession && savedName) {
    gate.input.value = savedName;
    gate.start.textContent = `Continue as ${savedName}`;
    gate.returning.hidden = false;
    gate.returning.textContent = nearAccount
      ? `Signed in with NEAR as ${nearAccount}.`
      : 'Your progress on this device was found.';
    gate.forget.hidden = false;
    gate.forget.textContent = nearAccount ? 'Sign out of NEAR' : 'Not you? Start a new guest session';
  } else {
    gate.input.value = savedName ?? '';
    gate.returning.hidden = true;
    gate.forget.hidden = true;
  }

  syncStartLabel();
  gate.input.focus();
}

function syncStartLabel() {
  const name = String(gate.input.value).replace(/\s+/g, ' ').trim();
  gate.start.textContent = name ? `Continue as ${name}` : 'Start fishing';
}

/**
 * Phaser measures and rasterises text through a canvas, which silently falls
 * back to the default face if the font is not loaded *yet* -- and never
 * re-renders once it arrives. So the font is resolved before the game starts.
 *
 * Failure here is cosmetic, so a stalled font never blocks the boot: the wait
 * is capped and the game starts on the fallback stack either way.
 */
const FONT = `16px ${FONT_FAMILY}`;
const FONT_TIMEOUT_MS = 3000;

async function loadFont() {
  if (!document.fonts?.load) return;

  try {
    await Promise.race([
      document.fonts.load(FONT),
      new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS)),
    ]);
  } catch {
    // Font unavailable; the CSS fallback stack covers both DOM and canvas.
  }
}

function startGame(net) {
  const hud = new Hud(net);
  hud.show();

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#101733',
    pixelArt: true,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: '100%',
      height: '100%',
    },
    // No physics engine: movement is a handful of tile lookups per frame, and
    // Arcade Physics would be a dependency doing less than the level data does.
    scene: [BootScene, HarborScene],
  });

  game.registry.set('net', net);
  game.registry.set('hud', hud);

  // Handles for poking at a running session from the console during
  // development and QA. Never exposed in a production build.
  if (import.meta.env?.DEV) {
    window.__fishing = { game, net, hud };
  }

  hud.systemChat('Welcome to the harbor. WASD or click to walk.');

  return { game, hud };
}

async function connectAndStart(displayName) {
  gate.start.disabled = true;
  gate.error.textContent = '';
  const originalLabel = gate.start.textContent;
  gate.start.textContent = 'Connecting...';

  const net = new NetClient(SERVER_URL, ROOM_NAME);

  // Runs alongside the connection rather than before it, so the font costs no
  // extra wait on the gate.
  const fontReady = loadFont();

  try {
    await net.connect(displayName);
  } catch (error) {
    console.error('Could not join the harbor:', error);
    if (error?.code === SESSION_EXPIRED) {
      // Signed in elsewhere since: this token is dead, so start the gate over.
      forgetSession();
      prepareGate();
      gate.start.disabled = false;
      gate.error.textContent = 'Your NEAR session has ended (it expired, or you signed in somewhere else). Sign in with your wallet again.';
      return;
    }
    gate.error.textContent = describeConnectionFailure(error);
    gate.start.disabled = false;
    gate.start.textContent = originalLabel;
    return;
  }

  await fontReady;

  gate.root.hidden = true;
  document.getElementById('game').setAttribute('aria-hidden', 'false');
  startGame(net);
}

function describeConnectionFailure(error) {
  const message = String(error?.message || error || '');
  if (/ECONNREFUSED|failed to fetch|network|websocket/i.test(message)) {
    return `Could not reach the game server at ${SERVER_URL}. It may be starting up -- try again in a moment.`;
  }
  return message || 'Could not connect. Please try again.';
}

/* ------------------------------------------------------------------ wire */

gate.start.addEventListener('click', () => {
  const result = validateName(gate.input.value);
  if (!result.ok) {
    gate.error.textContent = result.message;
    gate.input.focus();
    return;
  }
  connectAndStart(result.name);
});

gate.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') gate.start.click();
});

gate.input.addEventListener('input', () => {
  gate.error.textContent = '';
  syncStartLabel();
});

gate.wallet.addEventListener('click', async () => {
  gate.wallet.disabled = true;
  gate.error.textContent = '';
  try {
    const { signInWithNear } = await import('./net/nearWallet.js');
    const name = validateName(gate.input.value);
    const guestToken = storedSessionToken();
    let session = await signInWithNear({ sessionToken: guestToken, displayName: name.ok ? name.name : undefined });

    // The wallet already owns a different save. The server changed nothing yet,
    // so saying no here leaves both the guest and the wallet's sessions intact.
    if (session.switchRequired) {
      if (!window.confirm(`${session.accountId} already has a save (${session.displayName}). Switch to it? This device's guest progress will be left behind.`)) {
        return;
      }
      session = await session.confirm();
    }
    storeSession(session.sessionToken, session.displayName, session.accountId);
    await connectAndStart(session.displayName);
  } catch (error) {
    console.error('NEAR sign-in failed:', error);
    gate.error.textContent = error.message || 'Wallet sign-in failed.';
  } finally {
    gate.wallet.disabled = false;
  }
});

gate.forget.addEventListener('click', async () => {
  if (storedNearAccount()) {
    gate.forget.disabled = true;
    try {
      const { signOutNear } = await import('./net/nearWallet.js');
      await signOutNear(storedSessionToken());
    } catch (error) {
      // The server-side revoke is best effort; signing out locally still happens.
      console.error('Server sign-out failed:', error);
    } finally {
      gate.forget.disabled = false;
    }
  }
  forgetSession();
  prepareGate();
});

prepareGate();

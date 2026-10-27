/**
 * Client configuration.
 *
 * The backend URL is the only thing that differs between local development and
 * production. It comes from VITE_SERVER_URL at build time (see .env.example);
 * there are no secrets on the client, and nothing here is read from the page.
 */

const DEFAULT_DEV_ENDPOINT = 'ws://127.0.0.1:2567';

/**
 * Accepts either a ws:// / wss:// URL or an https:// one, so the deploy doc can
 * paste the Railway URL verbatim without anyone having to remember the scheme.
 */
function normaliseEndpoint(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return null;

  if (value.startsWith('ws://') || value.startsWith('wss://')) return value;
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}`;
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}`;

  // Bare host: assume TLS, because every hosted deploy of this is HTTPS.
  return `wss://${value}`;
}

export const SERVER_URL =
  normaliseEndpoint(import.meta.env?.VITE_SERVER_URL) ?? DEFAULT_DEV_ENDPOINT;

export const ROOM_NAME = 'harbor';

/** Mirrors DISPLAY_NAME in the server config, for instant feedback on the gate. */
export const NAME_RULES = {
  minLength: 3,
  maxLength: 16,
  pattern: /^[A-Za-z0-9 _-]+$/,
};

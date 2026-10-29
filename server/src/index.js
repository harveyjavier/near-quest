/**
 * Fishing Idle Game MMO -- backend entry point.
 *
 * Runs a long-lived Node process hosting a Colyseus WebSocket server plus a
 * small Express app for health checks. This must be deployed somewhere that
 * keeps a process alive (Railway / Heroku dyno) -- it is not serverless-safe,
 * because the room holds the authoritative idle-loop timers in memory.
 */

import { createServer } from 'node:http';

import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { CLIENT_CATALOG, CONNECTION, ROOM_NAME } from './config/index.js';
import { HarborRoom, releaseSession } from './rooms/HarborRoom.js';
import { NEAR_NETWORK, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, assertAuthRate, issueNonce, signInWithNear, signOutNear } from './auth/near.js';
import { connectDatabase, disconnectDatabase, getRepo, repoKind } from './db/repo.js';
import { log } from './util/logger.js';

const PORT = Number(process.env.PORT) || 2567;

/**
 * Browser origins allowed to talk to this backend. Set CORS_ORIGIN to the
 * Firebase Hosting URL in production (comma-separated for multiple). Defaults
 * to permissive only when unset, so local development just works.
 */
function corsOptions() {
  const configured = String(process.env.CORS_ORIGIN || '').trim();
  if (!configured || configured === '*') return { origin: true };

  const allowed = configured.split(',').map((entry) => entry.trim()).filter(Boolean);
  return {
    origin(origin, callback) {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin || allowed.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed.`));
    },
  };
}

async function main() {
  await connectDatabase();

  const app = express();
  app.disable('x-powered-by');
  // How many proxies sit in front (Railway: 1). Off by default: without a real
  // proxy, X-Forwarded-For is whatever the client sends, and trusting it would
  // let anyone pick their own request.ip and dodge the auth rate limit.
  const trustProxy = String(process.env.TRUST_PROXY || '').trim();
  if (/^\d+$/.test(trustProxy) && Number(trustProxy) > 0) app.set('trust proxy', Number(trustProxy));
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: '16kb' }));

  // Platform health check. Railway/Heroku poll this to decide if the process
  // is alive; it must not depend on a room existing.
  app.get('/health', async (_request, response) => {
    let players = null;
    try {
      players = await getRepo().playerCount();
    } catch {
      players = null;
    }
    response.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      database: repoKind(),
      players,
      room: ROOM_NAME,
      time: new Date().toISOString(),
    });
  });

  // Lets the client render the shop and fish list before it opens a socket.
  app.get('/catalog', (_request, response) => response.json(CLIENT_CATALOG));

  // NEAR wallet sign-in: fetch a one-time challenge, sign it, post it back.
  const AUTH_STATUS = { RATE_LIMITED: 429, BUSY: 503, NEAR_UNAVAILABLE: 503, SWITCH_REQUIRED: 409 };
  const authError = (response, error) => {
    if (error.code === 11000) return response.status(409).json({ error: 'That wallet was just linked elsewhere. Try again.' });
    if (error.name !== 'ValidationError') throw error;
    response.status(AUTH_STATUS[error.code] ?? 401).json({ ...error.details, code: error.code, error: error.message });
  };
  app.get('/auth/near/challenge', (request, response) => {
    try {
      assertAuthRate(request.ip);
      response.json({ nonce: issueNonce(), message: SIGN_IN_MESSAGE, recipient: SIGN_IN_RECIPIENT, network: NEAR_NETWORK });
    } catch (error) {
      authError(response, error);
    }
  });

  app.post('/auth/near', async (request, response) => {
    try {
      assertAuthRate(request.ip);
      response.json(await signInWithNear(request.body ?? {}, { releaseSession }));
    } catch (error) {
      authError(response, error);
    }
  });

  app.post('/auth/signout', async (request, response) => {
    try {
      assertAuthRate(request.ip);
      await signOutNear(request.body?.sessionToken, { releaseSession });
      response.status(204).end();
    } catch (error) {
      authError(response, error);
    }
  });

  app.get('/', (_request, response) =>
    response.json({ name: 'Fishing Idle Game MMO', endpoints: ['/health', '/catalog', '/auth/near/challenge', '/auth/near', '/auth/signout'] }));

  // Express 5 error handler: never leak a stack trace to a browser.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _request, response, _next) => {
    log.error('HTTP error:', error.message);
    response.status(500).json({ error: 'Internal server error' });
  });

  const httpServer = createServer(app);
  const gameServer = new Server({
    // The ping settings are the difference between a player who backgrounds
    // the tab keeping their session and losing it: the transport's defaults
    // terminate a socket after about six seconds of silence. See CONNECTION.
    transport: new WebSocketTransport({
      server: httpServer,
      pingInterval: CONNECTION.pingIntervalMs,
      pingMaxRetries: CONNECTION.pingMaxRetries,
    }),
  });

  gameServer.define(ROOM_NAME, HarborRoom);

  await gameServer.listen(PORT);
  log.info(`Listening on :${PORT} (room "${ROOM_NAME}", db "${repoKind()}").`);

  const shutdown = async (signal) => {
    log.info(`${signal} received -- draining.`);
    try {
      await gameServer.gracefullyShutdown(false);
      await disconnectDatabase();
    } catch (error) {
      log.error('Shutdown error:', error.message);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

// A rejected promise must not silently leave a half-dead process running an
// idle loop that no longer persists anything.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

main().catch((error) => {
  log.error('Fatal startup error:', error);
  process.exit(1);
});

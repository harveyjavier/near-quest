import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BAND,
  BOARDWALK,
  buildLevel,
  PIERS,
  SHOP,
  tileToStand,
  WORLD_COLUMNS,
  WORLD_ROWS,
} from '../src/world/level.js';
import { findPath } from '../src/world/pathfind.js';
import {
  FISHING_SPOTS,
  SPOT_HEIGHT,
  SPOT_HIT_PADDING,
  SPOT_WIDTH,
  spotAtStand,
  spotAtWorld,
  spotTile,
} from '../src/world/fishing-spots.js';

test('harbor layout resolves every tile and preserves its gameplay anchors', () => {
  const level = buildLevel();

  assert.equal(level.ground.length, WORLD_ROWS);
  assert.ok(level.ground.every((row) => row.length === WORLD_COLUMNS));
  assert.ok(level.deck.every((row) => row.length === WORLD_COLUMNS));
  assert.deepEqual(level.shopDoor, { x: SHOP.x + 2, y: SHOP.y + 2 });
  assert.equal(level.solid[level.shopDoor.y][level.shopDoor.x], false);

  for (const pier of PIERS) {
    assert.equal(level.solid[pier.y1][pier.x0], false);
    assert.equal(level.solid[pier.y1][pier.x1], false);
  }
  for (const spawn of level.spawns) assert.equal(level.solid[spawn.y][spawn.x], false);

  assert.equal(level.fishable[BAND.beachRow][12], true);
  assert.equal(level.deck[PIERS[0].y0][PIERS[0].x0], 0);
  assert.equal(level.deck[PIERS[0].y1][PIERS[0].x1], 0);
  assert.equal(level.deck[BOARDWALK.y0][BOARDWALK.x0], 0);
  assert.equal(level.dockRails.length, 6, 'the removed east bridge rail is not restored');
  assert.equal(level.solid[4][23], true, 'left upper-bridge rail blocks pathfinding');
  assert.equal(level.solid[4][24], false, 'upper-bridge centre planks remain walkable');
  assert.equal(level.solid[4][25], false, 'removed right upper-bridge rail remains walkable');
});

/**
 * The server seats joining players; the map lives here. Nothing links the two
 * but a comment, and the last time the harbour was redrawn that comment went
 * stale and every arrival spawned in the lake. This asserts the coupling.
 */
test('every server spawn seat is walkable, and in reach of the water', async () => {
  const { MAX_CLIENTS_PER_ROOM, SPAWN, tileStand, WORLD } =
    await import('../../server/src/config/game.config.js');
  const level = buildLevel();

  assert.equal(WORLD.columns, WORLD_COLUMNS, 'server world width must match the map');
  assert.equal(WORLD.rows, WORLD_ROWS, 'server world height must match the map');

  for (const { tx, ty } of SPAWN.seats) {
    assert.ok(tx >= 0 && tx < WORLD_COLUMNS && ty >= 0 && ty < WORLD_ROWS,
      `seat ${tx},${ty} is off the map`);
    assert.equal(level.solid[ty][tx], false, `seat ${tx},${ty} is inside something solid`);
    assert.ok(level.deck[ty][tx] !== -1, `seat ${tx},${ty} is not on decking`);
    assert.equal(level.fishable[ty][tx], true, `seat ${tx},${ty} cannot reach the water`);
  }

  assert.deepEqual(
    level.spawns.map(({ x, y }) => ({ tx: x, ty: y })),
    SPAWN.seats,
    'the client preview spawns must match the server join spawns',
  );

  // Seating is a coordinate, not a tile: the server sends world pixels and the
  // client draws the sprite there without adjusting it. Handing over the tile
  // centre drew every arrival half a tile high -- stood on the water off a pier
  // edge -- until their first step snapped them onto the planks.
  for (const { tx, ty } of SPAWN.seats) {
    assert.deepEqual(tileStand(tx, ty), tileToStand(tx, ty),
      `seat ${tx},${ty} is not seated where the client walks to`);
  }

  // Every plank a full room can seat someone on, seats and lanes together.
  const planks = SPAWN.seats.map(({ tx, ty }) => `${tx},${ty}`);
  for (const { x0, x1, y0, y1 } of SPAWN.lanes) {
    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        assert.equal(level.solid[ty][tx], false, `lane tile ${tx},${ty} is solid`);
        assert.equal(level.fishable[ty][tx], true, `lane tile ${tx},${ty} cannot reach the water`);
        planks.push(`${tx},${ty}`);
      }
    }
  }

  assert.equal(new Set(planks).size, planks.length,
    'seats and lanes overlap, so two players would share a plank');
  assert.ok(planks.length >= MAX_CLIENTS_PER_ROOM,
    `only ${planks.length} planks for ${MAX_CLIENTS_PER_ROOM} players`);
});

/**
 * Fishing spots are three coordinates that have to agree with the collision map
 * and with each other: the pool has to be in the water, the plank has to be
 * walkable and fishable, and the two have to be next to each other and lined up
 * with the facing the angler is turned to on arrival.
 *
 * Getting any of these wrong is invisible until someone clicks the pool and the
 * angler either walks onto the water, refuses to move, or stands with their
 * back to the fish, so it is asserted rather than eyeballed.
 */
test('every fishing spot has a plank to fish it from, and water to fish in', () => {
  const level = buildLevel();
  const seen = new Set();

  assert.ok(FISHING_SPOTS.length >= 4, 'the harbour is meant to have several spots');

  for (const spot of FISHING_SPOTS) {
    const { stand, facing } = spot;
    const tile = spotTile(spot);
    const where = `spot ${spot.id}`;

    assert.ok(!seen.has(spot.id), `${where} is defined twice`);
    seen.add(spot.id);

    assert.ok(tile.tx > 0 && tile.tx < WORLD_COLUMNS - 1
      && tile.ty > 0 && tile.ty < WORLD_ROWS - 1, `${where} pool is off the map`);

    // The pool is water, so nothing may walk onto it -- otherwise a click would
    // path the angler on top of the fish instead of up to the edge.
    assert.equal(level.solid[tile.ty][tile.tx], true, `${where} pool is walkable`);
    assert.equal(level.water[tile.ty][tile.tx], true, `${where} pool is not in the water`);

    assert.equal(level.solid[stand.ty][stand.tx], false, `${where} plank is not walkable`);
    // Walkable is not enough: the dock rails sit inside walkable tiles, so a
    // plank can be free of solid tiles and still have no room to stand on.
    assert.equal(level.standable[stand.ty][stand.tx], true, `${where} plank has no standing room`);
    assert.equal(level.fishable[stand.ty][stand.tx], true, `${where} plank cannot reach water`);
    assert.equal(spotAtStand(stand.tx, stand.ty), spot, `${where} plank is shared or unfindable`);

    // Close enough that the line reads as reaching the pool, and lined up with
    // the authored facing on one axis so the angler is not casting sideways.
    const dx = tile.tx - stand.tx;
    const dy = tile.ty - stand.ty;
    const expected = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[facing];
    assert.ok(expected, `${where} has an unknown facing ${facing}`);
    assert.ok(Math.abs(dx) + Math.abs(dy) <= 3, `${where} pool is out of casting range`);
    assert.equal(Math.sign(dx), expected[0] === 0 ? 0 : expected[0],
      `${where} faces ${facing} but its pool is not that way`);
    assert.equal(Math.sign(dy), expected[1] === 0 ? 0 : expected[1],
      `${where} faces ${facing} but its pool is not that way`);
  }
});

test('a click resolves to exactly one fishing spot, and pools never touch', () => {
  const rx = SPOT_WIDTH / 2 + SPOT_HIT_PADDING;
  const ry = SPOT_HEIGHT / 2 + SPOT_HIT_PADDING;

  for (const spot of FISHING_SPOTS) {
    assert.equal(spotAtWorld(spot.x, spot.y), spot, `${spot.id} does not claim its own centre`);

    // Past its own hit area a pool lets go, so the planks and shore beside it
    // stay clickable as ground. A neighbour may claim the point instead once
    // the pools are packed close -- what matters is that this one does not.
    for (const [dx, dy] of [[rx + 2, 0], [-rx - 2, 0], [0, ry + 2], [0, -ry - 2]]) {
      assert.notEqual(spotAtWorld(spot.x + dx, spot.y + dy)?.id, spot.id,
        `${spot.id} claims clicks outside its own footprint`);
    }
  }

  for (const a of FISHING_SPOTS) {
    for (const b of FISHING_SPOTS) {
      if (a === b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;

      // Drawn footprints stay apart, so no pool is rendered on top of another.
      assert.ok(Math.abs(dx) > SPOT_WIDTH || Math.abs(dy) > SPOT_HEIGHT,
        `${a.id} and ${b.id} overlap`);
      // And so do their hit areas, so no click is ambiguous. Two equal ellipses
      // are disjoint once their centres are more than a full axis apart.
      assert.ok(Math.hypot(dx / (2 * rx), dy / (2 * ry)) >= 1,
        `${a.id} and ${b.id} have overlapping click areas`);
    }
  }
});

/**
 * A spot nobody can walk to is worse than no spot: it draws the player across
 * the harbour and strands them. Two of the first eight did exactly that -- one
 * sat on a rail-blocked row, the other on the small west dock, which the
 * collision map leaves cut off from everything else -- so the route from a
 * spawn seat to every plank is walked here.
 */
test('every fishing spot can actually be walked to from a spawn seat', () => {
  const level = buildLevel();
  const seat = level.spawns[0];

  for (const spot of FISHING_SPOTS) {
    const path = findPath(level.pathSolid, { tx: seat.x, ty: seat.y }, spot.stand, 8000);
    assert.ok(path.length > 0, `no route from spawn to ${spot.id}`);

    const last = path[path.length - 1];
    assert.deepEqual(last, { tx: spot.stand.tx, ty: spot.stand.ty },
      `route to ${spot.id} stops short`);
    // Every tile on the way has to be one the walker can come to rest on, or
    // it grinds into a rail partway there and the path never advances.
    for (const step of path) {
      assert.equal(level.standable[step.ty][step.tx], true,
        `route to ${spot.id} passes through ${step.tx},${step.ty}, which has no standing room`);
    }
  }
});

/**
 * The pool has to be near enough that the line reads as reaching it.
 *
 * 82px is two and a half tiles, and the cap is that high only because of the
 * north pond: `tileToStand` seats the angler at the bottom of row 12 while the
 * water starts above row 11, and the bridge's posts overhang its planks, so
 * those spots cannot physically be nearer than 66px and run to 80px on the
 * columns with the longest posts. Everything with a choice sits a tile out.
 */
test('no fishing spot is out of casting range of its plank', () => {
  for (const spot of FISHING_SPOTS) {
    const feet = tileToStand(spot.stand.tx, spot.stand.ty);
    const distance = Math.hypot(spot.x - feet.x, spot.y - feet.y);
    assert.ok(distance <= 82, `${spot.id} is ${Math.round(distance)}px from its plank`);
  }
});

/**
 * The server seats arrivals on row 12 of the boardwalk. A fishing plank on one
 * of those tiles would drop a joining player on top of whoever is fishing it.
 */
test('no fishing spot stands on a spawn seat', async () => {
  const { SPAWN } = await import('../../server/src/config/game.config.js');
  const seats = new Set(SPAWN.seats.map(({ tx, ty }) => `${tx},${ty}`));

  for (const spot of FISHING_SPOTS) {
    assert.equal(seats.has(`${spot.stand.tx},${spot.stand.ty}`), false,
      `${spot.id} fishes from spawn seat ${spot.stand.tx},${spot.stand.ty}`);
  }
});

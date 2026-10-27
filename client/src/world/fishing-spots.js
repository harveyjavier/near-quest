/**
 * The harbour's fishing spots.
 *
 * Fishing used to start wherever the angler happened to be standing at the
 * water's edge, which made the whole shoreline equally interesting and gave the
 * player nothing to aim at. Instead the water has a handful of marked pools --
 * a dark patch with fish circling under it -- and fishing is something you go
 * and click on.
 *
 * Each entry is three things that have to agree:
 *
 *   x, y   the centre of the pool, in world pixels. Whole pixels rather than a
 *          tile so a pool can be tucked right up against the planks it is
 *          fished from; the tile it lands in must be open water in
 *          harbor-environment.png and must NOT be walkable, or the player would
 *          path on top of the pool instead of up to it.
 *   stand  the plank or patch of shore the angler fishes from. Must be
 *          walkable and `fishable` (see buildLevel), because the server-side
 *          fishing rules still key off that.
 *   facing which way the angler turns on arrival. It is stored rather than
 *          derived so a spot can sit off the corner of a plank without the
 *          angler snapping to a facing that reads wrong.
 *
 * `client/test/level.test.js` asserts all three for every spot, so a spot moved
 * onto a rock or off the end of a dock fails the build rather than the player.
 *
 * Choosing a plank is more constrained than it looks, and the first pass got it
 * wrong twice. A plank has to be walkable, `fishable`, reachable on foot from
 * the spawn seats, AND have standing room at `tileToStand` -- the dock rails
 * sit inside otherwise-walkable tiles, so the south rows of both long docks are
 * `solid: false` with nowhere to stand. The old south-bay spot sat on one of
 * those, and the old reed-channel spot sat on the small west dock, which the
 * collision map leaves cut off from the rest of the harbour. Both were
 * genuinely unreachable. `level.standable` now answers this, and the test below
 * walks from a spawn seat to every plank.
 *
 * Given a legal plank, each pool is then placed as close to it as the art
 * allows: walked in one pixel at a time from the angler's standing position
 * along `facing` until the whole footprint cleared the decking and the shore.
 * That puts most of them about a tile out.
 *
 * The spread is deliberate -- the north pond off the boardwalk, the bank and
 * the bridge, the channel between the long docks, and the moored boat -- so
 * wherever a player walks there is a pool within sight.
 *
 * Two things to know before moving a north-pond spot.
 *
 * They sit 66-80px out, against 20-50px everywhere else, and that is the floor
 * rather than a choice: `tileToStand` puts the feet at the BOTTOM of row 12
 * while the water starts above the top of row 11, so the angler is already 48px
 * from the edge before the pool's own half-height is added. The bridge is the
 * same story sideways -- its posts overhang the planks. The exact figure varies
 * with x, because the boardwalk's posts jut further north at x14-16, x19-20,
 * x28-29 and x34 (a pool there lands 83-85px out), which is why the planks
 * below are the specific columns they are.
 *
 * Those columns also dodge the server's spawn seats (row 12, even x from 12 to
 * 34) so nobody is ever seated on top of someone fishing. And the pond is
 * fished only from its rim -- the middle of each lobe has no plank within
 * casting range and never will, which is what sets the pond's density.
 */

import { TILE } from './level.js';

/**
 * Pool footprint in world pixels.
 *
 * Small, and smaller than it first was: the pool cannot be drawn over the
 * decking, so its half-height is a floor on how near the boards it can sit.
 * Shrinking it is most of what let the pools move in from ~2 tiles out to ~1.
 *
 * COUPLING: mirrors the same names in art/effects.js, which draws the texture.
 */
export const SPOT_WIDTH = 60;
export const SPOT_HEIGHT = 34;

/**
 * Slack added around the drawn pool when hit testing a click, in world pixels.
 *
 * Small on purpose. The pools sit close enough to the boards that anything
 * generous here would start eating clicks meant for the planks behind them.
 */
export const SPOT_HIT_PADDING = 4;

export const FISHING_SPOTS = [
  // North pond -- the bank along the top, the bridge down the middle, the
  // boardwalk's north edge along the bottom, and the shop's shore to the east.
  { id: 'north-bank', x: 432, y: 159, stand: { tx: 13, ty: 3 }, facing: 'down' },
  { id: 'north-bank-mid', x: 592, y: 165, stand: { tx: 18, ty: 3 }, facing: 'down' },
  { id: 'north-bank-east', x: 976, y: 183, stand: { tx: 30, ty: 3 }, facing: 'down' },
  { id: 'shop-shore', x: 1118, y: 255, stand: { tx: 36, ty: 7 }, facing: 'left' },
  { id: 'bridge-pond-top', x: 891, y: 191, stand: { tx: 25, ty: 5 }, facing: 'right' },
  { id: 'bridge-pond-mid', x: 884, y: 255, stand: { tx: 25, ty: 7 }, facing: 'right' },
  { id: 'bridge-pond-low', x: 890, y: 319, stand: { tx: 25, ty: 9 }, facing: 'right' },
  { id: 'pond-west', x: 368, y: 349, stand: { tx: 11, ty: 12 }, facing: 'up' },
  { id: 'pond-mid', x: 560, y: 349, stand: { tx: 17, ty: 12 }, facing: 'up' },
  { id: 'pond-bridge', x: 688, y: 335, stand: { tx: 21, ty: 12 }, facing: 'up' },
  { id: 'pond-east', x: 1008, y: 349, stand: { tx: 31, ty: 12 }, facing: 'up' },
  // The channel between the two long docks, and the water south and east of it.
  { id: 'bridge-west', x: 701, y: 511, stand: { tx: 23, ty: 15 }, facing: 'left' },
  { id: 'channel-west', x: 464, y: 575, stand: { tx: 14, ty: 18 }, facing: 'up' },
  { id: 'channel-mid', x: 656, y: 575, stand: { tx: 20, ty: 18 }, facing: 'up' },
  { id: 'channel-east', x: 976, y: 575, stand: { tx: 30, ty: 18 }, facing: 'up' },
  { id: 'dock-west', x: 335, y: 639, stand: { tx: 11, ty: 19 }, facing: 'left' },
  { id: 'dock-east', x: 1092, y: 639, stand: { tx: 33, ty: 19 }, facing: 'right' },
  { id: 'boat-side', x: 1331, y: 575, stand: { tx: 42, ty: 17 }, facing: 'left' },
];

/** The centre of a spot's pool, in world pixels. */
export const spotCentre = (spot) => ({ x: spot.x, y: spot.y });

/** The tile the pool's centre lands in -- what the collision map is checked against. */
export const spotTile = (spot) => ({
  tx: Math.floor(spot.x / TILE),
  ty: Math.floor(spot.y / TILE),
});

/** The spot fished from a given tile, if any. Used for remote anglers too. */
export function spotAtStand(tx, ty) {
  return FISHING_SPOTS.find((spot) => spot.stand.tx === tx && spot.stand.ty === ty) ?? null;
}

/**
 * The spot under a click, or null.
 *
 * Hit testing lives here rather than on a Phaser interactive object so the
 * scene's own pointer handler stays the single place a click is resolved --
 * otherwise a click on a pool would both select the spot and, depending on the
 * order Phaser happens to emit its input events, walk the angler somewhere.
 *
 * The test is an ellipse matching the drawn pool, widened slightly, so what is
 * clickable is what is visible.
 */
export function spotAtWorld(x, y, padding = SPOT_HIT_PADDING) {
  const rx = SPOT_WIDTH / 2 + padding;
  const ry = SPOT_HEIGHT / 2 + padding;

  for (const spot of FISHING_SPOTS) {
    const dx = (x - spot.x) / rx;
    const dy = (y - spot.y) / ry;
    if (dx * dx + dy * dy <= 1) return spot;
  }
  return null;
}

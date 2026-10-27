/**
 * Collision and fishing grid for the single-image harbor environment.
 *
 * The visible environment is one 1536x1024 image. This grid is deliberately
 * invisible: it only defines walkable shore/dock space and fishable water edges.
 */
import collisionGrid from './collision-grid.json' with { type: 'json' };

export const TILE = 32;
export const WORLD_COLUMNS = 48;
export const WORLD_ROWS = 32;
export const WORLD_WIDTH = WORLD_COLUMNS * TILE;
export const WORLD_HEIGHT = WORLD_ROWS * TILE;
const BAND = { waterTop: 4, beachRow: 12 };
const SHOP = { x: 8, y: 3, width: 11, height: 8 };
const BOARDWALK = { x0: 10, x1: 34, y0: 12, y1: 14 };
const PIERS = [
  BOARDWALK,
  { x0: 23, x1: 25, y0: 4, y1: 20 },
  { x0: 11, x1: 33, y0: 18, y1: 21 },
  { x0: 4, x1: 8, y0: 16, y1: 19 },
  { x0: 40, x1: 43, y0: 20, y1: 23 },
];

const railRect = (x0, x1, y0, y1) => ({
  x: x0 * TILE,
  y: y0 * TILE,
  width: (x1 - x0 + 1) * TILE,
  height: (y1 - y0 + 1) * TILE,
});

const HALF_TILE = TILE / 2;
// Painted rails sit inside otherwise-walkable dock tiles. The boardwalk has a
// centre gap for its bridge; the upper bridge has a solid rail down its west
// side only (the east-side rail at x=25 was removed by request, so the top
// bridge is now open on that side, rows 4-11).
const dockRails = [
  { ...railRect(BOARDWALK.x0, 22, BOARDWALK.y1, BOARDWALK.y1), y: (BOARDWALK.y1 + 1) * TILE - HALF_TILE, height: HALF_TILE },
  { ...railRect(26, BOARDWALK.x1, BOARDWALK.y1, BOARDWALK.y1), y: (BOARDWALK.y1 + 1) * TILE - HALF_TILE, height: HALF_TILE },
  { ...railRect(11, 33, 21, 21), y: 22 * TILE - HALF_TILE, height: HALF_TILE },
  { ...railRect(4, 8, 19, 19), y: 20 * TILE - HALF_TILE, height: HALF_TILE },
  { ...railRect(40, 43, 23, 23), y: 24 * TILE - HALF_TILE, height: HALF_TILE },
  railRect(23, 23, 4, 11),
];

const inside = (x, y) => x >= 0 && y >= 0 && x < WORLD_COLUMNS && y < WORLD_ROWS;

/**
 * The angler's collision box, in pixels, relative to the sprite's bottom-centre
 * origin. Lives here rather than in the scene because the level has to answer
 * "can someone stand on this tile?", and that question is this box against the
 * solid grid and the dock rails.
 */
export const FEET = { width: 10, height: 6, offsetY: -3 };

/**
 * True when the feet box centred at (x, y) clears every solid tile and every
 * dock rail it overlaps.
 *
 * Rails are the reason this cannot be a lookup in `solid`: they are precise
 * areas inside otherwise-walkable dock tiles, so a tile can be perfectly
 * walkable and still have no room to stand at the spot the walker aims for.
 */
export function canStandAt(solid, rails, x, y) {
  const left = x - FEET.width / 2;
  const right = x + FEET.width / 2 - 0.01;
  const bottom = y + FEET.offsetY;
  const top = bottom - FEET.height;

  for (const [px, py] of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (!inside(tx, ty)) return false;
    if (solid[ty][tx]) return false;
  }

  for (const rail of rails) {
    if (left < rail.x + rail.width && right >= rail.x
      && top < rail.y + rail.height && bottom >= rail.y) return false;
  }

  return true;
}

// Traces the shoreline and southern bay drawn into harbor-environment.png.
const isWater = (x, y) => {
  if (y < 4) return false;
  if (y < 11) return x >= 7 && x <= 35;
  if (y < 20) return x >= 3 && x <= 41;
  if (y < 26) return x >= 5 && x <= 43;
  return x >= 14 && x <= 39;
};

export function buildLevel() {
  const ground = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(-1));
  // `deck` is a non-rendered collision marker for dock planks painted into the
  // environment image. Keeping it preserves the existing fishing rules.
  const deck = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(-1));
  const solid = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(false));
  const water = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(false));

  for (let y = 0; y < WORLD_ROWS; y += 1) for (let x = 0; x < WORLD_COLUMNS; x += 1) {
    if (isWater(x, y)) {
      water[y][x] = true;
      solid[y][x] = true;
    }
  }
  for (let x = 0; x < WORLD_COLUMNS; x += 1) solid[0][x] = solid[WORLD_ROWS - 1][x] = true;
  for (let y = 0; y < WORLD_ROWS; y += 1) solid[y][0] = solid[y][WORLD_COLUMNS - 1] = true;

  for (const rect of PIERS) for (let y = rect.y0; y <= rect.y1; y += 1) {
    for (let x = rect.x0; x <= rect.x1; x += 1) {
      deck[y][x] = 0;
      solid[y][x] = false;
    }
  }

  // House, large trees, boulders, and shore clutter in the baked image.
  [[8, 4, 18, 10], [2, 2, 6, 10], [19, 2, 23, 10], [4, 19, 8, 27], [15, 22, 19, 28]]
    .forEach(([x0, y0, x1, y1]) => {
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) solid[y][x] = true;
    });
  // Visible docks always win over any broad shore-prop collision area.
  for (const rect of PIERS) for (let y = rect.y0; y <= rect.y1; y += 1) {
    for (let x = rect.x0; x <= rect.x1; x += 1) solid[y][x] = false;
  }
  // Full-tile side rail is solid to keep click-to-move off the bridge's west
  // edge. The matching east-side rail (x=25) was removed by request, so that
  // side of the bridge is walkable, rows 4-11.
  for (let y = 4; y < BOARDWALK.y0; y += 1) {
    solid[y][23] = true;
  }
  solid[SHOP.y + 2][SHOP.x + 2] = false;

  // Collision is now authored externally with tools/collision-map-editor.html
  // and saved to collision-grid.json, which is the source of truth for solid
  // tiles going forward. The procedural computation above still runs (it also
  // produces `deck`/`water`, and seeded the editor's starting grid) but is
  // overridden here. If the JSON is ever missing or malformed, this falls
  // back to the procedural grid so the game never breaks.
  if (Array.isArray(collisionGrid?.solid) && collisionGrid.solid.length === WORLD_ROWS) {
    for (let y = 0; y < WORLD_ROWS; y += 1) for (let x = 0; x < WORLD_COLUMNS; x += 1) {
      solid[y][x] = !!collisionGrid.solid[y]?.[x];
    }
  }

  const fishable = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(false));
  for (let y = 0; y < WORLD_ROWS; y += 1) for (let x = 0; x < WORLD_COLUMNS; x += 1) {
    if (solid[y][x]) continue;
    fishable[y][x] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .some(([dx, dy]) => isWater(x + dx, y + dy) && deck[y + dy]?.[x + dx] === -1);
  }

  /**
   * Where a walker can actually come to rest, and its inverse for the pathfinder.
   *
   * `solid` alone is not enough to route on. Click-to-move walks the angler to
   * `tileToStand` of each tile on the route, and the dock rails sit inside
   * otherwise-walkable dock tiles -- so the south row of the boardwalk, say, is
   * `solid: false` but has no standing room at all. A route through one of
   * those tiles never completes: the walker grinds into the rail and the path
   * never advances. Handing `pathSolid` to findPath/nearestWalkable instead
   * keeps routes to tiles that can actually be reached.
   */
  const standable = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(false));
  const pathSolid = Array.from({ length: WORLD_ROWS }, () => Array(WORLD_COLUMNS).fill(true));
  for (let y = 0; y < WORLD_ROWS; y += 1) for (let x = 0; x < WORLD_COLUMNS; x += 1) {
    if (solid[y][x]) continue;
    const foot = tileToStand(x, y);
    standable[y][x] = canStandAt(solid, dockRails, foot.x, foot.y);
    pathSolid[y][x] = !standable[y][x];
  }

  const spawns = [
    { x: 12, y: 12 }, { x: 14, y: 12 }, { x: 16, y: 12 }, { x: 18, y: 12 },
    { x: 28, y: 12 }, { x: 30, y: 12 }, { x: 32, y: 12 }, { x: 34, y: 12 },
  ];
  return { ground, deck, over: [], solid, standable, pathSolid, water, fishable, dockRails, spawns, shopDoor: { x: SHOP.x + 2, y: SHOP.y + 2 }, boardwalk: BOARDWALK, waterTiles: new Set() };
}

export const tileToWorld = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
export const tileToStand = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE - 1 });
export const worldToTile = (x, y) => ({ tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) });
export { BAND, SHOP, PIERS, BOARDWALK };

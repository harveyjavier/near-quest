/**
 * Grid A* for click-to-move.
 *
 * Straight-line walking plus wall sliding is enough for keyboard input, but a
 * click on the far side of the shop needs to actually get there rather than
 * grinding into a wall. The map is 32x24, so a plain binary-heap A* over tiles
 * is far cheaper than the frame it runs in.
 *
 * Movement is 4-directional: diagonals would let the player clip the corner
 * between two solid tiles, and the character art only has four facings anyway.
 */

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Minimal binary heap keyed by `f`. */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(node) {
    this.items.push(node);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].f <= this.items[index].f) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.items[left].f < this.items[smallest].f) smallest = left;
        if (right < this.items.length && this.items[right].f < this.items[smallest].f) smallest = right;
        if (smallest === index) break;
        [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * @param {boolean[][]} solid   solid[y][x] === true blocks movement
 * @param {{tx:number,ty:number}} start
 * @param {{tx:number,ty:number}} goal
 * @param {number} maxNodes  guards against pathing to an unreachable island
 * @returns {{tx:number,ty:number}[]} tiles from the step after `start` to `goal`,
 *                                   or [] when no route exists
 */
export function findPath(solid, start, goal, maxNodes = 4000) {
  const rows = solid.length;
  const columns = solid[0].length;

  const inside = (x, y) => x >= 0 && y >= 0 && x < columns && y < rows;
  if (!inside(start.tx, start.ty) || !inside(goal.tx, goal.ty)) return [];
  if (solid[goal.ty][goal.tx]) return [];
  if (start.tx === goal.tx && start.ty === goal.ty) return [];

  const key = (x, y) => y * columns + x;
  const heuristic = (x, y) => Math.abs(x - goal.tx) + Math.abs(y - goal.ty);

  const cameFrom = new Map();
  const bestCost = new Map();
  const open = new MinHeap();

  const startKey = key(start.tx, start.ty);
  bestCost.set(startKey, 0);
  open.push({ x: start.tx, y: start.ty, f: heuristic(start.tx, start.ty) });

  let examined = 0;

  while (open.size > 0) {
    const current = open.pop();
    const currentKey = key(current.x, current.y);

    if (current.x === goal.tx && current.y === goal.ty) {
      const path = [];
      let cursor = currentKey;
      while (cursor !== startKey) {
        path.push({ tx: cursor % columns, ty: Math.floor(cursor / columns) });
        cursor = cameFrom.get(cursor);
        if (cursor === undefined) return [];
      }
      return path.reverse();
    }

    examined += 1;
    if (examined > maxNodes) return [];

    const cost = bestCost.get(currentKey) ?? Infinity;

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!inside(nx, ny) || solid[ny][nx]) continue;

      const neighbourKey = key(nx, ny);
      const nextCost = cost + 1;
      if (nextCost >= (bestCost.get(neighbourKey) ?? Infinity)) continue;

      bestCost.set(neighbourKey, nextCost);
      cameFrom.set(neighbourKey, currentKey);
      open.push({ x: nx, y: ny, f: nextCost + heuristic(nx, ny) });
    }
  }

  return [];
}

/**
 * Nearest walkable tile to a click that landed on something solid, so tapping
 * the water still walks you to the edge of the dock instead of doing nothing.
 */
export function nearestWalkable(solid, tx, ty, maxRadius = 6) {
  const rows = solid.length;
  const columns = solid[0].length;
  const inside = (x, y) => x >= 0 && y >= 0 && x < columns && y < rows;

  if (inside(tx, ty) && !solid[ty][tx]) return { tx, ty };

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (inside(x, y) && !solid[y][x]) return { tx: x, ty: y };
      }
    }
  }
  return null;
}

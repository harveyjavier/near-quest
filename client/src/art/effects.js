/**
 * Small generated sprites for the fishing feedback loop: ripples, splashes,
 * drifting fish shadows, chests and the level-up ring.
 *
 * The angler and its rod come from the sprite sheet instead (see
 * art/characters.js); these are the effects layered around them.
 *
 * Same rationale as characters.js -- generated at boot rather than shipped, so
 * there is no second art pipeline and tier colours are applied by tint.
 */

import { makeCanvasTexture, makePixelTexture, seeded } from './pixels.js';
import { PALETTE } from './palette.js';

/**
 * The two cloud-shadow sheets, drifted at different speeds so the sky reads as
 * having depth rather than as one sliding sheet.
 *
 * Both sheets use the same CLOUD_PIXEL block size on purpose. Depth here comes
 * from speed and density, never from scaling one layer up: two different pixel
 * grids on screen at once is the one thing that stops pixel art reading as
 * pixel art. The sheets are different sizes so their tiling periods don't line
 * up, which is what keeps a hard-edged pattern from visibly repeating.
 *
 * HarborScene owns the motion; this is the source art and the numbers that make
 * one layer distinct from the other.
 */
export const CLOUD_LAYERS = [
  // Nearer and faster: the shadows you actually notice crossing the docks.
  { key: 'cloud-shadow-near', size: 1024, seed: 0x51a7, clouds: 4, radius: 24, alpha: 0.38, driftX: 11, driftY: 4 },
  // Higher and slower: a single sparse bank. Its sheet is a quarter the area
  // of the near one, so the same cloud count would make it the denser layer.
  { key: 'cloud-shadow-far', size: 512, seed: 0x2c3d, clouds: 1, radius: 24, alpha: 0.24, driftX: 5.5, driftY: 1.8 },
];

/**
 * Shadow colour: a cool near-black. PALETTE.skyTop was the first choice and sat
 * so close to waterDeep that it tinted the harbor instead of darkening it.
 */
const CLOUD_COLOR = '#101a2e';

/**
 * World pixels per shadow "pixel".
 *
 * Close to the harbor backdrop's own art pixel, which is around 3. Still
 * visibly blocky, but fine enough that the outline steps read as a stair rather
 * than as tiles. This is the number to change if the shadows come out too
 * coarse or too fine; `radius` in CLOUD_LAYERS is measured in these blocks, so
 * halving one means doubling the other to keep clouds the same size.
 */
const CLOUD_PIXEL = 4;

const CLOUD_LOBES = 4;

/**
 * Density bands, densest first: how much shadow each block gets.
 *
 * Four bands rather than a single cut. One threshold gives a hard cliff from
 * full shadow to nothing, which is legible but harsh; stepping down through
 * three intermediate tones lets the edge fall off the way a hand-drawn shadow
 * does, without smuggling a gradient back in -- every block still lands on one
 * of four flat tones.
 *
 * How *wide* the bands are as a group is what actually controls the softness:
 * they span the density range over which a cloud fades out, so widening the
 * span spreads the steps over more blocks and gentles the edge. Evenly spaced
 * so the stair reads the same all the way round a cloud.
 */
const CLOUD_BANDS = [
  { above: 0.58, alpha: 1 },
  { above: 0.46, alpha: 0.75 },
  { above: 0.36, alpha: 0.5 },
  { above: 0.26, alpha: 0.25 },
];

/** Per-block noise, so the cut edges fray a little instead of arcing cleanly. */
const CLOUD_JITTER = 0.04;

/**
 * Fishing-spot pool: the dark patch of water a player clicks on to fish.
 *
 * This one is a smooth gradient, unlike the cloud shadows above -- a deliberate
 * exception to the hard-edged rule the rest of this file follows. A shadow is
 * cast onto the surface and wants a cut silhouette; a pool is a hole in the
 * water seen from above, and any visible boundary makes it a disc lying on top
 * of the harbour rather than something you can see down into. It was drawn in
 * stepped bands first and read as a stamped-on sticker.
 *
 * The colour is the harbour's own water pushed several stops darker rather than
 * a neutral grey, so the pool reads as depth instead of as a shadow cast by
 * something off-screen.
 *
 * COUPLING: SPOT_WIDTH/SPOT_HEIGHT mirror the same names in
 * world/fishing-spots.js, which hit-tests clicks against this footprint.
 */
const SPOT_WIDTH = 60;
const SPOT_HEIGHT = 34;
const SPOT_COLOR = [10, 47, 69];
/**
 * Normalised radius -> alpha. Deliberately not a straight ramp: it holds near
 * full strength across the middle and then gives most of its falloff away in
 * the outer third, which is what makes the centre read as deep rather than as
 * the brightest point of a blur.
 */
const SPOT_FALLOFF = [
  [0, 0.62],
  [0.34, 0.56],
  [0.62, 0.4],
  [0.84, 0.17],
  [1, 0],
];

/** A fish silhouette circling under a pool. Dark blue rather than black, so it reads as something swimming in the water instead of a flat cutout. */
const SPOT_FISH_COLOR = '#0f2a52';

/** Body drawn in a neutral tone so a per-tier tint reads true. */
const CHEST_CLOSED = [
  '................',
  '................',
  '...LLLLLLLLLL...',
  '..LBBBBBBBBBBL..',
  '..LBBBBBBBBBBL..',
  '..LLLLLGGLLLLL..',
  '..LBBBBBGGBBBBL.',
  '..LBBBBBGGBBBBL.',
  '..LBBBBBBBBBBBL.',
  '..LLLLLLLLLLLLL.',
  '................',
];

const CHEST_OPEN = [
  '..LLLLLLLLLLLL..',
  '..LDDDDDDDDDDL..',
  '..LLLLLLLLLLLL..',
  '................',
  '..LLLLLLLLLLLL..',
  '..LDDDDDDDDDDL..',
  '..LBBBBBGGBBBBL.',
  '..LBBBBBGGBBBBL.',
  '..LBBBBBBBBBBBL.',
  '..LLLLLLLLLLLLL.',
  '................',
];

/** Darkens a hex colour, used for the chest's shaded frame. */
function shade(hexColor, factor) {
  const value = Number.parseInt(hexColor.slice(1), 16);
  const clamp = (channel) => Math.max(0, Math.min(255, Math.round(channel * factor)));
  const red = clamp((value >> 16) & 0xff);
  const green = clamp((value >> 8) & 0xff);
  const blue = clamp(value & 0xff);
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, '0')}`;
}

/** Deterministic per-block noise, so the frayed edge is stable across reloads. */
function blockNoise(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The lobes making up one sheet's clouds.
 *
 * A cloud is a cluster of overlapping ellipses rather than one blob: a single
 * ellipse cut at a threshold gives a smooth oval, which reads as a stain on the
 * water. Overlapping lobes give the bulged, lumpy outline that says "cloud" the
 * moment its edge is hard. The cluster is stretched along the wind (the 1.6 and
 * 0.7 below) for the same reason the individual lobes are.
 */
function cloudLobes(random, grid, { clouds, radius }) {
  const between = (min, max) => min + random() * (max - min);
  const lobes = [];

  for (let i = 0; i < clouds; i += 1) {
    const cx = random() * grid;
    const cy = random() * grid;
    const base = between(radius, radius * 1.8);
    // One angle per cloud, not per lobe: the whole thing leans into the wind.
    const angle = between(-0.4, 0.4);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let j = 0; j < CLOUD_LOBES; j += 1) {
      const offset = between(0, base * 0.9);
      const direction = random() * Math.PI * 2;
      lobes.push({
        x: cx + Math.cos(direction) * offset * 1.6,
        y: cy + Math.sin(direction) * offset * 0.7,
        r: base * between(0.55, 1),
        stretch: between(1.2, 2),
        cos,
        sin,
      });
    }
  }
  return lobes;
}

/**
 * One seamlessly tiling sheet of hard-edged pixel cloud shadows.
 *
 * The density field is evaluated per CLOUD_PIXEL block, not per pixel, and each
 * block is then quantised to one of the CLOUD_BANDS tones. Flat tones with a
 * stepped boundary are what make it read as drawn rather than as a soft overlay
 * that happens to be dark -- there is no gradient anywhere in the result, and
 * the texture stays on NEAREST filtering so nothing smooths the steps back out.
 *
 * Seams are handled by measuring every distance the short way around the sheet
 * (the wrap below), which makes the field itself periodic. The earlier soft
 * version painted each blob nine times to get the same effect; wrapping the
 * distance is both cheaper and exact.
 *
 * Seeded, like the other generated art here: an unseeded sky would look
 * different for every player standing in the same harbor.
 */
function makeCloudShadowTexture(scene, layer) {
  const { key, size, seed } = layer;

  return makeCanvasTexture(scene, key, size, size, (context) => {
    const grid = size / CLOUD_PIXEL;
    const lobes = cloudLobes(seeded(seed), grid, layer);
    const half = grid / 2;

    const density = new Float32Array(grid * grid);
    for (let cy = 0; cy < grid; cy += 1) {
      for (let cx = 0; cx < grid; cx += 1) {
        let sum = 0;

        for (const lobe of lobes) {
          let dx = cx + 0.5 - lobe.x;
          let dy = cy + 0.5 - lobe.y;
          // Shortest way round the torus, which is what makes the sheet tile.
          if (dx > half) dx -= grid; else if (dx < -half) dx += grid;
          if (dy > half) dy -= grid; else if (dy < -half) dy += grid;

          const rx = (dx * lobe.cos + dy * lobe.sin) / lobe.stretch;
          const ry = -dx * lobe.sin + dy * lobe.cos;
          const falloff = 1 - (rx * rx + ry * ry) / (lobe.r * lobe.r);
          if (falloff > 0) sum += falloff * falloff;
        }

        density[cy * grid + cx] = sum + (blockNoise(cx, cy) - 0.5) * CLOUD_JITTER;
      }
    }

    // Resolve each block to its band once, rather than re-testing the bands for
    // every one of the CLOUD_PIXEL^2 pixels that block covers.
    const shade = new Uint8Array(grid * grid);
    for (let i = 0; i < density.length; i += 1) {
      for (const band of CLOUD_BANDS) {
        if (density[i] >= band.above) {
          shade[i] = Math.round(255 * band.alpha);
          break;
        }
      }
    }

    const red = Number.parseInt(CLOUD_COLOR.slice(1, 3), 16);
    const green = Number.parseInt(CLOUD_COLOR.slice(3, 5), 16);
    const blue = Number.parseInt(CLOUD_COLOR.slice(5, 7), 16);

    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      const row = ((y / CLOUD_PIXEL) | 0) * grid;
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4;
        image.data[offset] = red;
        image.data[offset + 1] = green;
        image.data[offset + 2] = blue;
        image.data[offset + 3] = shade[row + ((x / CLOUD_PIXEL) | 0)];
      }
    }
    context.putImageData(image, 0, 0);
  });
}

/**
 * One fishing-spot pool: a radial gradient squashed to the pool's proportions.
 *
 * Drawn as a circular gradient under a vertical scale rather than as an ellipse
 * gradient, because the two-circle form of createRadialGradient can only give
 * concentric circles -- squashing the whole context is what turns it into the
 * flattened oval a top-down view wants, and keeps the falloff even all the way
 * round instead of bunching up at the ends.
 */
function makeFishingSpotTexture(scene) {
  return makeCanvasTexture(scene, 'fishing-spot', SPOT_WIDTH, SPOT_HEIGHT, (context, width, height) => {
    const [red, green, blue] = SPOT_COLOR;
    const radius = width / 2;

    context.save();
    context.translate(width / 2, height / 2);
    context.scale(1, height / width);

    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
    for (const [stop, alpha] of SPOT_FALLOFF) {
      gradient.addColorStop(stop, `rgba(${red}, ${green}, ${blue}, ${alpha})`);
    }

    context.fillStyle = gradient;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  });
}

/** Registers every effect texture. Safe to call more than once. */
export function makeEffectTextures(scene) {
  for (const layer of CLOUD_LAYERS) makeCloudShadowTexture(scene, layer);

  makeFishingSpotTexture(scene);

  // Outline drawn just clear of the pool, used for hover and for marking the
  // spot the angler is currently fishing. Kept a separate texture rather than
  // baked into the pool so it can be faded and tinted on its own.
  makeCanvasTexture(scene, 'fishing-spot-ring', SPOT_WIDTH + 12, SPOT_HEIGHT + 12, (context, width, height) => {
    context.strokeStyle = PALETTE.waterFoam;
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(width / 2, height / 2, width / 2 - 2, height / 2 - 2, 0, 0, Math.PI * 2);
    context.stroke();
  });

  // The fish circling under a pool. Near-black rather than tinted by rarity:
  // these are shapes moving under the surface, and the whole point of the pool
  // is that you cannot tell what is in it until you cast.
  makeCanvasTexture(scene, 'spot-fish', 14, 7, (context) => {
    context.fillStyle = SPOT_FISH_COLOR;
    context.beginPath();
    context.ellipse(6, 3.5, 5, 2.5, 0, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(11, 3.5);
    context.lineTo(14, 1);
    context.lineTo(14, 6);
    context.closePath();
    context.fill();
  });

  // One texture per chest tier rather than one tinted texture: Phaser's tint
  // multiplies, so tinting a brown chest with a brown tier colour produces
  // near-black, and tinting a gold one washes the latch out entirely.
  for (const [tier, color] of Object.entries(PALETTE.chest)) {
    const colors = {
      L: shade(color, 0.42),
      B: color,
      D: '#1a1018',
      G: PALETTE.gold,
    };
    makePixelTexture(scene, `chest-closed-${tier}`, CHEST_CLOSED, colors, 1);
    makePixelTexture(scene, `chest-open-${tier}`, CHEST_OPEN, colors, 1);
  }

  // Soft ring used for the level-up burst; scaled and faded at runtime.
  makeCanvasTexture(scene, 'ring', 64, 64, (context) => {
    context.strokeStyle = PALETTE.gold;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(32, 32, 28, 0, Math.PI * 2);
    context.stroke();
  });

  // A single bright pixel cluster, used as a particle for splashes and sparkle.
  makeCanvasTexture(scene, 'spark', 4, 4, (context) => {
    context.fillStyle = '#ffffff';
    context.fillRect(1, 0, 2, 4);
    context.fillRect(0, 1, 4, 2);
  });

  makeCanvasTexture(scene, 'droplet', 3, 3, (context) => {
    context.fillStyle = PALETTE.waterFoam;
    context.fillRect(0, 0, 3, 3);
  });

  // Ripple ring drawn thin so it reads as water rather than a halo.
  makeCanvasTexture(scene, 'ripple', 32, 20, (context) => {
    context.strokeStyle = PALETTE.waterFoam;
    context.lineWidth = 1.5;
    context.beginPath();
    context.ellipse(16, 10, 14, 7, 0, 0, Math.PI * 2);
    context.stroke();
  });

  // Soft contact shadow anchored under the angler's feet. A flat ellipse
  // reads as a sticker; a radial gradient squashed vertically fades into the
  // ground the way an actual cast shadow does.
  makeCanvasTexture(scene, 'angler-shadow', 40, 20, (context, width, height) => {
    const cx = width / 2;
    const cy = height / 2;
    context.save();
    context.translate(cx, cy);
    context.scale(1, 0.45);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, cx);
    gradient.addColorStop(0, 'rgba(8, 6, 4, 0.45)');
    gradient.addColorStop(1, 'rgba(8, 6, 4, 0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(0, 0, cx, 0, Math.PI * 2);
    context.fill();
    context.restore();
  });

  // Fish silhouettes drifting under the surface, one per rarity colour.
  for (const [tier, color] of Object.entries(PALETTE.rarity)) {
    makeCanvasTexture(scene, `fish-shadow-${tier}`, 16, 8, (context) => {
      context.fillStyle = color;
      context.globalAlpha = 0.5;
      context.beginPath();
      context.ellipse(7, 4, 6, 2.5, 0, 0, Math.PI * 2);
      context.fill();
      // Tail
      context.beginPath();
      context.moveTo(13, 4);
      context.lineTo(16, 1);
      context.lineTo(16, 7);
      context.closePath();
      context.fill();
    });
  }
}

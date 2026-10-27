/**
 * Tiny pixel-art helper.
 *
 * Every sprite in this game is generated at boot from a character map rather
 * than loaded from an image. That keeps the whole client self-contained (no
 * sprite-sheet pipeline, no CORS-sensitive asset host, nothing to 404 on a
 * cold Firebase deploy) and makes recolouring a one-line change.
 *
 * A map is an array of equal-length strings; each character indexes into a
 * colour lookup. '.' and ' ' are transparent.
 */

/**
 * Renders `rows` into a Phaser texture registered under `key`.
 *
 * @param {Phaser.Scene} scene
 * @param {string} key       texture key to register
 * @param {string[]} rows    the pixel map
 * @param {Record<string,string>} colors  char -> '#rrggbb'
 * @param {number} scale     pixels per map cell
 */
export function makePixelTexture(scene, key, rows, colors, scale = 1) {
  if (scene.textures.exists(key)) return key;

  const width = Math.max(...rows.map((row) => row.length));
  const height = rows.length;

  const canvas = scene.textures.createCanvas(key, width * scale, height * scale);
  const context = canvas.getContext();
  context.imageSmoothingEnabled = false;

  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      const char = row[x];
      if (char === '.' || char === ' ') continue;

      const color = colors[char];
      if (!color) continue;

      context.fillStyle = color;
      context.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  canvas.refresh();
  return key;
}

/**
 * Renders a texture from a draw callback given a 2D context. Used for the
 * gradients and noise fields that would be tedious as character maps.
 */
export function makeCanvasTexture(scene, key, width, height, draw) {
  if (scene.textures.exists(key)) return key;

  const canvas = scene.textures.createCanvas(key, width, height);
  const context = canvas.getContext();
  context.imageSmoothingEnabled = false;

  draw(context, width, height);

  canvas.refresh();
  return key;
}

/**
 * Deterministic pseudo-random in [0,1) from an integer seed.
 *
 * Used for scatter patterns (water sparkles, grass flecks) so the generated
 * textures look identical on every device and every reload -- an unseeded
 * Math.random() here would make the harbor shimmer differently per client.
 */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

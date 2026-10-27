/**
 * The shared harbor: tilemap, avatars, movement and all fishing feedback.
 *
 * This scene renders state; it decides nothing. Catches, rewards and level-ups
 * arrive from the server as events and are turned into pixels here. The only
 * thing the client decides on its own is where the local avatar walks, which
 * buys the player nothing (see the `move` handler in HarborRoom).
 */

import Phaser from 'phaser';

import {
  BAND,
  FEET,
  TILE,
  WORLD_COLUMNS,
  WORLD_HEIGHT,
  WORLD_ROWS,
  WORLD_WIDTH,
  buildLevel,
  canStandAt,
  tileToStand,
  tileToWorld,
  worldToTile,
} from '../world/level.js';
import {
  FISHING_SPOTS,
  SPOT_HEIGHT,
  SPOT_WIDTH,
  spotAtStand,
  spotAtWorld,
  spotCentre,
} from '../world/fishing-spots.js';
import { findPath, nearestWalkable } from '../world/pathfind.js';
import {
  frameName,
  makeAnglerTexture,
  randomVariantIndex,
  rodTipFor,
} from '../art/characters.js';
import { FONT_FAMILY, PALETTE, hex } from '../art/palette.js';
import { CLOUD_LAYERS } from '../art/effects.js';
import { frameIndex } from '../art/icons.js';
import { isTyping } from '../ui/typing.js';

const WALK_SPEED = 130;         // px per second
const WALK_FRAME_MS = 150;

/** Clear the sprite's head, plus a small gap, when placing its name tag. */
const LABEL_GAP_Y = 4;
const MOVE_SEND_MS = 100;       // avatar sync rate, inside the server's budget
/** How long the angler must stand still before the idle loop resumes. */
const RESUME_FISHING_MS = 450;
const ARRIVE_EPSILON = 1.5;

/**
 * Cloud shadows draw above the anglers, not behind them.
 *
 * A shadow that stops at a character's feet reads as a stain on the ground; one
 * that passes over their hat reads as weather. 800 keeps it under the effects
 * container (900) and the floating text, so a catch is never dimmed by passing
 * cloud -- sparks and numbers are light the harbor emits, not surface it has.
 */
const CLOUD_DEPTH = 800;

/**
 * Fishing pools sit just above the backdrop; the fish circling in them sit
 * above the drifting ambient fish (5), so a pool always reads as one object
 * rather than as scenery something else happens to be swimming through.
 */
const SPOT_DEPTH = 4;
const SPOT_RING_DEPTH = 6;
const SPOT_FISH_DEPTH = 7;
const SPOT_FISH_PER_POOL = 3;
/** Ring opacity when a pool is merely under the cursor, and when it is being fished. */
const SPOT_RING_HOVER = 0.45;
const SPOT_RING_ACTIVE = 0.75;

/**
 * Sunlight glints on the open water.
 *
 * Sits above the drifting ambient fish (5) and the fishing-spot silhouettes
 * (7) so a sparkle reads as sitting ON the surface, not under it -- and below
 * every interaction effect near the water (droplet 96, ripple 97, the cast
 * line 99) so a catch is never fighting a glint for attention.
 */
const WATER_SPARKLE_DEPTH = 8;
/**
 * Share of open-water tiles that get a sparkle. Sampled once at boot, not
 * one-per-tile: one-per-tile reads as a grid, and this is meant to read as
 * scattered light. Low enough to stay a shimmer rather than foam.
 */
const WATER_SPARKLE_DENSITY = 0.06;

const FACING_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export class HarborScene extends Phaser.Scene {
  constructor() {
    super('Harbor');
    /** sessionId -> { sprite, label, state, facing, casting, ripple } */
    this.avatars = new Map();
    this.lastMoveSentAt = 0;
    this.path = [];
    this.wasAtSpot = null;
    this.wasFishing = null;
    /** The pool being fished, the one being walked to, and the one hovered. */
    this.activeSpot = null;
    this.pendingSpot = null;
    this.hoveredSpot = null;
    // Start already settled: a player joins standing on the boardwalk, and
    // counting up from zero made the first cast start and then immediately
    // cancel itself.
    this.stillFor = RESUME_FISHING_MS;
    // sessionId -> angler sheet index. The roll is local to this client, so
    // two players may see a third one differently, but it is remembered for
    // as long as the tab lives -- otherwise someone who walks out of range
    // and back would change clothes on the way.
    this.anglerVariants = new Map();
  }

  init(data) {
    this.meta = data.meta;
    this.anglerMeta = data.anglerMeta;
    this.net = this.game.registry.get('net');
    this.hud = this.game.registry.get('hud');
  }

  create() {
    this.level = buildLevel();

    this.buildTerrain();
    this.buildProps();
    this.buildFishingSpots();
    this.buildAmbientFish();
    this.buildWaterSparkles();
    this.buildCloudShadows();

    this.effects = this.add.container(0, 0).setDepth(900);

    this.setupCamera();
    this.setupInput();
    this.bindNetwork();

    // Players already in the room when we joined.
    for (const [sessionId, player] of this.net.players) {
      this.addAvatar(sessionId, player);
    }

    this.scale.on('resize', this.handleResize, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.handleResize, this));
  }

  /* --------------------------------------------------------------- world */

  buildTerrain() {
    this.add.image(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 'harbor-environment').setDepth(0);
    this.cameras.main.setBackgroundColor(PALETTE.waterDeep);
  }

  buildProps() {
    // Buildings, docks, shore details, and trees are baked into the backdrop.
  }

  /**
   * The fishing pools.
   *
   * Each is a dark patch of water with a few silhouettes circling under it and
   * a ring that lights up under the cursor. Unlike the ambient fish these are
   * not decoration: a pool is the only place fishing starts, and clicking one
   * is what walks the angler over and casts (see selectSpot).
   *
   * The whole set is static -- a handful of authored positions, built once. Nothing
   * here is synced: every client draws the same pools in the same places
   * because they come from the same table, and which pool a remote angler is
   * fishing is read off the plank they are standing on rather than sent.
   */
  buildFishingSpots() {
    this.spots = FISHING_SPOTS.map((spot) => {
      const centre = spotCentre(spot);

      const pool = this.add.image(centre.x, centre.y, 'fishing-spot').setDepth(SPOT_DEPTH);
      const ring = this.add
        .image(centre.x, centre.y, 'fishing-spot-ring')
        .setDepth(SPOT_RING_DEPTH)
        .setAlpha(0);

      // Each fish gets its own ellipse and its own speed, half of them going
      // the other way round: three fish on one shared orbit reads as a clock
      // face rather than as something alive.
      const fish = [];
      for (let i = 0; i < SPOT_FISH_PER_POOL; i += 1) {
        const spread = Phaser.Math.FloatBetween(0.15, 0.26);
        fish.push({
          sprite: this.add
            .image(centre.x, centre.y, 'spot-fish')
            .setDepth(SPOT_FISH_DEPTH)
            .setAlpha(0.72),
          angle: (Math.PI * 2 * i) / SPOT_FISH_PER_POOL + Phaser.Math.FloatBetween(0, 0.7),
          // The pool is wider than it is tall, and so is every orbit in it:
          // keeping the two in proportion is what sells the top-down angle.
          radiusX: SPOT_WIDTH * spread,
          radiusY: SPOT_HEIGHT * spread,
          speed: Phaser.Math.FloatBetween(0.32, 0.58) * (i % 2 === 0 ? 1 : -1),
        });
      }

      return { spot, centre, pool, ring, fish, tint: null };
    });
  }

  /** Walks the silhouettes round their orbits. Purely cosmetic. */
  driftSpotFish(step) {
    for (const entry of this.spots) {
      for (const fish of entry.fish) {
        fish.angle += fish.speed * step;

        // Rounded for the same reason the clouds are: this is pixel art at a
        // fractional camera zoom, and a sub-pixel position makes a 14px
        // silhouette shimmer along its own edge.
        fish.sprite.setPosition(
          Math.round(entry.centre.x + Math.cos(fish.angle) * fish.radiusX),
          Math.round(entry.centre.y + Math.sin(fish.angle) * fish.radiusY),
        );
        // Face the way it is actually travelling: d/dangle of x is -sin(angle).
        fish.sprite.setFlipX(-Math.sin(fish.angle) * fish.speed < 0);
      }
    }
  }

  /**
   * Rings: faint under the cursor, brighter and gold on the pool being fished.
   *
   * Eased toward the target rather than snapped, so sweeping the mouse across
   * the harbour doesn't strobe every pool it passes over.
   */
  updateSpotHighlight(time, step) {
    const smoothing = Math.min(1, step * 9);

    for (const entry of this.spots) {
      const chosen = entry.spot === this.activeSpot || entry.spot === this.pendingSpot;
      const pulse = chosen ? Math.sin(time / 320) * 0.12 : 0;
      const target = chosen
        ? SPOT_RING_ACTIVE + pulse
        : (entry.spot === this.hoveredSpot ? SPOT_RING_HOVER : 0);

      entry.ring.alpha += (target - entry.ring.alpha) * smoothing;

      const tint = chosen ? PALETTE.gold : PALETTE.waterFoam;
      if (tint !== entry.tint) {
        entry.tint = tint;
        entry.ring.setTint(hex(tint));
      }
    }
  }

  /**
   * Fish silhouettes drifting under the surface. Purely atmospheric -- they are
   * not the fish you catch, and nothing about them touches the server.
   */
  buildAmbientFish() {
    const tiers = Object.keys(PALETTE.rarity);
    this.ambientFish = [];

    for (let i = 0; i < 14; i += 1) {
      const tier = tiers[i % tiers.length];
      const y = Phaser.Math.Between(BAND.waterTop + 2, WORLD_ROWS - 2) * TILE;
      const sprite = this.add
        .image(Phaser.Math.Between(0, WORLD_WIDTH), y, `fish-shadow-${tier}`)
        .setDepth(5)
        .setAlpha(0.55);

      const speed = Phaser.Math.FloatBetween(6, 16) * (Math.random() < 0.5 ? -1 : 1);
      sprite.setFlipX(speed < 0);
      this.ambientFish.push({ sprite, speed });
    }
  }

  /**
   * Points of light scattered over the open water, each fading in and out on
   * its own clock -- sun catching the ripples rather than anything with a
   * game-facing meaning, so unlike the fishing spots nothing here couples to
   * gameplay and unlike the ambient fish nothing needs a per-frame update.
   *
   * Positions are sampled off `level.water`, the same pixel-traced grid the
   * fishing spots and open-water casts read from, which is what keeps a
   * sparkle from ever landing on shore. `level.deck` is checked too: the
   * water grid doesn't know the piers baked into the backdrop are there, and
   * a bright glint sitting on painted planking reads as a mistake in a way a
   * dim ambient fish drifting under a dock does not.
   */
  buildWaterSparkles() {
    const { water, deck } = this.level;
    const candidates = [];

    for (let ty = BAND.waterTop; ty < WORLD_ROWS; ty += 1) {
      for (let tx = 0; tx < WORLD_COLUMNS; tx += 1) {
        if (!water[ty][tx] || deck[ty][tx] !== -1) continue;
        candidates.push({ tx, ty });
      }
    }

    Phaser.Utils.Array.Shuffle(candidates);
    const count = Math.round(candidates.length * WATER_SPARKLE_DENSITY);

    // Someone who has asked the OS for less motion gets steady, dim glints
    // instead of a twinkle -- same trade the cloud shadows make: the effect
    // stays, only the animation drops.
    this.sparklesTwinkle = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    this.waterSparkles = candidates
      .slice(0, count)
      .map(({ tx, ty }) => this.spawnWaterSparkle(tx, ty));
  }

  /** One glint: reuses the `spark` texture from the catch-celebration burst, tinted pale rather than gold. */
  spawnWaterSparkle(tx, ty) {
    const x = tx * TILE + Phaser.Math.Between(4, TILE - 4);
    const y = ty * TILE + Phaser.Math.Between(4, TILE - 4);
    const tint = Math.random() < 0.5 ? PALETTE.white : PALETTE.waterFoam;
    const peak = Phaser.Math.FloatBetween(0.35, 0.8);

    const sparkle = this.add
      .image(x, y, 'spark')
      .setDepth(WATER_SPARKLE_DEPTH)
      .setTint(hex(tint))
      .setScale(Phaser.Math.FloatBetween(0.5, 1))
      .setAlpha(this.sparklesTwinkle ? 0 : peak * 0.6);

    if (this.sparklesTwinkle) {
      this.tweens.add({
        targets: sparkle,
        alpha: peak,
        duration: Phaser.Math.Between(500, 900),
        ease: 'Sine.easeInOut',
        yoyo: true,
        repeat: -1,
        // Staggers both the first twinkle and every one after, so the water
        // never settles into a visible beat.
        delay: Phaser.Math.Between(0, 3000),
        repeatDelay: Phaser.Math.Between(400, 2200),
      });
    }

    return sparkle;
  }

  /**
   * Cloud shadows crossing the harbor.
   *
   * Two tiling sheets rather than one: a near layer that moves at a noticeable
   * clip and a slower, fainter far layer over it. The offset speeds mean the two
   * patterns never line up the same way twice, so the sky doesn't visibly loop
   * even though each sheet is a single tiling texture.
   *
   * Both sheets draw at 1:1 -- no tile scale. The textures are authored in
   * chunky blocks (see CLOUD_PIXEL in art/effects.js) and left on the project's
   * default NEAREST filtering, which is the whole point: the shadow edge should
   * be a hard, stepped, obviously-drawn line, not a soft one.
   *
   * Sized to the whole world and left at the default scroll factor: the camera
   * is bounded to the world (see setupCamera), so one world-sized tileSprite
   * covers every viewport without having to chase the camera each frame.
   */
  buildCloudShadows() {
    this.clouds = [];

    for (const layer of CLOUD_LAYERS) {
      if (!this.textures.exists(layer.key)) continue;

      const sprite = this.add
        .tileSprite(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, WORLD_WIDTH, WORLD_HEIGHT, layer.key)
        .setDepth(CLOUD_DEPTH)
        .setAlpha(layer.alpha);

      // Start each sheet somewhere arbitrary so a fresh session doesn't always
      // open with the same patch of shade over the boardwalk. The float is kept
      // alongside the sprite because `tilePosition` is rounded -- see driftClouds.
      const cloud = {
        sprite,
        driftX: layer.driftX,
        driftY: layer.driftY,
        x: Phaser.Math.Between(0, layer.size),
        y: Phaser.Math.Between(0, layer.size),
      };
      sprite.tilePositionX = cloud.x;
      sprite.tilePositionY = cloud.y;

      this.clouds.push(cloud);
    }

    // Someone who has asked the OS for less motion gets the shadows without the
    // drift: the depth is still there, nothing crawls across their screen.
    this.cloudsDrift = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  /* -------------------------------------------------------------- camera */

  setupCamera() {
    const camera = this.cameras.main;
    camera.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    camera.setRoundPixels(true);
    camera.setZoom(this.pickZoom());
  }

  /**
   * The harbor is one composed illustration rather than a repeating tilemap.
   * Keep it at its authored scale on any viewport the backdrop already fills,
   * and past that zoom by exactly what it takes to go on covering it: the
   * camera is bounded to the world, so a shortfall shows as bands of flat
   * water down the edges.
   *
   * The factor used to be rounded up to a whole number and capped at 2, which
   * made a viewport one pixel wider than the backdrop jump straight to double
   * size -- a maximised browser at 1920x1080 got a quarter of the harbour,
   * enlarged. Covering is a continuous requirement, so the measured factor is
   * used as it comes. That costs some crispness, since `pixelArt` means
   * nearest-neighbour and a 1.25x zoom draws some source pixels wider than
   * others, and that is much the cheaper of the two problems.
   */
  pickZoom() {
    const { width, height } = this.scale;
    return Math.max(1, width / WORLD_WIDTH, height / WORLD_HEIGHT);
  }

  handleResize() {
    const zoom = this.pickZoom();
    if (this.cameras.main.zoom === zoom) return;

    this.cameras.main.setZoom(zoom);
    for (const avatar of this.avatars.values()) this.scaleLabel(avatar.label, zoom);
  }

  /**
   * Name tags live in world space, so the camera zoom would scale them along
   * with the art and a 4x zoom would render a name taller than the character.
   * Rendering at a fixed size and dividing out the zoom pins them to a constant
   * on-screen size; the doubled resolution keeps them sharp.
   */
  scaleLabel(label, zoom = this.cameras.main.zoom) {
    label.setResolution(2);
    label.setScale(1 / zoom);
  }

  /**
   * The current fisherman frames have substantial transparent headroom and a
   * feet anchor near their bottom. Keep labels tied to that authored anchor
   * instead of a stale, fixed offset from the previous small character art.
   */
  nameLabelY(feetY) {
    return feetY - (this.anglerMeta.feetY ?? 0) - LABEL_GAP_Y;
  }

  /* --------------------------------------------------------------- input */

  setupInput() {
    // Capture is off (the `false`). Phaser listens on `window`, and with
    // capture on it calls preventDefault for every key it knows -- which ate
    // the W, A, S and D out of anything typed into the HUD before the input
    // element ever saw them. Nothing in the page scrolls (html and body are
    // `overflow: hidden`), so the arrows cost nothing by staying uncaptured.
    this.keys = this.input.keyboard.addKeys(
      {
        up: Phaser.Input.Keyboard.KeyCodes.W,
        down: Phaser.Input.Keyboard.KeyCodes.S,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        right: Phaser.Input.Keyboard.KeyCodes.D,
        upArrow: Phaser.Input.Keyboard.KeyCodes.UP,
        downArrow: Phaser.Input.Keyboard.KeyCodes.DOWN,
        leftArrow: Phaser.Input.Keyboard.KeyCodes.LEFT,
        rightArrow: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      },
      false,
    );

    // Typing in the chat box must not walk the angler across the harbor. The
    // old stopPropagation here was too late: Phaser sets `key.isDown` before it
    // emits, so movement read the keystroke anyway. Handing the keyboard over
    // wholesale while a text field has focus is the thing that actually holds.
    this.syncKeyboardOwner = () => {
      const typing = isTyping();
      this.input.keyboard.enabled = !typing;
      if (!typing) return;

      // A direction held as focus moved would otherwise stay down forever,
      // walking the angler into a wall for the length of the message.
      this.input.keyboard.resetKeys();
      this.path = [];
    };

    this.syncKeyboardOwner();
    document.addEventListener('focusin', this.syncKeyboardOwner);
    document.addEventListener('focusout', this.syncKeyboardOwner);
    this.events.once('shutdown', () => {
      document.removeEventListener('focusin', this.syncKeyboardOwner);
      document.removeEventListener('focusout', this.syncKeyboardOwner);
    });

    this.input.on('pointerdown', (pointer) => {
      if (pointer.event?.target?.closest?.('.hud')) return; // click landed on the HUD
      this.handleClick(pointer);
    });

    // Hover feedback for the pools. Hit testing is done here rather than by
    // making each pool a Phaser interactive object: a pool sits on top of
    // walkable water-edge tiles, and letting Phaser dispatch its own
    // gameobject event alongside this scene's pointerdown meant one click
    // could both pick a pool and walk the angler somewhere else.
    this.input.on('pointermove', (pointer) => {
      this.hoveredSpot = pointer.event?.target?.closest?.('.hud')
        ? null
        : this.spotUnderPointer(pointer);
      this.input.setDefaultCursor(this.hoveredSpot ? 'pointer' : 'default');
    });
    this.events.once('shutdown', () => this.input.setDefaultCursor('default'));
  }

  spotUnderPointer(pointer) {
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return spotAtWorld(world.x, world.y);
  }

  /** A click on a pool starts a fishing trip; anything else is a walk. */
  handleClick(pointer) {
    const self = this.avatars.get(this.net.sessionId);
    if (!self) return;

    const spot = this.spotUnderPointer(pointer);
    if (spot) {
      this.selectSpot(spot, self);
      return;
    }

    // Walking anywhere of your own accord gives up the pool you were at.
    this.clearSpot();
    this.handleClickToMove(pointer, self);
  }

  handleClickToMove(pointer, self) {
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const target = worldToTile(world.x, world.y);
    const walkable = nearestWalkable(this.level.pathSolid, target.tx, target.ty);
    if (!walkable) return;

    const from = worldToTile(self.sprite.x, self.sprite.y + FEET.offsetY);
    this.path = findPath(this.level.pathSolid, from, walkable);

    if (this.path.length > 0) this.showMoveMarker(walkable);
  }

  /**
   * Sends the angler to a pool.
   *
   * The route goes to the pool's own authored plank rather than to whatever
   * happens to be nearest the click, so two players clicking the same pool from
   * opposite ends of the dock end up fishing it from the same place -- and so
   * the plank is always one the level actually calls fishable.
   *
   * Arrival is not handled here: the walk takes as long as it takes, and
   * moveSelf flips `pendingSpot` to `activeSpot` when the feet land.
   */
  selectSpot(spot, avatar) {
    const from = worldToTile(avatar.sprite.x, avatar.sprite.y + FEET.offsetY);

    if (from.tx === spot.stand.tx && from.ty === spot.stand.ty) {
      this.path = [];
      this.arriveAtSpot(spot, avatar);
      this.showMoveMarker(spot.stand);
      return;
    }

    const path = findPath(this.level.pathSolid, from, { tx: spot.stand.tx, ty: spot.stand.ty });
    if (path.length === 0) {
      this.hud?.setStatus('No way through to that fishing spot', 'warn', 2400);
      return;
    }

    this.path = path;
    this.pendingSpot = spot;
    this.activeSpot = null;
    this.showMoveMarker(spot.stand);
  }

  /** The angler is on the plank: turn to the water and let the idle loop start. */
  arriveAtSpot(spot, avatar) {
    this.pendingSpot = null;
    this.activeSpot = spot;
    // Facing is authored per spot rather than derived, so a pool sitting off
    // the corner of a plank doesn't turn the angler along the wrong axis. The
    // next sync tick carries it to everyone else.
    avatar.facing = spot.facing;
  }

  clearSpot() {
    this.activeSpot = null;
    this.pendingSpot = null;
  }

  showMoveMarker(tile) {
    const world = tileToWorld(tile.tx, tile.ty);
    const marker = this.add
      .image(world.x, world.y, 'ripple')
      .setDepth(15)
      .setTint(hex(PALETTE.gold))
      .setScale(0.4);

    this.tweens.add({
      targets: marker,
      scale: 0.75,
      alpha: 0,
      duration: 420,
      onComplete: () => marker.destroy(),
    });
  }

  /* ------------------------------------------------------------- avatars */

  addAvatar(sessionId, state) {
    if (this.avatars.has(sessionId)) return;

    const variant = this.anglerVariantFor(sessionId);
    const textureKey = makeAnglerTexture(this, variant, this.anglerMeta);

    const { frameHeight, feetY } = this.anglerMeta;

    // Grounds the sprite -- without it the angler reads as floating,
    // especially against the flat-topped hat poses. Fixed below every
    // sprite's depth range (100+), same idea as the casting line at 99.
    const shadow = this.add
      .image(state.x, state.y, 'angler-shadow')
      .setDepth(98);

    const sprite = this.add
      .image(state.x, state.y, textureKey, 'walk-down-0')
      // The sheet has headroom above the character and a little room below for
      // a hanging line, so anchor on the feet row rather than the frame edge.
      .setOrigin(0.5, feetY / frameHeight)
      .setDepth(100);

    const isSelf = sessionId === this.net.sessionId;

    const label = this.add
      .text(state.x, this.nameLabelY(state.y), state.name, {
        fontFamily: FONT_FAMILY,
        fontSize: '15px',
        color: isSelf ? PALETTE.gold : PALETTE.panelInk,
        stroke: PALETTE.ink,
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(101);
    this.scaleLabel(label);

    const line = this.add.graphics().setDepth(99);

    const avatar = {
      sessionId,
      textureKey,
      variant,
      shadow,
      sprite,
      label,
      line,
      state,
      facing: state.facing || 'down',
      isSelf,
      casting: false,
      castTarget: null,
      frame: 0,
      frameTimer: 0,
      // Remote avatars are interpolated toward their last synced position.
      targetX: state.x,
      targetY: state.y,
      ripple: null,
    };

    this.avatars.set(sessionId, avatar);

    if (isSelf) {
      this.cameras.main.startFollow(sprite, true, 0.15, 0.15);
      this.self = avatar;
    }
  }

  /** This player's angler sheet: rolled once on first sight, then remembered. */
  anglerVariantFor(sessionId) {
    let variant = this.anglerVariants.get(sessionId);
    if (variant === undefined) {
      variant = randomVariantIndex();
      this.anglerVariants.set(sessionId, variant);
    }
    return variant;
  }

  removeAvatar(sessionId) {
    const avatar = this.avatars.get(sessionId);
    if (!avatar) return;

    avatar.shadow.destroy();
    avatar.sprite.destroy();
    avatar.label.destroy();
    avatar.line.destroy();
    avatar.ripple?.destroy();
    this.avatars.delete(sessionId);

    if (sessionId === this.net.sessionId) this.self = null;
  }

  /* ------------------------------------------------------------- network */

  bindNetwork() {
    this.net.on('playerAdd', ({ player, sessionId }) => this.addAvatar(sessionId, player));
    this.net.on('playerRemove', ({ sessionId }) => this.removeAvatar(sessionId));

    this.net.on('playerChange', ({ player, sessionId }) => {
      const avatar = this.avatars.get(sessionId);
      if (!avatar) return;

      avatar.state = player;
      avatar.label.setText(player.name);
      avatar.sprite.setAlpha(player.online ? 1 : 0.45);
      avatar.shadow.setAlpha(player.online ? 1 : 0.45);

      if (!avatar.isSelf) {
        avatar.targetX = player.x;
        avatar.targetY = player.y;
        avatar.facing = player.facing || 'down';
      }

      this.updateCastVisual(avatar, player.casting);
    });

    this.net.on('castResult', (result) => this.playCastResult(result));
    this.net.on('chestOpened', (result) => this.playChestOpened(result));
    this.net.on('consumableUsed', () => this.playSparkle(this.self, PALETTE.gem));
  }

  /* ---------------------------------------------------------- fishing FX */

  /**
   * The rod tip, in world pixels.
   *
   * Measured off the sprite sheet rather than guessed, so the line starts
   * exactly where the rod was drawn ending -- and measured per sheet, because
   * the anglers hold rods of different lengths.
   */
  rodTipWorld(avatar) {
    const tip = rodTipFor(this.anglerMeta, avatar.facing, avatar.variant);
    return {
      x: avatar.sprite.x + tip.x * avatar.sprite.scaleX,
      y: avatar.sprite.y + tip.y * avatar.sprite.scaleY,
    };
  }

  /**
   * Where the line lands: the nearest open water in front of the angler.
   *
   * The fishing poses hold the rod at about hip height, which in a top-down
   * view puts the sprite's own float on the planks the angler is standing on.
   * The ripple and the catch splash belong in the water, so they go to a real
   * water tile and `drawLines` joins the two -- which is what makes it read as
   * casting rather than as two unrelated effects.
   */
  castTargetFor(avatar) {
    const feet = worldToTile(avatar.sprite.x, avatar.sprite.y + FEET.offsetY);

    // A pool wins over anything geometric: the line has to land in the water
    // the player picked, not in whatever is nearest. Read off the plank rather
    // than from `activeSpot` so a remote angler's line lands in the same pool
    // on every screen without the room having to sync which one they chose --
    // each pool has exactly one plank, so standing on it says which.
    const spot = spotAtStand(feet.tx, feet.ty);
    if (spot) return spotCentre(spot);

    const vector = FACING_VECTORS[avatar.facing] ?? FACING_VECTORS.down;

    for (let step = 1; step <= 4; step += 1) {
      const tx = feet.tx + vector.x * step;
      const ty = feet.ty + vector.y * step;
      if (this.isOpenWater(tx, ty)) return tileToWorld(tx, ty);
    }

    // Facing inland: fall back to any adjacent water so the line still lands
    // somewhere sensible rather than on the planks.
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1]]) {
      if (this.isOpenWater(feet.tx + dx, feet.ty + dy)) {
        return tileToWorld(feet.tx + dx, feet.ty + dy);
      }
    }
    return null;
  }

  isOpenWater(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= WORLD_COLUMNS || ty >= WORLD_ROWS) return false;
    return ty >= BAND.waterTop && this.level.water[ty][tx] === true;
  }

  /** Adds or removes the ripple where a casting angler's line meets the water. */
  updateCastVisual(avatar, casting) {
    if (casting === avatar.casting) return;
    avatar.casting = casting;

    if (!casting) {
      avatar.ripple?.destroy();
      avatar.ripple = null;
      avatar.castTarget = null;
      avatar.line.clear();
      return;
    }

    avatar.castTarget = this.castTargetFor(avatar);
    if (!avatar.castTarget) return;

    avatar.ripple?.destroy();
    avatar.ripple = this.add
      .image(avatar.castTarget.x, avatar.castTarget.y, 'ripple')
      .setDepth(97)
      .setAlpha(0.5)
      .setScale(0.5);

    this.tweens.add({
      targets: avatar.ripple,
      scale: 0.72,
      alpha: 0.25,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  /** Redrawn every frame because the angler can walk while a cast is in flight. */
  drawLines() {
    for (const avatar of this.avatars.values()) {
      avatar.line.clear();
      if (!avatar.casting || !avatar.castTarget) continue;

      const tip = this.rodTipWorld(avatar);
      avatar.line.lineStyle(1, hex(PALETTE.panelInk), 0.7);
      avatar.line.beginPath();
      avatar.line.moveTo(tip.x, tip.y);
      avatar.line.lineTo(avatar.castTarget.x, avatar.castTarget.y);
      avatar.line.strokePath();
    }
  }

  playCastResult(result) {
    const avatar = this.self;
    if (!avatar) return;

    const target = avatar.castTarget ?? this.rodTipWorld(avatar);

    if (result.success) {
      this.splash(target.x, target.y);
      this.hookedFish(target, avatar, result.species);
      const labelY = this.nameLabelY(avatar.sprite.y);
      this.floatingText(
        avatar.sprite.x,
        labelY - 10,
        result.species.name,
        result.species.color,
      );
      this.floatingText(avatar.sprite.x, labelY - 22, `+${result.xp} XP`, '#8fe388', 120);
      this.floatingText(avatar.sprite.x + 18, labelY - 14, `+${result.gold}`, PALETTE.coin, 240);
    } else {
      this.floatingText(avatar.sprite.x, this.nameLabelY(avatar.sprite.y) - 10, 'no bite', PALETTE.panelMuted);
    }

    if (result.levelUp) this.playLevelUp(avatar, result.levelUp);
    if (result.chest) this.playChestDrop(avatar, result.chest);
  }

  /**
   * Flies the caught species out of the water and back to the angler, so a
   * Leviathan is something you *see* rather than a line of text. Falls back to
   * the splash alone when the sheet has no frame for the species.
   */
  hookedFish(target, avatar, species) {
    const frame = frameIndex('fish', species.id);
    if (frame === null) return;

    const fish = this.add
      .sprite(target.x, target.y, 'fish', frame)
      // Was a fixed depth of 97, which sat behind the angler's own y-sorted
      // depth (100 + y/WORLD_HEIGHT, see applyPose) no matter where the catch
      // landed -- the fish always rendered under the sprite as it flew back in.
      // Anchoring to the catching avatar's own depth keeps it above them for
      // the length of this animation (the angler can't move while fishing, so
      // that depth is stable for the ~700ms this sprite is alive).
      .setDepth(avatar.sprite.depth + 1)
      .setScale(0.3)
      .setFlipX(avatar.sprite.x > target.x);

    // Arc up out of the water first, then in toward the angler: two tweens
    // rather than one so the fish hangs at the top of the arc where it reads.
    // Fish frames are 45px wide against the current 96px character frame.
    // Show the catch at native size at the crest: the former 0.62 cap was
    // tuned for the retired 32px angler and made every catch look miniature.
    this.tweens.add({
      targets: fish,
      y: target.y - 26,
      scale: 1,
      duration: 260,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: fish,
          x: avatar.sprite.x,
          y: avatar.sprite.y - 14,
          scale: 0.5,
          alpha: 0,
          duration: 420,
          delay: 220,
          ease: 'Cubic.easeIn',
          onComplete: () => fish.destroy(),
        });
      },
    });
  }

  splash(x, y) {
    for (let i = 0; i < 8; i += 1) {
      const droplet = this.add.image(x, y, 'droplet').setDepth(96);
      this.tweens.add({
        targets: droplet,
        x: x + Phaser.Math.Between(-14, 14),
        y: y - Phaser.Math.Between(6, 18),
        alpha: 0,
        duration: Phaser.Math.Between(280, 480),
        ease: 'Quad.easeOut',
        onComplete: () => droplet.destroy(),
      });
    }
  }

  floatingText(x, y, message, color, delay = 0) {
    const text = this.add
      .text(x, y, message, {
        fontFamily: FONT_FAMILY,
        fontSize: '11px',
        color,
        stroke: PALETTE.ink,
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(950)
      .setAlpha(0);
    this.scaleLabel(text);

    this.tweens.add({
      targets: text,
      alpha: 1,
      y: y - 12,
      duration: 900,
      delay,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: text,
          alpha: 0,
          duration: 260,
          onComplete: () => text.destroy(),
        });
      },
    });
  }

  playLevelUp(avatar, levelUp) {
    for (let i = 0; i < 3; i += 1) {
      const ring = this.add
        .image(avatar.sprite.x, avatar.sprite.y - 10, 'ring')
        .setDepth(940)
        .setScale(0.2)
        .setAlpha(0.9);

      this.tweens.add({
        targets: ring,
        scale: 1.1,
        alpha: 0,
        duration: 900,
        delay: i * 160,
        ease: 'Quad.easeOut',
        onComplete: () => ring.destroy(),
      });
    }

    this.floatingText(
      avatar.sprite.x,
      avatar.sprite.y - 48,
      `ROD LEVEL ${levelUp.toLevel}`,
      PALETTE.gold,
      200,
    );
    this.playSparkle(avatar, PALETTE.gold);
  }

  playSparkle(avatar, color) {
    if (!avatar) return;

    for (let i = 0; i < 12; i += 1) {
      const spark = this.add
        .image(avatar.sprite.x, avatar.sprite.y - 12, 'spark')
        .setDepth(945)
        .setTint(hex(color));

      const angle = (Math.PI * 2 * i) / 12;
      this.tweens.add({
        targets: spark,
        x: avatar.sprite.x + Math.cos(angle) * Phaser.Math.Between(14, 26),
        y: avatar.sprite.y - 12 + Math.sin(angle) * Phaser.Math.Between(14, 26),
        alpha: 0,
        scale: 0.3,
        duration: 620,
        ease: 'Quad.easeOut',
        onComplete: () => spark.destroy(),
      });
    }
  }

  playChestDrop(avatar, chest) {
    const sprite = this.add
      .image(avatar.sprite.x + 16, avatar.sprite.y - 6, this.chestTexture('closed', chest.tier))
      .setDepth(120)
      .setScale(0.4)
      .setAlpha(0);

    this.tweens.add({
      targets: sprite,
      scale: 1,
      alpha: 1,
      y: avatar.sprite.y - 2,
      duration: 320,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: sprite,
          alpha: 0,
          y: sprite.y - 14,
          delay: 700,
          duration: 400,
          onComplete: () => sprite.destroy(),
        });
      },
    });

    this.floatingText(avatar.sprite.x, avatar.sprite.y - 44, chest.name, chest.color, 120);
  }

  /** Falls back to the common chest if the server ever adds a tier we lack art for. */
  chestTexture(state, tier) {
    const key = `chest-${state}-${tier}`;
    return this.textures.exists(key) ? key : `chest-${state}-common`;
  }

  /** Opening happens in the HUD; this is the world-side flourish. */
  playChestOpened(result) {
    const avatar = this.self;
    if (!avatar) return;

    const sprite = this.add
      .image(avatar.sprite.x, avatar.sprite.y - 4, this.chestTexture('open', result.tier))
      .setDepth(120);

    this.playSparkle(avatar, result.color);

    this.tweens.add({
      targets: sprite,
      y: sprite.y - 10,
      alpha: 0,
      delay: 500,
      duration: 500,
      onComplete: () => sprite.destroy(),
    });

    if (result.levelUp) this.playLevelUp(avatar, result.levelUp);
  }

  /* -------------------------------------------------------------- update */

  update(time, delta) {
    const step = delta / 1000;

    this.driftAmbientFish(step);
    this.driftSpotFish(step);
    this.updateSpotHighlight(time, step);
    this.driftClouds(step);
    this.moveSelf(step, time);
    this.interpolateRemotes(step);
    this.drawLines();
  }

  driftAmbientFish(step) {
    for (const fish of this.ambientFish) {
      fish.sprite.x += fish.speed * step;
      if (fish.sprite.x < -20) fish.sprite.x = WORLD_WIDTH + 20;
      if (fish.sprite.x > WORLD_WIDTH + 20) fish.sprite.x = -20;
    }
  }

  /**
   * Walks each cloud sheet along the wind.
   *
   * The position is accumulated as a float and handed to the sprite rounded.
   * Sampling a hard edge at a fractional offset is what makes pixel art crawl:
   * the boundary lands on one side of a texel one frame and the other side the
   * next, and the whole silhouette shimmers. Stepping in whole pixels keeps the
   * edge stable and the motion honest to the art.
   */
  driftClouds(step) {
    if (!this.cloudsDrift) return;

    for (const cloud of this.clouds) {
      cloud.x += cloud.driftX * step;
      cloud.y += cloud.driftY * step;
      cloud.sprite.tilePositionX = Math.round(cloud.x);
      cloud.sprite.tilePositionY = Math.round(cloud.y);
    }
  }

  moveSelf(step, time) {
    const avatar = this.self;
    if (!avatar) return;

    let dx = 0;
    let dy = 0;
    const keys = this.keys;

    if (keys.left.isDown || keys.leftArrow.isDown) dx -= 1;
    if (keys.right.isDown || keys.rightArrow.isDown) dx += 1;
    if (keys.up.isDown || keys.upArrow.isDown) dy -= 1;
    if (keys.down.isDown || keys.downArrow.isDown) dy += 1;

    // Any keyboard input cancels a click-to-move route -- and, since walking
    // off under your own steam is how you leave a pool, the pool with it.
    if (dx !== 0 || dy !== 0) {
      this.path = [];
      this.clearSpot();
    }

    if (dx === 0 && dy === 0 && this.path.length > 0) {
      const next = tileToStand(this.path[0].tx, this.path[0].ty);
      const toX = next.x - avatar.sprite.x;
      const toY = next.y - avatar.sprite.y;

      if (Math.abs(toX) < ARRIVE_EPSILON && Math.abs(toY) < ARRIVE_EPSILON) {
        this.path.shift();
      } else {
        // Step one axis at a time so the walk reads as 4-directional.
        if (Math.abs(toX) > Math.abs(toY)) dx = Math.sign(toX);
        else dy = Math.sign(toY);
      }
    }

    const moving = dx !== 0 || dy !== 0;

    // Whether the angler actually stepped this frame -- distinct from `moving`,
    // which only says a direction key is held. Walking into a wall or the
    // water's edge holds `moving` true with no change in position; animating
    // off that alone plays the full walk cycle in place, like marching against
    // the wall. Remote avatars already dodge this (see interpolateRemotes'
    // distance check) -- this mirrors it for the locally-driven avatar.
    let moved = false;

    if (moving) {
      // Normalise so diagonal keyboard input is not faster than straight.
      const length = Math.hypot(dx, dy) || 1;
      const stepX = (dx / length) * WALK_SPEED * step;
      const stepY = (dy / length) * WALK_SPEED * step;

      if (stepX !== 0 && this.canStand(avatar.sprite.x + stepX, avatar.sprite.y)) {
        avatar.sprite.x += stepX;
        moved = true;
      }
      if (stepY !== 0 && this.canStand(avatar.sprite.x, avatar.sprite.y + stepY)) {
        avatar.sprite.y += stepY;
        moved = true;
      }

      avatar.facing = Math.abs(dx) > Math.abs(dy)
        ? (dx < 0 ? 'left' : 'right')
        : (dy < 0 ? 'up' : 'down');

    }

    // The route to a clicked pool has run out. Either the feet are on its
    // plank -- start fishing it -- or the walk was cut short somewhere else,
    // in which case the trip is simply off.
    if (this.pendingSpot && this.path.length === 0) {
      const feet = worldToTile(avatar.sprite.x, avatar.sprite.y + FEET.offsetY);
      const { stand } = this.pendingSpot;
      if (feet.tx === stand.tx && feet.ty === stand.ty) this.arriveAtSpot(this.pendingSpot, avatar);
      else this.pendingSpot = null;
    }

    this.advanceFrame(avatar, step, moved);
    this.renderAvatar(avatar);

    this.syncFishingState(step, moved);

    if (time - this.lastMoveSentAt >= MOVE_SEND_MS) {
      this.lastMoveSentAt = time;
      this.net.move(
        Math.round(avatar.sprite.x),
        Math.round(avatar.sprite.y),
        avatar.facing,
        moved,
      );
    }
  }

  /**
   * Decides whether the idle loop should be running.
   *
   * Two conditions: the angler has to be at a fishing spot they picked, and has
   * to be standing still. Standing at the water's edge used to be enough on its
   * own, which meant the loop started itself wherever a player happened to
   * stop; fishing is now something you choose by clicking a pool (see
   * selectSpot), and walking away from that pool ends it.
   *
   * You cannot fish while walking -- starting to move aborts the cast in
   * flight (the server refunds it) and stops the loop.
   *
   * Stopping is immediate, but starting again waits out RESUME_FISHING_MS. That
   * delay is not cosmetic: without it, every tap of a movement key would send a
   * pair of set_auto messages, and a player shuffling on the spot would burn
   * through the server's rate limit.
   *
   * The rule is enforced here rather than in the room because position is not
   * authoritative -- see the `move` handler in HarborRoom. Nothing a player
   * gains by walking-and-fishing is worth shipping the collision map to the
   * server to defend.
   */
  syncFishingState(step, moving) {
    const avatar = this.self;
    if (!avatar) return;

    const feet = worldToTile(avatar.sprite.x, avatar.sprite.y + FEET.offsetY);

    // Nudged, pushed or walked off the plank the pool was clicked from: the
    // trip is over. Checked here rather than in moveSelf so it holds however
    // the avatar came to move.
    if (this.activeSpot
      && (feet.tx !== this.activeSpot.stand.tx || feet.ty !== this.activeSpot.stand.ty)) {
      this.activeSpot = null;
    }

    // `fishable` is still consulted, not replaced: every spot's plank is one
    // (the level test asserts it), so this is a belt-and-braces check that the
    // spot table and the collision map have not drifted apart.
    const atSpot = Boolean(this.activeSpot) && Boolean(this.level.fishable[feet.ty]?.[feet.tx]);

    if (moving) {
      this.stillFor = 0;
    } else {
      this.stillFor += step * 1000;
    }
    const settled = this.stillFor >= RESUME_FISHING_MS;

    if (atSpot !== this.wasAtSpot) {
      this.wasAtSpot = atSpot;
      this.hud?.setFishable(atSpot);
    }
    this.hud?.setMoving(moving);

    const shouldFish = atSpot && settled && this.hud?.autoFishingWanted !== false;
    if (shouldFish === this.wasFishing) return;

    this.wasFishing = shouldFish;
    this.net.setAuto(shouldFish);
  }

  /**
   * True when the feet box at (x, y) clears every solid tile and dock rail it
   * overlaps. The test itself lives in level.js, because the level uses the
   * same one to work out which tiles the pathfinder may route through.
   */
  canStand(x, y) {
    return canStandAt(this.level.solid, this.level.dockRails, x, y);
  }

  interpolateRemotes(step) {
    for (const avatar of this.avatars.values()) {
      if (avatar.isSelf) continue;

      // Ease toward the synced position; at 10 updates/sec a hard snap reads
      // as teleporting.
      const smoothing = Math.min(1, step * 12);
      avatar.sprite.x += (avatar.targetX - avatar.sprite.x) * smoothing;
      avatar.sprite.y += (avatar.targetY - avatar.sprite.y) * smoothing;

      const moving = avatar.state.moving
        && Math.hypot(avatar.targetX - avatar.sprite.x, avatar.targetY - avatar.sprite.y) > 0.5;

      this.advanceFrame(avatar, step, moving);
      this.renderAvatar(avatar);
    }
  }

  /**
   * Steps the 4-frame cycle. Casting animates too but at half speed -- the
   * fishing poses are a slow bob rather than a stride, and running them at
   * walking speed made a stationary angler look agitated.
   */
  advanceFrame(avatar, step, moving) {
    const casting = avatar.casting;
    if (!moving && !casting) {
      avatar.frame = 0;
      avatar.frameTimer = 0;
      return;
    }

    const interval = casting ? WALK_FRAME_MS * 2 : WALK_FRAME_MS;
    avatar.frameTimer += step * 1000;
    if (avatar.frameTimer >= interval) {
      avatar.frameTimer = 0;
      avatar.frame = (avatar.frame + 1) % 4;
    }
  }

  /** Applies the current pose, label position and depth for one avatar. */
  renderAvatar(avatar) {
    const kind = avatar.casting ? 'fish' : 'walk';
    avatar.sprite.setFrame(frameName(this.anglerMeta, kind, avatar.facing, avatar.frame));

    avatar.shadow.setPosition(Math.round(avatar.sprite.x), Math.round(avatar.sprite.y));

    avatar.label.setPosition(
      Math.round(avatar.sprite.x),
      Math.round(this.nameLabelY(avatar.sprite.y)),
    );

    // Anglers further down the dock draw in front, so they overlap correctly.
    avatar.sprite.setDepth(100 + avatar.sprite.y / WORLD_HEIGHT);
    avatar.label.setDepth(avatar.sprite.depth + 1);

    // Walking while a cast is in flight drags the line to new water.
    if (avatar.casting && avatar.ripple) {
      const retarget = this.castTargetFor(avatar);
      if (retarget) {
        avatar.castTarget = retarget;
        avatar.ripple.setPosition(retarget.x, retarget.y);
      }
    }
  }
}

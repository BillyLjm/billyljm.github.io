/**
 * Continuous boids playground: agents flock with classic Reynolds rules
 * (separation, alignment, cohesion). Cards are short-range attractors — a
 * strong cohesion pull that falls off to zero outside a tight radius so
 * flocks dive in, overshoot, and peel off rather than stick. update always
 * returns true. Drag cards (continuous path) to move attractors.
 *
 * Boid pose
 * ---------
 *   x, y     position (px)
 *   vx, vy   velocity (px/s)
 *
 * Canvas y grows downward. Heading is atan2(vy, vx); chevrons draw that way.
 *
 * Steering
 * --------
 * Each substep accumulates accelerations from neighbors (within perception /
 * separation radii), soft stage walls, and card wells. Neighbor queries use a
 * uniform spatial grid (cell size = perception) so cost is ~O(n) not O(n²).
 * Local density n/(n+flockScale) fades cohesion and ramps dispersion.
 *
 * Card cohesion is weighted by (1 − d/R)² for d < R (R ≈ 1.55 × card radius)
 * and zero outside. Card contact teleports through the disc along velocity.
 *
 * Perf notes
 * ----------
 *   - spatial grid rebuilt once per substep
 *   - simDt capped; at most 2 substeps per frame
 *   - draw uses a pre-baked angle×color sprite atlas + drawImage (no paths)
 *   - limitVec writes into reused scratch objects (less GC)
 *
 * @typedef {object} Boid
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} colorIndex  row in the sprite atlas (palette entry)
 *
 * @typedef {object} BoidWorld
 * @property {Array<{ id: string, x: number, y: number, radius: number }>} cards
 * @property {number} width   stage width (px)
 * @property {number} height  stage height (px)
 * @property {number} padding
 * @property {number} [cardRadius]
 * @property {string|null} [draggingId]
 * @property {object} [helpers]
 * @property {BoidState} [_boids]  flock + tunables (see start)
 *
 * @typedef {object} BoidState
 * @property {Boid[]} birds
 * @property {number} perception  neighbor radius for alignment + cohesion
 * @property {number} separation  hard avoid radius
 * @property {number} maxSpeed    px/s
 * @property {number} maxForce    max steering accel (px/s² scale)
 * @property {number} wSep        separation weight
 * @property {number} wAli        alignment weight
 * @property {number} wCoh        flock cohesion weight
 * @property {number} wDisp       density dispersion weight (scales with density)
 * @property {number} flockScale  neighbor count at half density (smooth ramp)
 * @property {number} wCard       card-well weight (strong, short-range)
 * @property {number} wWall       soft wall weight
 * @property {number} wallMargin  wall feeler distance (px)
 * @property {number} air         drag base; applied as pow(air, dt*60)
 * @property {number} minSpeedFrac  cruise floor as fraction of maxSpeed
 * @property {number} cardRadiusScale  attract radius = scale × card.radius
 * @property {number} timeScale  multiplies frame dt (sim runs faster than wall clock)
 * @property {Boid[][]} [_grid]  reusable spatial-hash buckets
 * @property {number} [_gridCols]
 * @property {number} [_gridRows]
 * @property {number} [_gridCell]
 */

import { randomRgb, rgba, isDarkTheme } from "./+helpers.js";

/** Reused by limitVecInto — avoid per-call object allocation. */
const _limA = { x: 0, y: 0 };
const _limB = { x: 0, y: 0 };

/** Atlas fill alpha (light); rgba() applies themeAlpha on dark. */
const BOID_ALPHA = 0.55;
/** Number of randomRgb() rows baked into the sprite atlas. */
const BOID_PALETTE_SIZE = 12;

/** Quantized headings in the atlas (10° steps). */
const ATLAS_ANGLES = 36;
/** Logical sprite cell size (px). Baked at 2× for retina sharpness. */
const SPRITE = 28;
const SPRITE_HALF = SPRITE / 2;
const ATLAS_BAKE = 2;

/** @type {HTMLCanvasElement|null} */
let _atlas = null;
/** Theme key the current atlas was baked for. */
let _atlasDark = null;
/** Palette identity the atlas was baked from. */
let _atlasPalette = null;

/**
 * Sprite sheet: columns = heading, rows = palette color.
 * Rebuilds when theme or palette changes so themeAlpha stays correct.
 *
 * @param {{ r: number, g: number, b: number }[]} palette
 * @returns {HTMLCanvasElement}
 */
function getAtlas(palette) {
  const dark = isDarkTheme();
  if (_atlas && _atlasDark === dark && _atlasPalette === palette) return _atlas;

  const cell = SPRITE * ATLAS_BAKE;
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_ANGLES * cell;
  canvas.height = palette.length * cell;
  const g = canvas.getContext("2d");
  if (!g) {
    _atlas = canvas;
    _atlasDark = dark;
    _atlasPalette = palette;
    return canvas;
  }

  const len = 11 * ATLAS_BAKE;
  const half = 7.5 * ATLAS_BAKE;
  const cx0 = cell / 2;
  const cy0 = cell / 2;

  for (let ci = 0; ci < palette.length; ci++) {
    g.fillStyle = rgba(palette[ci], BOID_ALPHA);
    for (let ai = 0; ai < ATLAS_ANGLES; ai++) {
      const ox = ai * cell + cx0;
      const oy = ci * cell + cy0;
      const ang = (ai / ATLAS_ANGLES) * Math.PI * 2;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);

      const x0 = ox + len * cos;
      const y0 = oy + len * sin;
      const x1 = ox + -len * 0.65 * cos - half * sin;
      const y1 = oy + -len * 0.65 * sin + half * cos;
      const x2 = ox + -len * 0.35 * cos;
      const y2 = oy + -len * 0.35 * sin;
      const x3 = ox + -len * 0.65 * cos + half * sin;
      const y3 = oy + -len * 0.65 * sin - half * cos;

      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.lineTo(x2, y2);
      g.lineTo(x3, y3);
      g.closePath();
      g.fill();
    }
  }

  _atlas = canvas;
  _atlasDark = dark;
  _atlasPalette = palette;
  return canvas;
}

/**
 * Clamp a 2D vector to max length; write into `out` and return it.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} max
 * @param {{ x: number, y: number }} out
 * @returns {{ x: number, y: number }}
 */
function limitVecInto(x, y, max, out) {
  const s = Math.hypot(x, y);
  if (s > max && s > 1e-9) {
    const k = max / s;
    out.x = x * k;
    out.y = y * k;
  } else {
    out.x = x;
    out.y = y;
  }
  return out;
}

/**
 * How many boids for this stage (scales with area).
 *
 * @param {BoidWorld} world
 * @returns {number}
 */
function boidCount(world) {
  const area = world.width * world.height;
  return Math.min(140, Math.round(area / 9000));
}

/**
 * Seed agents with random pose + velocity. Uses cfg.maxSpeed for cruise range.
 *
 * @param {BoidWorld} world
 * @param {BoidState} cfg
 * @returns {Boid[]}
 */
function spawnBirds(world, cfg) {
  const h = world.helpers;
  const m = world.padding + 8;
  const n = boidCount(world);
  /** @type {Boid[]} */
  const birds = [];
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = h.random(cfg.maxSpeed * 0.35, cfg.maxSpeed * 0.85);
    birds.push({
      x: h.random(m, Math.max(m, world.width - m)),
      y: h.random(m, Math.max(m, world.height - m)),
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      colorIndex: (Math.random() * BOID_PALETTE_SIZE) | 0,
    });
  }
  return birds;
}

/**
 * Build flock state (tunables + birds) and attach on world._boids.
 *
 * @param {BoidWorld} world
 * @returns {BoidState}
 */
function createState(world) {
  /** @type {BoidState} */
  const cfg = {
    birds: [],
    palette: Array.from({ length: BOID_PALETTE_SIZE }, () => randomRgb()),
    perception: 72, // neighbor radius (alignment + cohesion)
    separation: 22, // hard avoid radius
    maxSpeed: 220, // px/s
    maxForce: 420, // steering cap
    wSep: 1.6, // separation weight
    wAli: 1.0, // alignment weight
    wCoh: 0.9, // flock cohesion weight
    wDisp: 2.0, // density dispersion (push from local COM; scales with density)
    flockScale: 7, // neighbor count at half density (smooth n/(n+scale) ramp)
    wCard: 3.4, // card-well weight (strong while in range)
    wWall: 2.2, // soft wall weight
    wallMargin: 48, // wall feeler (px)
    air: 0.999, // drag base (pow air, dt*60)
    minSpeedFrac: 0.22, // cruise floor / maxSpeed
    cardRadiusScale: 1.55, // attract R = scale × card.radius
    timeScale: 2.2, // sim dt multiplier (faster than wall clock)
    _grid: [],
    _gridCols: 0,
    _gridRows: 0,
    _gridCell: 0,
  };
  cfg.birds = spawnBirds(world, cfg);
  world._boids = cfg;
  return cfg;
}

/**
 * Rebuild uniform spatial hash. Cell size = perception so a query of the
 * home cell + 8 neighbors covers the full perception radius.
 *
 * @param {BoidState} cfg
 * @param {BoidWorld} world
 */
function rebuildGrid(cfg, world) {
  const cell = Math.max(8, cfg.perception);
  const cols = Math.max(1, Math.ceil(world.width / cell));
  const rows = Math.max(1, Math.ceil(world.height / cell));
  const nCells = cols * rows;

  let grid = cfg._grid;
  if (!grid || grid.length < nCells) {
    grid = new Array(nCells);
    for (let i = 0; i < nCells; i++) grid[i] = [];
    cfg._grid = grid;
  } else {
    for (let i = 0; i < nCells; i++) {
      if (grid[i]) grid[i].length = 0;
      else grid[i] = [];
    }
    // drop stale extra buckets if stage shrank
    if (grid.length > nCells) grid.length = nCells;
  }

  cfg._gridCols = cols;
  cfg._gridRows = rows;
  cfg._gridCell = cell;

  const birds = cfg.birds;
  for (let i = 0; i < birds.length; i++) {
    const b = birds[i];
    let cx = (b.x / cell) | 0;
    let cy = (b.y / cell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= rows) cy = rows - 1;
    grid[cy * cols + cx].push(b);
  }
}

/**
 * Reynolds forces + short-range card cohesion + soft walls for one agent.
 * Neighbors come from the spatial grid on cfg (3×3 cell neighborhood).
 * Mutates b in place (velocity then position).
 *
 * @param {Boid} b  agent to integrate
 * @param {BoidWorld} world  cards + stage size
 * @param {BoidState} cfg  tunables + grid
 * @param {number} dt  substep duration in seconds
 */
function integrateBoid(b, world, cfg, dt) {
  let sepX = 0;
  let sepY = 0;
  let sepN = 0;
  let aliX = 0;
  let aliY = 0;
  let aliN = 0;
  let cohX = 0;
  let cohY = 0;
  let cohN = 0;

  const perc2 = cfg.perception * cfg.perception;
  const sep2 = cfg.separation * cfg.separation;
  const cell = cfg._gridCell;
  const cols = cfg._gridCols;
  const rows = cfg._gridRows;
  const grid = cfg._grid;

  let cx = (b.x / cell) | 0;
  let cy = (b.y / cell) | 0;
  if (cx < 0) cx = 0;
  else if (cx >= cols) cx = cols - 1;
  if (cy < 0) cy = 0;
  else if (cy >= rows) cy = rows - 1;

  const x0 = cx > 0 ? cx - 1 : 0;
  const x1 = cx < cols - 1 ? cx + 1 : cols - 1;
  const y0 = cy > 0 ? cy - 1 : 0;
  const y1 = cy < rows - 1 ? cy + 1 : rows - 1;

  for (let gy = y0; gy <= y1; gy++) {
    const rowBase = gy * cols;
    for (let gx = x0; gx <= x1; gx++) {
      const bucket = grid[rowBase + gx];
      for (let i = 0; i < bucket.length; i++) {
        const o = bucket[i];
        if (o === b) continue;
        const dx = b.x - o.x;
        const dy = b.y - o.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > perc2 || d2 < 1e-8) continue;

        // alignment + cohesion in perception radius
        aliX += o.vx;
        aliY += o.vy;
        aliN++;
        cohX += o.x;
        cohY += o.y;
        cohN++;

        // separation: unit push away, only inside separation radius
        if (d2 < sep2) {
          const d = Math.sqrt(d2);
          sepX += dx / d;
          sepY += dy / d;
          sepN++;
        }
      }
    }
  }

  let ax = 0;
  let ay = 0;

  // steer = (desired − velocity) × weight  (desired capped at maxSpeed)
  if (sepN > 0) {
    sepX /= sepN;
    sepY /= sepN;
    const desired = limitVecInto(sepX, sepY, cfg.maxSpeed, _limA);
    ax += (desired.x - b.vx) * cfg.wSep;
    ay += (desired.y - b.vy) * cfg.wSep;
  }

  if (aliN > 0) {
    aliX /= aliN;
    aliY /= aliN;
    const desired = limitVecInto(aliX, aliY, cfg.maxSpeed, _limA);
    ax += (desired.x - b.vx) * cfg.wAli;
    ay += (desired.y - b.vy) * cfg.wAli;
  }

  if (cohN > 0) {
    const meanX = cohX / cohN;
    const meanY = cohY / cohN;
    // Smooth density ∈ (0, 1): ~0 with 1 neighbor, 0.5 at flockScale, →1 as n→∞.
    const scale = Math.max(1, cfg.flockScale);
    const density = cohN / (cohN + scale);

    // cohesion softens as the local flock densifies
    const toCom = limitVecInto(meanX - b.x, meanY - b.y, cfg.maxSpeed, _limA);
    const cohW = cfg.wCoh * (1 - density);
    ax += (toCom.x - b.vx) * cohW;
    ay += (toCom.y - b.vy) * cohW;

    // density dispersion: always on when neighbors exist; strength ∝ density
    let awayX = b.x - meanX;
    let awayY = b.y - meanY;
    if (awayX * awayX + awayY * awayY < 1e-6) {
      // at the COM: peel off perpendicular to current heading
      awayX = -b.vy;
      awayY = b.vx;
    }
    const away = limitVecInto(awayX, awayY, cfg.maxSpeed, _limB);
    ax += (away.x - b.vx) * cfg.wDisp * density;
    ay += (away.y - b.vy) * cfg.wDisp * density;
  }

  // card wells: strong short-range cohesion, (1 − d/R)² falloff
  for (const card of world.cards) {
    const dx = card.x - b.x;
    const dy = card.y - b.y;
    const d2 = dx * dx + dy * dy;
    const R = card.radius * cfg.cardRadiusScale;
    if (d2 >= R * R || d2 < 1e-8) continue;
    const d = Math.sqrt(d2);
    const falloff = 1 - d / R;
    const w = falloff * falloff;
    const desired = limitVecInto(dx, dy, cfg.maxSpeed, _limA);
    ax += (desired.x - b.vx) * cfg.wCard * w;
    ay += (desired.y - b.vy) * cfg.wCard * w;
  }

  // soft walls: push back near edges
  const m = cfg.wallMargin;
  if (b.x < m) ax += ((m - b.x) / m) * cfg.maxSpeed * cfg.wWall;
  else if (b.x > world.width - m) ax -= ((b.x - (world.width - m)) / m) * cfg.maxSpeed * cfg.wWall;
  if (b.y < m) ay += ((m - b.y) / m) * cfg.maxSpeed * cfg.wWall;
  else if (b.y > world.height - m) ay -= ((b.y - (world.height - m)) / m) * cfg.maxSpeed * cfg.wWall;

  const steer = limitVecInto(ax, ay, cfg.maxForce, _limA);
  b.vx += steer.x * dt;
  b.vy += steer.y * dt;

  const drag = Math.pow(cfg.air, dt * 60);
  b.vx *= drag;
  b.vy *= drag;

  const v = limitVecInto(b.vx, b.vy, cfg.maxSpeed, _limA);
  // cruise floor so flocks do not stall in card wells
  const spd = Math.hypot(v.x, v.y);
  const minSpd = cfg.maxSpeed * cfg.minSpeedFrac;
  if (spd < minSpd && spd > 1e-6) {
    const k = minSpd / spd;
    b.vx = v.x * k;
    b.vy = v.y * k;
  } else {
    b.vx = v.x;
    b.vy = v.y;
  }

  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // warp through any card the agent has entered
  resolveCardTeleport(b, world);

  // hard bounce as a last resort (walls usually handle it)
  const pad = 4;
  if (b.x < pad) {
    b.x = pad;
    b.vx = Math.abs(b.vx);
  } else if (b.x > world.width - pad) {
    b.x = world.width - pad;
    b.vx = -Math.abs(b.vx);
  }
  if (b.y < pad) {
    b.y = pad;
    b.vy = Math.abs(b.vy);
  } else if (b.y > world.height - pad) {
    b.y = world.height - pad;
    b.vy = -Math.abs(b.vy);
  }
}

/**
 * If the agent is inside a card disc, teleport it to the opposite side of
 * that card along its flight direction (velocity), just outside the rim.
 * Keeps vx/vy so the flock continues through rather than bouncing.
 *
 * @param {Boid} b
 * @param {BoidWorld} world
 */
function resolveCardTeleport(b, world) {
  // small pad past the rim so the next substep does not re-trigger immediately
  const exitPad = 4;

  for (const card of world.cards) {
    const dx = b.x - card.x;
    const dy = b.y - card.y;
    const r = card.radius;
    if (dx * dx + dy * dy >= r * r) continue;

    // prefer flight direction; fall back to radial from center if nearly still
    let nx = b.vx;
    let ny = b.vy;
    let spd = Math.hypot(nx, ny);
    if (spd < 1e-6) {
      nx = dx;
      ny = dy;
      spd = Math.hypot(nx, ny);
      if (spd < 1e-6) {
        // dead center + no velocity: pick a stable arbitrary exit
        nx = 1;
        ny = 0;
        spd = 1;
      }
    }
    nx /= spd;
    ny /= spd;

    // exit on the far side in the direction of travel
    const exitR = r + exitPad;
    b.x = card.x + nx * exitR;
    b.y = card.y + ny * exitR;
    // only one card per substep (cards rarely overlap)
    break;
  }
}

/**
 * Place card attractors non-overlapping in the bottom half (user can drag afterward).
 *
 * @param {BoidWorld} world
 */
function placeCards(world) {
  const targets = world.helpers.bottomHalfPositions();
  world.cards.forEach((card, i) => {
    card.x = targets[i].x;
    card.y = targets[i].y;
    card.vx = 0;
    card.vy = 0;
    card.omega = 0;
    card.angle = 0;
    card.held = false;
  });
}

export default {
  id: "boids",
  label: "Boids",
  weight: 1.1,
  interactive: false,
  continuous: true,

  /**
   * Scatter cards and spawn flock + tunables on world._boids.
   *
   * @param {BoidWorld} world  canvas world (cards, size, helpers)
   */
  start(world) {
    placeCards(world);
    createState(world);
  },

  /**
   * Advance the flock. Always returns true (continuous effect).
   *
   * @param {BoidWorld} world  canvas world; uses cards, size, _boids
   * @param {number} dt  frame delta in seconds (capped/substepped internally)
   * @returns {true}
   */
  update(world, dt) {
    let cfg = world._boids;
    if (!cfg) cfg = createState(world);

    // Scale wall-clock dt, but hard-cap so a hitch cannot explode work.
    const simDt = Math.min(0.04, dt * (cfg.timeScale || 1));
    // At most 2 substeps (was up to 4) — keeps O(n) grid rebuilds bounded.
    const steps = Math.max(1, Math.min(2, Math.ceil(simDt / 0.02)));
    const sub = simDt / steps;
    const birds = cfg.birds;

    for (let step = 0; step < steps; step++) {
      rebuildGrid(cfg, world);
      for (let i = 0; i < birds.length; i++) {
        integrateBoid(birds[i], world, cfg, sub);
      }
    }

    return true;
  },

  /**
   * Paint agents under the cards via pre-baked sprite atlas (drawImage only).
   *
   * @param {BoidWorld} world
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(world, ctx) {
    const cfg = world._boids || createState(world);
    const birds = cfg.birds;
    const palette =
      cfg.palette || Array.from({ length: BOID_PALETTE_SIZE }, () => randomRgb());
    if (!cfg.palette) cfg.palette = palette;
    const atlas = getAtlas(palette);
    const cell = SPRITE * ATLAS_BAKE;
    const invTwoPi = ATLAS_ANGLES / (Math.PI * 2);
    const nAngles = ATLAS_ANGLES;
    const nColors = palette.length;
    const half = SPRITE_HALF;

    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      // Map heading → column; atan2 range (-π, π] → [0, nAngles)
      let ai = (Math.atan2(b.vy, b.vx) * invTwoPi) | 0;
      if (ai < 0) ai += nAngles;
      else if (ai >= nAngles) ai = 0; // π maps to nAngles exactly
      let ci = b.colorIndex | 0;
      if (ci < 0 || ci >= nColors) ci = 0;
      ctx.drawImage(
        atlas,
        ai * cell,
        ci * cell,
        cell,
        cell,
        b.x - half,
        b.y - half,
        SPRITE,
        SPRITE
      );
    }
  },

  /**
   * Instant layout (reduced-motion / skip path): re-place cards and flock.
   *
   * @param {BoidWorld} world  canvas world
   */
  skip(world) {
    placeCards(world);
    createState(world);
  },

  /**
   * Stage size changed: clamp cards, reseed flock for new density.
   *
   * @param {BoidWorld} world
   */
  resize(world) {
    for (const card of world.cards) world.helpers.clamp(card);
    createState(world);
  },
};

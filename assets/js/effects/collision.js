/**
 * Continuous gravity playground: discs fall, collide, roll, and can be thrown.
 * Canvas sets world.draggingId while a card is held; held cards skip integrate
 * and act as immovable (infinite mass) in contacts. update always returns true.
 *
 * Card pose
 * ---------
 *   x, y     center of the disc (not top-left)
 *   radius   disc radius in px
 *   vx, vy   linear velocity
 *   angle    visual orientation (radians)
 *   omega    angular velocity (rad/s)
 *   mass     used for impulses (default 1)
 *   held     true while the user is dragging this card
 *
 * Debris (world._phys.debris)
 * --------------------------
 * Smaller non-interactive discs that share the same solver. Drawn under cards
 * via draw(). mass scales with area so cards can bat them around.
 *
 * Canvas y grows downward. Positive omega is from +x toward +y (looks clockwise
 * on screen). Pure roll on the floor: omega = vx / radius.
 *
 * Contacts
 * --------
 * All collisions go through resolveCardCollision (disc–disc). Stage walls are
 * modelled as huge held discs just outside each edge, so the contact arc is
 * effectively flat ("infinite radius" plane).
 *
 * Normal impulse is linear (r ∥ n). Friction uses rim slip + torque.
 * Solid disc I = ½ m R² ⇒ tangential invMass = 3/m per free body.
 */

import { randomRgb, rgba } from "./+helpers.js";

/**
 * @typedef {object} PhysCard
 * @property {string} id
 * @property {number} x  center
 * @property {number} y  center
 * @property {number} radius
 * @property {number} vx
 * @property {number} vy
 * @property {number} angle  orientation (rad)
 * @property {number} omega  spin (rad/s)
 * @property {number} mass
 * @property {boolean} [held]  true while the user is dragging this card
 * @property {{ r: number, g: number, b: number }} [color]  debris rgb (randomRgb)
 *
 * @typedef {object} PhysWorld
 * @property {PhysCard[]} cards
 * @property {number} width   stage width (px)
 * @property {number} height  stage height (px)
 * @property {number} padding
 * @property {number} [cardRadius]  default disc radius (layout helpers)
 * @property {string|null} [draggingId]  id of the card currently held, if any
 * @property {object} [helpers]
 * @property {PhysConfig} [_phys]  physics tunables + debris (see start)
 *
 * @typedef {object} PhysConfig
 * @property {number} gravity  px/s² downward
 * @property {number} restitution  bounce (0–1), walls and cards
 * @property {number} friction  Coulomb μ (slide ↔ spin coupling)
 * @property {number} air  drag base; applied as pow(air, dt*60)
 * @property {number} sleepEps  |v| / |ωR| below this on floor is zeroed
 * @property {number} posCorr  fraction of penetration fixed per contact pass
 * @property {PhysCard[]} debris  smaller free discs (not site cards)
 */

/** Huge radius so a held "wall disc" presents a nearly flat contact face. */
const WALL_RADIUS = 1e6;

/**
 * Immovable disc used to represent a stage edge.
 * Center is placed so the surface passes through the wall line; the free disc
 * collides with it exactly like any other held body.
 *
 * @param {number} x  center x
 * @param {number} y  center y
 * @returns {PhysCard}
 */
function wallDisc(x, y) {
  return {
    id: "wall",
    x,
    y,
    radius: WALL_RADIUS,
    vx: 0,
    vy: 0,
    omega: 0,
    angle: 0,
    mass: 1, // ignored while held
    held: true,
  };
}

/**
 * Spawn smaller free discs scattered in the upper half of the stage.
 * Mass ∝ area relative to a site card so cards dominate collisions.
 *
 * @param {PhysWorld} world
 * @returns {PhysCard[]}
 */
function createDebris(world) {
  const h = world.helpers;
  const n = 20;
  const refR = world.cardRadius || 100;
  /** @type {PhysCard[]} */
  const debris = [];

  for (let i = 0; i < n; i++) {
    const radius = h.random(14, 32);
    const mass = Math.max(0.08, (radius / refR) * (radius / refR));
    debris.push({
      id: `debris-${i}`,
      x: h.random(world.padding + radius, Math.max(world.padding + radius, world.width - world.padding - radius)),
      y: h.random(world.padding + radius, Math.max(world.padding + radius, world.height * 0.45)),
      radius: h.random(30, 100),
      vx: h.random(-220, 220),
      vy: h.random(-60, 100),
      angle: h.random(0, Math.PI * 2),
      omega: h.random(-4, 4),
      mass,
      held: false,
      color: randomRgb(),
    });
  }
  return debris;
}

/**
 * Gravity, air drag, and free motion for one card.
 * Orientation advances from omega only; contacts set omega via friction.
 * Held cards are skipped (canvas owns their position while dragging).
 *
 * @param {PhysCard} card  card to integrate
 * @param {number} dt  substep duration in seconds
 * @param {PhysConfig} cfg  physics tunables (uses gravity, air)
 */
function integrateCard(card, dt, cfg) {
  if (card.held) return;
  card.vy += cfg.gravity * dt;
  const drag = Math.pow(cfg.air, dt * 60);
  card.vx *= drag;
  card.vy *= drag;
  card.omega *= drag;
  card.x += card.vx * dt;
  card.y += card.vy * dt;
  card.angle += card.omega * dt;
}

/**
 * Resolve one disc–disc contact: separate, bounce, friction with spin.
 * Normal impulse is linear (r ∥ n). Friction uses rim slip and applies torque.
 * Held cards are immovable (checked via held) — walls are held discs.
 *
 * @param {PhysCard} a  first card
 * @param {PhysCard} b  second card
 * @param {PhysConfig} cfg  physics tunables (restitution, friction, posCorr)
 */
function resolveCardCollision(a, b, cfg) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= a.radius + b.radius) return;
  // Degenerate overlap (centers coincide) — skip rather than divide by zero.
  if (dist < 1e-8) return;

  // positional correction (limits large overlaps)
  const nx = dx / dist;
  const ny = dy / dist;
  const corr = cfg.posCorr * (a.radius + b.radius - dist);
  if (!a.held) {
    a.x -= nx * corr;
    a.y -= ny * corr;
  }
  if (!b.held) {
    b.x += nx * corr;
    b.y += ny * corr;
  }

  // normal impulse (bounce)
  const invA = a.held ? 0 : 1 / a.mass;
  const invB = b.held ? 0 : 1 / b.mass;
  const invSum = invA + invB;
  if (invSum <= 0) return;
  const nmu = 1 / invSum;
  const nv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  const nj = (1 + cfg.restitution) * nmu * nv;
  if (nv < 0) {
    if (!a.held) {
      a.vx += nj * invA * nx;
      a.vy += nj * invA * ny;
    }
    if (!b.held) {
      b.vx -= nj * invB * nx;
      b.vy -= nj * invB * ny;
    }
  }

  // tangential impulse (roll)
  const tx = -ny;
  const ty = nx;
  const tmu = nmu / 3;
  const tv =
    (b.vx - a.vx) * tx +
    (b.vy - a.vy) * ty -
    a.omega * a.radius -
    b.omega * b.radius;
  const tjmax = cfg.friction * Math.abs(nj);
  const tj = Math.max(-tjmax, Math.min(tjmax, tmu * tv));
  if (!a.held) {
    a.vx += tj * invA * tx;
    a.vy += tj * invA * ty;
    a.omega += (2 * tj) / (a.mass * a.radius);
  }
  if (!b.held) {
    b.vx -= tj * invB * tx;
    b.vy -= tj * invB * ty;
    b.omega += (2 * tj) / (b.mass * b.radius);
  }
}

/**
 * Stage edges as huge held discs; each contact reuses resolveCardCollision.
 * Floor sleep zeros settled discs.
 *
 * @param {PhysCard} card
 * @param {PhysWorld} world
 * @param {PhysConfig} cfg
 * @param {number} margin  inset of the solid walls from the stage border
 */
function resolveWallCollision(card, world, cfg, margin) {
  if (card.held) return;

  const r = card.radius;
  const left = margin;
  const right = world.width - margin;
  const top = margin;
  const bottom = world.height - margin;

  // Place wall-disc centers so the rim lies on the stage edge.
  // Free disc vs held wall disc → same solver as disc–disc.
  if (card.x - r < left) {
    resolveCardCollision(card, wallDisc(left - WALL_RADIUS, card.y), cfg);
  }
  if (card.x + r > right) {
    resolveCardCollision(card, wallDisc(right + WALL_RADIUS, card.y), cfg);
  }
  if (card.y - r < top) {
    resolveCardCollision(card, wallDisc(card.x, top - WALL_RADIUS), cfg);
  }
  if (card.y + r > bottom) {
    resolveCardCollision(card, wallDisc(card.x, bottom + WALL_RADIUS), cfg);

    // sleep when settled on the floor
    if (
      Math.abs(card.vx) < cfg.sleepEps &&
      Math.abs(card.vy) < cfg.sleepEps &&
      Math.abs(card.omega * r) < cfg.sleepEps
    ) {
      card.vx = 0;
      card.vy = 0;
      card.omega = 0;
    }
  }
}

/**
 * All free bodies this frame: site cards + debris.
 * @param {PhysWorld} world
 * @returns {PhysCard[]}
 */
function allBodies(world) {
  const debris = world._phys?.debris;
  if (!debris?.length) return world.cards;
  return world.cards.concat(debris);
}

/**
 * Default physics config + a fresh debris field.
 * @param {PhysWorld} world
 * @returns {PhysConfig}
 */
function createPhys(world) {
  return {
    gravity: 1800,
    restitution: 0.42,
    friction: 0.55,
    air: 0.995,
    sleepEps: 12,
    posCorr: 0.85,
    debris: createDebris(world),
  };
}

export default {
  id: "collision",
  label: "Collision physics",
  weight: 1.25,
  interactive: true,
  continuous: true,

  /**
   * Spawn discs / debris and attach physics tunables on world._phys.
   *
   * @param {PhysWorld} world  canvas world (cards, size, helpers)
   */
  start(world) {
    const h = world.helpers;
    world.cards.forEach((card) => {
      const r = card.radius;
      card.x = h.random(world.padding + r, Math.max(world.padding + r, world.width - world.padding - r));
      card.y = h.random(world.padding + r, Math.max(world.padding + r, world.height * 0.35));
      card.vx = h.random(-180, 180);
      card.vy = h.random(-40, 80);
      card.held = false;
      card.mass = 1;
      card.angle = h.random(0, Math.PI * 2);
      // slight spin mismatch so friction is visible as pure roll settles in
      card.omega = card.vx / r + h.random(-1.5, 1.5);
    });

    world._phys = createPhys(world);
  },

  /**
   * Advance the simulation. Always returns true (continuous effect).
   *
   * @param {PhysWorld} world  canvas world; uses cards, size, draggingId, _phys
   * @param {number} dt  frame delta in seconds (capped/substepped internally)
   * @returns {true}
   */
  update(world, dt) {
    if (!world._phys) world._phys = createPhys(world);
    const cfg = world._phys;
    if (!cfg.debris) cfg.debris = createDebris(world);

    const steps = Math.max(1, Math.min(4, Math.ceil(dt / 0.008)));
    const sub = dt / steps;
    const margin = Math.max(4, world.padding * 0.25);
    const dragId = world.draggingId || null;
    const bodies = allBodies(world);

    for (let step = 0; step < steps; step++) {
      for (const card of world.cards) {
        card.held = dragId != null && card.id === dragId;
      }
      // Debris are never held by the pointer.
      for (const d of cfg.debris) d.held = false;

      for (const body of bodies) {
        integrateCard(body, sub, cfg);
      }

      for (const body of bodies) {
        resolveWallCollision(body, world, cfg, margin);
      }

      // disc–disc among cards + debris (a few iterations for multi-body piles)
      for (let iter = 0; iter < 4; iter++) {
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            resolveCardCollision(bodies[i], bodies[j], cfg);
          }
        }
      }
    }

    return true;
  },

  /**
   * Paint debris under the site cards (canvas draws cards after this).
   *
   * @param {PhysWorld} world
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(world, ctx) {
    const debris = world._phys?.debris;
    if (!debris?.length) return;

    ctx.save();
    for (const d of debris) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      ctx.fillStyle = rgba(d.color, 0.2);
      ctx.fill();
    }
    ctx.restore();
  },

  /**
   * Instant settle layout (reduced-motion / skip path).
   *
   * @param {PhysWorld} world  canvas world
   */
  skip(world) {
    const targets = world.helpers.rowPositions("bottom");
    world.cards.forEach((card, i) => {
      card.x = targets[i].x;
      card.y = targets[i].y;
      card.vx = 0;
      card.vy = 0;
      card.omega = 0;
      card.held = false;
      card.angle = 0;
    });

    // Park debris asleep along the floor so reduced-motion still shows them.
    if (!world._phys) world._phys = createPhys(world);
    const debris = world._phys.debris || (world._phys.debris = createDebris(world));
    const margin = Math.max(4, world.padding * 0.25);
    const floorY = world.height - margin;
    debris.forEach((d, i) => {
      const t = debris.length <= 1 ? 0.5 : i / (debris.length - 1);
      d.x = world.padding + d.radius + t * Math.max(0, world.width - 2 * (world.padding + d.radius));
      d.y = floorY - d.radius;
      d.vx = 0;
      d.vy = 0;
      d.omega = 0;
      d.angle = 0;
      d.held = false;
    });
  },

  /**
   * Stage size changed: clamp bodies, reseed debris density for the new area.
   *
   * @param {PhysWorld} world
   */
  resize(world) {
    if (!world._phys) world._phys = createPhys(world);
    // Fresh field so count tracks stage area (same idea as voronoi ghosts).
    world._phys.debris = createDebris(world);
    for (const card of world.cards) {
      world.helpers.clamp(card);
    }
  },
};

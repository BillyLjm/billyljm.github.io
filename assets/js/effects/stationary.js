/**
 * Static layout: cards in rows along the bottom edge.
 * Overflow wraps upward into additional rows. No entrance animation.
 *
 * Continuous: every frame, discs that overlap are pushed apart. The held card
 * is position-pinned to wherever the canvas put it (cursor) so separation
 * never shoves it off the pointer — free cards yield softly instead, which
 * avoids the "blocked then teleport to cursor" snap. Cards touching the held
 * card pick up opposite spin from its angle change.
 */

/** @type {string|null} */
let lastHeldId = null;
/** @type {number} */
let lastHeldAngle = 0;

/** Fraction of penetration resolved per contact (soft; < 1 avoids explosions). */
const POS_CORR = 0.4;
/** Cap free-card push per contact per iteration (px). */
const MAX_PUSH = 16;

/**
 * Bottom-aligned wrapping grid of disc centers.
 * First cards fill the bottom row left→right; further cards stack above.
 *
 * @param {{ cards: unknown[], width: number, height: number, padding: number, cardRadius: number }} world
 * @returns {{ x: number, y: number }[]}
 */
function bottomGridPositions(world) {
  const n = world.cards.length;
  const gap = world.padding;
  const r = world.cardRadius;
  const d = 2 * r;
  const stride = d + gap;

  // How many full discs + gaps fit across the stage.
  const cols = Math.max(1, Math.floor((world.width - world.padding) / stride));
  const bottomY = world.height - world.padding - r;

  return world.cards.map((_, i) => {
    const col = i % cols;
    const rowFromBottom = Math.floor(i / cols);
    const nInRow = Math.min(n - rowFromBottom * cols, cols);
    const totalRowWidth = nInRow * d + Math.max(0, nInRow - 1) * gap;
    const startX = Math.max(
      world.padding + r,
      (world.width - totalRowWidth) / 2 + r
    );

    return {
      x: startX + col * stride,
      y: bottomY - rowFromBottom * stride,
    };
  });
}

function placeBottom(world) {
  const targets = bottomGridPositions(world);
  world.cards.forEach((card, i) => {
    card.x = targets[i].x;
    card.y = targets[i].y;
    card.vx = 0;
    card.vy = 0;
    card.omega = 0;
    card.held = false;
    card.angle = 0;
    world.helpers.clamp(card);
  });
  lastHeldId = null;
  lastHeldAngle = 0;
}

/**
 * @param {object} world
 * @returns {{ held: object|null, heldId: string|null }}
 */
function findHeld(world) {
  const dragId = world.draggingId || null;
  const held =
    world.cards.find((c) => (dragId != null && c.id === dragId) || c.held) || null;
  return { held, heldId: held ? held.id : null };
}

/**
 * Softly push overlapping free discs apart. Held card is pinned to its
 * pre-separation pose (cursor) for the whole solve so it never drifts off
 * the pointer between mousemove events.
 *
 * @param {object} world
 */
function separateOverlaps(world) {
  const cards = world.cards;
  const h = world.helpers;
  const { held, heldId } = findHeld(world);

  // Pin: canvas owns held pose; we only move free cards.
  const pinX = held ? held.x : 0;
  const pinY = held ? held.y : 0;

  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < cards.length; i++) {
      const a = cards[i];
      const aHeld = heldId != null && a.id === heldId;
      for (let j = i + 1; j < cards.length; j++) {
        const b = cards[j];
        const bHeld = heldId != null && b.id === heldId;
        if (aHeld && bHeld) continue;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        const minDist = a.radius + b.radius;

        if (dist < 1e-6) {
          const angle = (i * 12.9898 + j * 78.233) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }

        if (dist >= minDist) continue;

        const nx = dx / dist;
        const ny = dy / dist;
        let push = (minDist - dist) * POS_CORR;
        if (push > MAX_PUSH) push = MAX_PUSH;

        if (aHeld) {
          // Held is kinematic — only free card yields.
          b.x += nx * push;
          b.y += ny * push;
        } else if (bHeld) {
          a.x -= nx * push;
          a.y -= ny * push;
        } else {
          const half = push / 2;
          a.x -= nx * half;
          a.y -= ny * half;
          b.x += nx * half;
          b.y += ny * half;
        }
      }
    }

    for (const card of cards) {
      if (heldId != null && card.id === heldId) continue;
      h.clamp(card);
    }

    // Re-assert pin after free-free solves / clamps (paranoia).
    if (held) {
      held.x = pinX;
      held.y = pinY;
    }
  }
}

/** How far past exact touch still counts as "in contact" (px). */
const CONTACT_EPS = 2;

/**
 * Cards touching the held disc spin opposite to the held card's angle delta
 * this frame (external contact / gear mesh). Radius ratio keeps rim arc match.
 *
 * @param {object} world
 */
function rollContactsOppositeHeld(world) {
  const { held, heldId } = findHeld(world);
  if (!held || !heldId) {
    lastHeldId = null;
    return;
  }

  if (lastHeldId !== heldId) {
    lastHeldId = heldId;
    lastHeldAngle = held.angle;
    return;
  }

  const dAngle = held.angle - lastHeldAngle;
  lastHeldAngle = held.angle;
  if (Math.abs(dAngle) < 1e-12) return;

  for (const card of world.cards) {
    if (card.id === heldId) continue;
    const dist = Math.hypot(card.x - held.x, card.y - held.y);
    if (dist <= card.radius + held.radius + CONTACT_EPS) {
      card.angle -= dAngle * (held.radius / card.radius);
    }
  }
}

export default {
  id: "stationary",
  label: "Stationary",
  weight: 1,
  interactive: false,
  continuous: true,

  start(world) {
    placeBottom(world);
  },

  /**
   * Keep separating overlaps every frame (including while the user drags).
   * @returns {true}
   */
  update(world) {
    separateOverlaps(world);
    rollContactsOppositeHeld(world);
    return true;
  },

  skip(world) {
    placeBottom(world);
  },

  /**
   * Stage size changed: run a few extra separation passes immediately.
   */
  resize(world) {
    separateOverlaps(world);
  },
};

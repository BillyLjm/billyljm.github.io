/**
 * Shared effect helpers (two groups in one module):
 *
 * 1) Standalone exports (theme / color) — global, no `world`. Effects import
 *    them directly: `import { rgba, randomRgb } from "./+helpers.js"`.
 *
 * 2) createHelpers(world) → world.helpers — layout tools that close over the
 *    current stage (size, padding, cards). Canvas attaches them when starting
 *    an effect so code can call world.helpers.clamp(card) without re-passing
 *    dimensions.
 *
 * Cards are discs: center (x, y) + radius. Layout helpers return centers.
 */

// —— Theme / color (standalone; not world-bound) ————————————————

/** Page is dark when html[data-theme="dark"] (see theme.js / theme-boot). */
export function isDarkTheme() {
  try {
    return document.documentElement.getAttribute("data-theme") === "dark";
  } catch (_) {
    return false;
  }
}

/**
 * Adjust paint alpha for the current theme. Values are authored for light;
 * dark gets a small boost so translucent fills still read.
 * @param {number} lightAlpha
 */
export function themeAlpha(lightAlpha) {
  if (!isDarkTheme()) return lightAlpha;
  return lightAlpha + 0.1;
}

/** Uniform random sRGB triple 0–255 for effect paints. */
export function randomRgb() {
  return {
    r: (Math.random() * 256) | 0,
    g: (Math.random() * 256) | 0,
    b: (Math.random() * 256) | 0,
  };
}

/**
 * Canvas `rgba(...)` fill/stroke string.
 * Accepts `{ r, g, b }` or hex (`#rgb` / `#rrggbb` / `#rrggbbaa`).
 * Runs themeAlpha on lightAlpha. Falls back to accent blue if invalid.
 *
 * @param {{ r: number, g: number, b: number }|string|null|undefined} color
 * @param {number} lightAlpha
 */
export function rgba(color, lightAlpha) {
  let r = 37;
  let g = 99;
  let b = 235;

  if (color && typeof color === "object") {
    if (color.r === color.r && color.g === color.g && color.b === color.b) {
      r = color.r | 0;
      g = color.g | 0;
      b = color.b | 0;
    }
  } else if (typeof color === "string") {
    let h = color.trim();
    if (h[0] === "#") h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6 || h.length === 8) {
      const n = parseInt(h.slice(0, 6), 16);
      if (!Number.isNaN(n)) {
        r = (n >> 16) & 255;
        g = (n >> 8) & 255;
        b = n & 255;
      }
    }
  }

  return `rgba(${r}, ${g}, ${b}, ${themeAlpha(lightAlpha)})`;
}

// —— World-bound layout helpers ————————————————————————————————

/**
 * Build the `world.helpers` bag attached by canvas on each effect start.
 * Methods close over `world` so effects need not pass width/height/padding.
 *
 * @param {{ cards: unknown[], width: number, height: number, cardRadius: number, padding: number }} world
 */
export function createHelpers(world) {
  return {
    /** Uniform random in [min, max). */
    random(min, max) {
      return min + Math.random() * (max - min);
    },

    randomRgb,

    /**
     * Keep a disc fully on-stage: clamp *center* so the rim stays inside padding
     * (not a top-left box clamp).
     */
    clamp(card) {
      const m = world.padding;
      const r = card.radius;
      card.x = Math.min(Math.max(m + r, card.x), Math.max(m + r, world.width - m - r));
      card.y = Math.min(Math.max(m + r, card.y), Math.max(m + r, world.height - m - r));
    },

    /**
     * One horizontal row of disc centers along an edge (or custom y).
     * Row is centered when it fits; otherwise left-aligned to padding.
     * @param {"top"|"bottom"|"center"} edge
     * @param {{ gap?: number, y?: number }} [opts]
     */
    rowPositions(edge, opts = {}) {
      const n = world.cards.length;
      const gap = opts.gap ?? world.padding;
      const d = 2 * world.cardRadius;
      const totalW = n * d + Math.max(0, n - 1) * gap;
      const startX = Math.max(
        world.padding + world.cardRadius,
        (world.width - totalW) / 2 + world.cardRadius
      );
      let y;
      if (typeof opts.y === "number") y = opts.y;
      else if (edge === "top") y = world.padding + world.cardRadius;
      else if (edge === "bottom") y = world.height - world.padding - world.cardRadius;
      else y = world.height / 2;

      return world.cards.map((_, i) => ({
        x: startX + i * (d + gap),
        y,
      }));
    },

    /**
     * Random on-stage centers. marginScale multiplies padding (e.g. 2 = more inset).
     * Does not avoid overlaps — use bottomHalfPositions when packing matters.
     */
    scatterPositions(marginScale = 1) {
      const m = world.padding * marginScale;
      const r = world.cardRadius;
      return world.cards.map(() => ({
        x: m + r + Math.random() * Math.max(1, world.width - 2 * (m + r)),
        y: m + r + Math.random() * Math.max(1, world.height - 2 * (m + r)),
      }));
    },

    /**
     * Non-overlapping centers in the *bottom half* of the stage (boids / voronoi start).
     * 1) Rejection-sample random points with min center distance 2R+gap.
     * 2) If a sample fails, fall back to a packed grid (L→R, bottom→up).
     * 3) If the stage is tiny, stack with a small jitter (may still overlap; clamp later).
     *
     * @param {{ gap?: number, attempts?: number }} [opts]
     */
    bottomHalfPositions(opts = {}) {
      const n = world.cards.length;
      const gap = opts.gap ?? world.padding;
      const attempts = opts.attempts ?? 100;
      const r = world.cardRadius;
      const m = world.padding;
      const minX = m + r;
      const maxX = Math.max(minX, world.width - m - r);
      // Bottom half starts at mid-stage; rim may slightly cross the midline.
      const minY = Math.max(m + r, world.height * 0.5);
      const maxY = Math.max(minY, world.height - m - r);
      const minDist = 2 * r + gap;
      const minDist2 = minDist * minDist;

      /** @type {{ x: number, y: number }[]} */
      const positions = [];

      const fits = (x, y) => {
        for (let i = 0; i < positions.length; i++) {
          const dx = positions[i].x - x;
          const dy = positions[i].y - y;
          if (dx * dx + dy * dy < minDist2) return false;
        }
        return true;
      };

      for (let i = 0; i < n; i++) {
        let placed = false;
        for (let a = 0; a < attempts; a++) {
          const x = minX + Math.random() * Math.max(1, maxX - minX);
          const y = minY + Math.random() * Math.max(1, maxY - minY);
          if (!fits(x, y)) continue;
          positions.push({ x, y });
          placed = true;
          break;
        }
        if (placed) continue;

        // Grid pack remaining slots.
        const stride = minDist;
        const cols = Math.max(1, Math.floor((maxX - minX) / stride) + 1);
        let slot = positions.length;
        let found = false;
        for (let guard = 0; guard < n * cols * 4 && !found; guard++, slot++) {
          const col = slot % cols;
          const row = Math.floor(slot / cols);
          const x = Math.min(maxX, minX + col * stride);
          const y = Math.max(minY, maxY - row * stride);
          if (fits(x, y)) {
            positions.push({ x, y });
            found = true;
          }
        }
        if (!found) {
          positions.push({
            x: minX + (positions.length % 3) * (r * 0.5),
            y: maxY,
          });
        }
      }

      return positions;
    },
  };
}

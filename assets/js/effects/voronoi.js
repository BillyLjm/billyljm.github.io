/**
 * Voronoi diagram: card centers are primary seed sites, plus a scatter of
 * non-card “ghost” seeds so the tessellation stays rich with few mini-sites.
 * Cells are clipped half-planes (fine for dozens of sites), filled with the
 * site's accent (ghosts: random RGB at low alpha; card cells: a=1).
 * Drag cards to reshape; ghosts stay put. A ghost is turned off (excluded from
 * the diagram) whenever any card center comes near it, so card cells expand.
 *
 * Continuous + non-interactive: pointer drag still works via canvas continuous
 * path; the diagram recomputes every frame from live card centers + active ghosts.
 */

import { rgba, randomRgb } from "./+helpers.js";

/** Target ghost count scales with stage area, clamped. */
function ghostCount(world) {
  const area = world.width * world.height;
  // ~1 ghost per 10k px², with a floor so small stages still look busy.
  return Math.max(20, Math.round(area / 10000));
}

/**
 * True if any card is close enough that this ghost should be inactive.
 * @param {{ x: number, y: number }} ghost
 * @param {Array<{ x: number, y: number, radius: number }>} cards
 */
function ghostNearCard(ghost, cards) {
  for (const card of cards) {
    const lim = 2.2 * card.radius;
    const dx = ghost.x - card.x;
    const dy = ghost.y - card.y;
    if (dx * dx + dy * dy < lim * lim) return true;
  }
  return false;
}

/**
 * Clip a convex polygon to the half-plane (p - m) · n <= 0.
 * @param {{ x: number, y: number }[]} poly
 * @param {number} mx
 * @param {number} my
 * @param {number} nx
 * @param {number} ny
 * @returns {{ x: number, y: number }[]}
 */
function clipHalfPlane(poly, mx, my, nx, ny) {
  if (!poly.length) return poly;

  const inside = (p) => (p.x - mx) * nx + (p.y - my) * ny <= 1e-9;
  /** @type {{ x: number, y: number }[]} */
  const out = [];

  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);

    if (curIn !== prevIn) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const denom = dx * nx + dy * ny;
      let t = 0.5;
      if (Math.abs(denom) > 1e-12) {
        t = ((mx - prev.x) * nx + (my - prev.y) * ny) / denom;
      }
      t = Math.max(0, Math.min(1, t));
      out.push({ x: prev.x + t * dx, y: prev.y + t * dy });
    }
    if (curIn) out.push(cur);
  }

  return out;
}

/**
 * Voronoi cell for site i as a polygon clipped to the stage.
 * @param {{ x: number, y: number }[]} sites
 * @param {number} i
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number }[]}
 */
function cellPolygon(sites, i, width, height) {
  /** @type {{ x: number, y: number }[]} */
  let poly = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  const si = sites[i];
  for (let j = 0; j < sites.length; j++) {
    if (i === j) continue;
    const sj = sites[j];
    const dx = sj.x - si.x;
    const dy = sj.y - si.y;
    if (dx * dx + dy * dy < 1e-8) continue;

    // Perpendicular bisector: keep the half-plane closer to si.
    const mx = (si.x + sj.x) / 2;
    const my = (si.y + sj.y) / 2;
    poly = clipHalfPlane(poly, mx, my, dx, dy);
    if (poly.length < 3) break;
  }

  return poly;
}

/**
 * One ghost seed: random on-stage point + randomRgb color.
 * Card cells use hex accents from site front matter instead.
 * @param {object} world
 * @param {number} margin
 * @returns {{ x: number, y: number, accent: { r: number, g: number, b: number } }}
 */
function randomGhost(world, margin) {
  const m = Math.max(margin, world.padding);
  const w = Math.max(1, world.width - 2 * m);
  const h = Math.max(1, world.height - 2 * m);
  return {
    x: m + Math.random() * w,
    y: m + Math.random() * h,
    accent: randomRgb(),
  };
}

/**
 * Soft-separate a list of {x,y} points (optional radius / pin).
 * Pinned points never move (used so ghosts yield around cards).
 * @param {{ x: number, y: number, radius?: number, pin?: boolean }[]} points
 * @param {object} world
 * @param {number} defaultMin  minimum center distance when no radii
 * @param {number} iters
 */
function separatePoints(points, world, defaultMin, iters) {
  const m = world.padding;
  for (let iter = 0; iter < iters; iter++) {
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        if (a.pin && b.pin) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        const ra = a.radius ?? 0;
        const rb = b.radius ?? 0;
        const minDist = ra + rb > 0 ? ra + rb + world.padding * 0.35 : defaultMin;
        if (dist < 1e-6) {
          const ang = (i * 2.399 + j) % (Math.PI * 2);
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          dist = 1;
        }
        if (dist >= minDist) continue;
        const push = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        if (a.pin) {
          b.x += nx * push;
          b.y += ny * push;
        } else if (b.pin) {
          a.x -= nx * push;
          a.y -= ny * push;
        } else {
          const half = push * 0.5;
          a.x -= nx * half;
          a.y -= ny * half;
          b.x += nx * half;
          b.y += ny * half;
        }
      }
    }
    for (const p of points) {
      if (p.pin) continue;
      const r = p.radius ?? 0;
      p.x = Math.min(Math.max(m + r, p.x), Math.max(m + r, world.width - m - r));
      p.y = Math.min(Math.max(m + r, p.y), Math.max(m + r, world.height - m - r));
    }
  }
}

/**
 * Scatter + separate ghost seeds for the current stage size.
 * Cards are left where they are (pinned during separation).
 * Call on start and on every resize so density stays even.
 * @param {object} world
 */
function placeGhosts(world) {
  const nGhost = ghostCount(world);
  const minGhost = Math.max(36, world.cardRadius * 0.55);
  /** @type {{ x: number, y: number, accent: { r: number, g: number, b: number } }[]} */
  const ghosts = [];
  for (let i = 0; i < nGhost; i++) {
    ghosts.push(randomGhost(world, world.padding + 8));
  }

  // Separate ghosts from each other and from cards; cards stay pinned.
  const mixed = [
    ...world.cards.map((c) => ({
      x: c.x,
      y: c.y,
      radius: c.radius * 0.85,
      pin: true,
    })),
    ...ghosts.map((g) => ({ x: g.x, y: g.y, radius: minGhost * 0.45 })),
  ];
  separatePoints(mixed, world, minGhost, 18);

  const ghostStart = world.cards.length;
  for (let i = 0; i < ghosts.length; i++) {
    ghosts[i].x = mixed[ghostStart + i].x;
    ghosts[i].y = mixed[ghostStart + i].y;
  }

  world._voronoi = { ghosts };
}

/**
 * Place cards + ghost seeds with separation so cells start non-trivial.
 * @param {object} world
 */
function placeSeeds(world) {
  // Non-overlapping in the bottom half (shared helper; same as boids).
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

  placeGhosts(world);
}

/**
 * Active sites for the diagram: all cards, then ghosts that are not near a card.
 * Near ghosts are fully off (no seed, no cell) so neighboring cells expand.
 * @param {object} world
 * @returns {{ x: number, y: number, accent: string|{ r: number, g: number, b: number }, card: object|null, ghost: boolean }[]}
 */
function activeSites(world) {
  const sites = world.cards.map((c) => ({
    x: c.x,
    y: c.y,
    accent: c.accent || "#2563eb",
    card: c,
    ghost: false,
  }));
  const ghosts = world._voronoi?.ghosts || [];
  for (const g of ghosts) {
    if (ghostNearCard(g, world.cards)) continue;
    sites.push({
      x: g.x,
      y: g.y,
      accent: g.accent || { r: 136, g: 136, b: 136 },
      card: null,
      ghost: true,
    });
  }
  return sites;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number }[]} poly
 */
function pathPoly(ctx, poly) {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i].x, poly[i].y);
  }
  ctx.closePath();
}

export default {
  id: "voronoi",
  label: "Voronoi",
  weight: 1,
  interactive: false,
  continuous: true,

  start(world) {
    placeSeeds(world);
  },

  /**
   * Layout is user-driven; diagram is rebuilt in draw from live centers.
   * @returns {true}
   */
  update() {
    return true;
  },

  /**
   * Paint Voronoi cells under the cards (canvas calls this after the background).
   * @param {object} world
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(world, ctx) {
    if (!world.cards.length) return;
    // Ensure ghosts exist if start was skipped somehow.
    if (!world._voronoi?.ghosts?.length) placeSeeds(world);

    const sites = activeSites(world);
    const pts = sites.map((s) => ({ x: s.x, y: s.y }));
    const hoverId = world.hoverId || null;
    const dragId = world.draggingId || null;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.15;

    for (let i = 0; i < sites.length; i++) {
      const poly = cellPolygon(pts, i, world.width, world.height);
      if (poly.length < 3) continue;

      const site = sites[i];
      pathPoly(ctx, poly);
      ctx.fillStyle = rgba(site.accent, site.ghost ? 0.1 : 0.5);
      ctx.fill();
      ctx.strokeStyle = rgba(site.accent, site.ghost ? 0.1 : 0.5);
      ctx.stroke();
    }

    // Seed dots: ghosts transparent; cards solid.
    for (const site of sites) {
      if (site.ghost) {
        ctx.beginPath();
        ctx.arc(site.x, site.y, 2.25, 0, Math.PI * 2);
        ctx.fillStyle = rgba(site.accent, 0.35);
        ctx.fill();
        continue;
      }
      const active =
        site.card && (site.card.id === hoverId || site.card.id === dragId);
      ctx.beginPath();
      ctx.arc(site.x, site.y, active ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = rgba(site.accent, 1);
      ctx.fill();
    }

    ctx.restore();
  },

  skip(world) {
    placeSeeds(world);
  },

  resize(world) {
    for (const card of world.cards) world.helpers.clamp(card);
    // Fresh scatter so ghosts re-fill the new stage evenly (count scales with area).
    placeGhosts(world);
  },
};

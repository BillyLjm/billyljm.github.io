import { loadEffects } from "./effects/+index.js";
import {
  createGreeting,
  resizeGreeting,
  updateGreeting,
  drawGreeting,
  greetingNeedsAnimation,
} from "./greeting.js";

const Effects = await loadEffects();

/**
 * Landing canvas: disc cards + physics effects + shared greeting underlay.
 * Cards use center (x, y) + radius. ES modules forbid top-level return.
 */
const CARD_RADIUS = 100;
const PADDING = 24;
/** Pointer travel below this (px) counts as a click, not a drag. */
const CLICK_THRESHOLD = 6;
/** Sliding window for throw velocity (ms of recent pointer samples). */
const THROW_SAMPLE_MS = 100;
const THROW_GAIN = 1.15;
const THROW_MAX_SPEED = 2800;

const canvas = document.getElementById("landing-canvas");
if (!canvas) throw new Error("[canvas] Missing #landing-canvas");

const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("canvas-status");
const dataEl = document.getElementById("sites-data");
const effectPicker = document.getElementById("effect-picker");

let cards = [];
let dpr = 1;
let width = 0;
let height = 0;
let dragging = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let pointerStartX = 0;
let pointerStartY = 0;
let moved = false;
let hoverId = null;
let nextZ = 1;
let needsDraw = true;
let reducedMotion = false;
let activeEffect = null;
let effectRunning = false;
let lastTs = 0;
let world = null;
/** Shared one-shot greeting underlay (greeting.js); not a pickable effect. */
let greeting = null;
/** Recent pointer samples for throw velocity: { t, x, y }. */
let throwSamples = [];

try {
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
} catch (_) {
  /* ignore */
}

function loadSites() {
  try {
    return JSON.parse(dataEl?.textContent || "[]");
  } catch (err) {
    console.error("Failed to parse sites data", err);
    return [];
  }
}

/** Fallback grid of disc centers when no effect is active. */
function defaultPositions(count, stageW, stageH) {
  const d = CARD_RADIUS * 2;
  const cols = Math.max(1, Math.floor((stageW - PADDING) / (d + PADDING)));
  const positions = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const nInRow = Math.min(count - row * cols, cols);
    const totalRowWidth = nInRow * d + (nInRow - 1) * PADDING;
    const offsetX = Math.max(
      PADDING + CARD_RADIUS,
      (stageW - totalRowWidth) / 2 + CARD_RADIUS
    );
    positions.push({
      x: offsetX + col * (d + PADDING),
      y: PADDING + CARD_RADIUS + row * (d + PADDING) + 8,
    });
  }
  return positions;
}

const imageCache = new Map();

/** Load a thumbnail; redraw when ready. Failed loads use the accent fallback. */
function loadCardImage(src) {
  if (!src) return null;
  const cached = imageCache.get(src);
  if (cached) return cached;

  const img = new Image();
  img.decoding = "async";
  img.loading = "eager";
  imageCache.set(src, img);
  img.onload = () => {
    needsDraw = true;
  };
  img.onerror = () => {
    img._failed = true;
    needsDraw = true;
  };
  img.src = src;
  return img;
}

function buildCards() {
  cards = loadSites().map((site, i) => {
    const id = site.slug || `site-${i}`;
    const thumbnail = site.thumbnail || "";
    return {
      id,
      title: site.title || id,
      slug: site.slug || id,
      description: site.description || "",
      status: site.status || "Site",
      accent: site.accent || "#2563eb",
      thumbnail,
      image: loadCardImage(thumbnail),
      url: site.url || `/${site.slug}/`,
      // Disc pose: x/y are center; angle rolls with drag/throw.
      x: PADDING + CARD_RADIUS + i * 40,
      y: PADDING + CARD_RADIUS + i * 30,
      radius: CARD_RADIUS,
      z: i + 1,
      vx: 0,
      vy: 0,
      angle: 0, // orientation (rad); drawn via ctx.rotate
      omega: 0, // spin (rad/s); set by collision / throw
    };
  });
  nextZ = cards.length + 1;
}

/** Keep the disc fully on-stage (clamp center so the rim stays inset). */
function clamp(card) {
  const m = 8;
  const r = card.radius;
  card.x = Math.min(Math.max(m + r, card.x), Math.max(m + r, width - m - r));
  card.y = Math.min(Math.max(m + r, card.y), Math.max(m + r, height - m - r));
}

function clampAll() {
  for (const card of cards) clamp(card);
}

function makeWorld() {
  const w = {
    cards,
    width,
    height,
    cardRadius: CARD_RADIUS,
    padding: PADDING,
    elapsed: 0,
  };
  w.helpers = Effects.createHelpers(w);
  return w;
}

/** Push live canvas state into world before effect update/draw. */
function syncWorld() {
  if (!world) return;
  world.cards = cards;
  world.width = width;
  world.height = height;
  world.draggingId = dragging ? dragging.id : null;
  world.hoverId = hoverId;
}

function isInteractiveEffect() {
  return !!(activeEffect && activeEffect.interactive && effectRunning);
}

/** Settled layouts, throw-physics, and continuous effects all accept drag/click. */
function allowsPointer() {
  if (!effectRunning) return true;
  return !!(activeEffect && (activeEffect.interactive || activeEffect.continuous));
}

function effectStatus(extra) {
  const name = activeEffect ? activeEffect.label || activeEffect.id : null;
  if (!name) return extra || "";
  return extra ? `${name} · ${extra}` : name;
}

function syncEffectPicker() {
  if (!effectPicker || !activeEffect) return;
  if (effectPicker.value !== activeEffect.id) {
    effectPicker.value = activeEffect.id;
  }
}

function startEffect(effect) {
  if (!cards.length) return;

  dragging = null;
  throwSamples = [];
  canvas.classList.remove("is-dragging");

  // Fresh world drops effect-private state from the previous run (_boids, _phys, …).
  world = makeWorld();
  activeEffect = effect || null;

  if (!activeEffect) {
    effectRunning = false;
    const defaults = defaultPositions(cards.length, width, height);
    cards.forEach((c, i) => {
      c.x = defaults[i].x;
      c.y = defaults[i].y;
      c.held = false;
    });
    needsDraw = true;
    return;
  }

  syncEffectPicker();

  // Reduced motion: skip one-shot entrances; continuous effects still run.
  if (reducedMotion && !activeEffect.interactive && typeof activeEffect.skip === "function") {
    activeEffect.skip(world);
    if (!activeEffect.continuous) {
      effectRunning = false;
      clampAll();
      setStatus(effectStatus());
      needsDraw = true;
      return;
    }
    // Continuous non-interactive: layout instantly, keep the update loop.
    effectRunning = true;
    lastTs = performance.now();
    setStatus(effectStatus("drag to move, click to open"));
    needsDraw = true;
    return;
  }

  activeEffect.start(world);
  effectRunning = true;
  lastTs = performance.now();
  setStatus(
    activeEffect.interactive
      ? effectStatus("drag to throw, click to open")
      : activeEffect.continuous
        ? effectStatus("drag to move, click to open")
        : effectStatus()
  );
  needsDraw = true;
}

function startRandomEffect() {
  startEffect(Effects.pickRandom());
}

function switchEffect(id) {
  const effect = Effects.get(id);
  if (!effect || (activeEffect && activeEffect.id === id && effectRunning)) return;
  try {
    sessionStorage.setItem("canvas-last-effect-v1", effect.id);
  } catch (_) {
    /* ignore */
  }
  startEffect(effect);
}

function initEffectPicker() {
  if (!effectPicker) {
    console.warn("[canvas] effect picker markup missing");
    return;
  }

  const list = Effects.list();
  effectPicker.replaceChildren();

  if (!list.length) {
    effectPicker.hidden = true;
    console.warn("[canvas] no effects registered for picker");
    return;
  }

  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.id;
    effectPicker.appendChild(opt);
  }

  effectPicker.addEventListener("change", () => switchEffect(effectPicker.value));
  // Stop picker clicks from hitting the canvas stage underneath.
  effectPicker.addEventListener("pointerdown", (e) => e.stopPropagation());
}

function finishEffect() {
  effectRunning = false;
  for (const card of cards) {
    card.vx = 0;
    card.vy = 0;
    card.omega = 0;
    clamp(card);
  }
  setStatus(
    activeEffect
      ? effectStatus("drag to move, click to open")
      : "Drag thumbnails to arrange · click to open"
  );
  needsDraw = true;
}

/** Fit the drawing buffer to the stage. Returns true if CSS size changed. */
function fitCanvas() {
  const stage = canvas.parentElement;
  const rect = stage?.getBoundingClientRect();
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const nextW = Math.max(320, Math.floor(rect?.width || vw));
  const nextH = Math.max(320, Math.floor(rect?.height || vh));
  const sizeChanged = nextW !== width || nextH !== height;

  width = nextW;
  height = nextH;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return sizeChanged;
}

function resize() {
  const sizeChanged = fitCanvas();
  if (sizeChanged && greeting) resizeGreeting(greeting, width, height);

  if (world) {
    world.width = width;
    world.height = height;
  }
  if (sizeChanged) {
    // Effects may reflow (e.g. separate overlaps); otherwise just clamp.
    if (activeEffect && typeof activeEffect.resize === "function" && world) {
      activeEffect.resize(world);
    } else if (!effectRunning) {
      clampAll();
    }
  }
  needsDraw = true;
}

function sortedCards() {
  return [...cards].sort((a, b) => a.z - b.z);
}

/** Topmost disc under the pointer (circle hit-test on centers). */
function hitTest(x, y) {
  const list = sortedCards();
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    const dx = x - c.x;
    const dy = y - c.y;
    if (dx * dx + dy * dy <= c.radius * c.radius) return c;
  }
  return null;
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg || "";
}

/**
 * Kinematic pure-roll while dragging (canvas y-down: Δθ = +Δx / R).
 * Physics uses the same sign so a throw continues with matching spin.
 */
function rollByDx(card, dx) {
  card.angle += dx / card.radius;
}

/** Read a theme CSS custom property (see _sass/base.scss). */
function themeVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_) {
    return fallback;
  }
}

function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, themeVar("--canvas-bg-0", "#eef2ff"));
  g.addColorStop(0.45, themeVar("--canvas-bg-1", "#f7f8fa"));
  g.addColorStop(1, themeVar("--canvas-bg-2", "#ecfeff"));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Soft dot grid over the gradient.
  ctx.fillStyle = themeVar("--canvas-dot", "rgba(37, 99, 235, 0.05)");
  const step = 28;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Cover-fit thumbnail into the card rect. Accent gradient while loading / on error.
 * Caller clips to the disc shape.
 */
function drawThumbnail(card, x, y, w, h) {
  const img = card.image;
  const ready = img && img.complete && img.naturalWidth > 0 && !img._failed;

  if (!ready) {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, card.accent || "#2563eb");
    g.addColorStop(1, "#0f172a");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    return;
  }

  // object-fit: cover
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * Circular full-bleed card. Thumbnail + title rotate with card.angle (rolling).
 */
function drawCard(card, isHover, isDragging) {
  const { x: cx, y: cy, radius: r } = card;
  const d = r * 2;
  const active = isHover || isDragging;

  // Drop shadow under the clipped image (screen space, does not spin).
  ctx.save();
  ctx.shadowColor = isDragging
    ? "rgba(15, 23, 42, 0.32)"
    : isHover
      ? "rgba(15, 23, 42, 0.20)"
      : "rgba(15, 23, 42, 0.12)";
  ctx.shadowBlur = isDragging ? 28 : isHover ? 20 : 14;
  ctx.shadowOffsetY = isDragging ? 16 : 8;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#0f172a";
  ctx.fill();
  ctx.restore();

  // Content in local space: origin at center, rotated by roll angle.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(card.angle);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  drawThumbnail(card, -r, -r, d, d);

  // Bottom scrim: dark gradient so the title stays readable over the photo.
  // scrimH = band height from the bottom chord; stronger alpha on hover/drag.
  const scrimH = Math.min(72, d * 0.4);
  const scrim = ctx.createLinearGradient(0, r - scrimH, 0, r);
  const scrimAlpha = active ? 0.78 : 0.42;
  scrim.addColorStop(0, "rgba(15, 23, 42, 0)");
  scrim.addColorStop(0.45, `rgba(15, 23, 42, ${scrimAlpha * 0.55})`);
  scrim.addColorStop(1, `rgba(15, 23, 42, ${scrimAlpha})`);
  ctx.fillStyle = scrim;
  ctx.fillRect(-r, r - scrimH, d, scrimH);

  if (active) {
    ctx.fillStyle = "rgba(15, 23, 42, 0.08)";
    ctx.fillRect(-r, -r, d, d);
  }

  // Title near the bottom chord (rolls with the disc).
  const maxTitleW = d * 0.72;
  ctx.font = "600 15px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = active ? "rgba(255, 255, 255, 0.98)" : "rgba(255, 255, 255, 0.72)";
  ctx.fillText(truncate(card.title || card.slug || "", maxTitleW), 0, r - 18, maxTitleW);
  ctx.restore();
}

/** Fit title to a pixel width with an ellipsis. */
function truncate(text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

function draw() {
  // Paint order: background → greeting → effect underlay → cards.
  drawBackground();
  if (greeting) drawGreeting(greeting, ctx);
  if (activeEffect && typeof activeEffect.draw === "function" && world) {
    syncWorld();
    activeEffect.draw(world, ctx);
  }
  for (const card of sortedCards()) {
    drawCard(card, hoverId === card.id, dragging?.id === card.id);
  }
  needsDraw = false;
}

function loop(ts) {
  const now = ts || performance.now();
  if (!lastTs) lastTs = now;
  const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
  lastTs = now;

  if (effectRunning && activeEffect && world) {
    world.elapsed += dt;
    syncWorld();
    const stillRunning = activeEffect.update(world, dt);
    needsDraw = true;
    if (!stillRunning) finishEffect();
  }

  // Greeting is a one-shot intro; capture "was animating" so the settle frame still draws.
  const greetingAnimating = !!(greeting && greetingNeedsAnimation(greeting));
  if (greetingAnimating) updateGreeting(greeting, dt);

  if (needsDraw || effectRunning || greetingAnimating) draw();
  requestAnimationFrame(loop);
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const clientX = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
  const clientY = event.clientY ?? event.touches?.[0]?.clientY ?? 0;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function bringToFront(card) {
  card.z = nextZ++;
}

function openCard(card) {
  setStatus(`Opening ${card.title}…`);
  window.location.href = card.url;
}

/** Append a pointer sample; keep only the last THROW_SAMPLE_MS of the trail. */
function recordThrowSample(x, y) {
  const t = performance.now();
  throwSamples.push({ t, x, y });
  const cutoff = t - THROW_SAMPLE_MS;
  while (throwSamples.length && throwSamples[0].t < cutoff) throwSamples.shift();
}

/** Average velocity over the sample window (px/s), gain + max-speed clamp. */
function velocityFromSamples() {
  if (throwSamples.length < 2) return { vx: 0, vy: 0 };
  const first = throwSamples[0];
  const last = throwSamples[throwSamples.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0.001) return { vx: 0, vy: 0 };
  let vx = ((last.x - first.x) / dt) * THROW_GAIN;
  let vy = ((last.y - first.y) / dt) * THROW_GAIN;
  const speed = Math.hypot(vx, vy);
  if (speed > THROW_MAX_SPEED) {
    const s = THROW_MAX_SPEED / speed;
    vx *= s;
    vy *= s;
  }
  return { vx, vy };
}

function onPointerDown(event) {
  if (!allowsPointer()) return;
  if (event.button != null && event.button !== 0) return;
  const { x, y } = canvasPoint(event);
  const card = hitTest(x, y);
  if (!card) return;

  event.preventDefault();
  dragging = card;
  card.held = true;
  card.vx = 0;
  card.vy = 0;
  dragOffsetX = x - card.x;
  dragOffsetY = y - card.y;
  pointerStartX = x;
  pointerStartY = y;
  moved = false;
  throwSamples = [];
  recordThrowSample(x, y);
  bringToFront(card);
  canvas.setPointerCapture?.(event.pointerId);
  canvas.classList.add("is-dragging");
  setStatus(
    isInteractiveEffect()
      ? `Holding ${card.title} — fling to throw`
      : `Dragging ${card.title}`
  );
  needsDraw = true;
}

function onPointerMove(event) {
  const { x, y } = canvasPoint(event);

  if (dragging) {
    if (Math.hypot(x - pointerStartX, y - pointerStartY) > CLICK_THRESHOLD) moved = true;

    const prevX = dragging.x;
    dragging.x = x - dragOffsetX;
    dragging.y = y - dragOffsetY;

    if (isInteractiveEffect()) {
      // Soft edge clamp so throws near the rim still feel good.
      const m = 4;
      const r = dragging.radius;
      dragging.x = Math.min(Math.max(m + r, dragging.x), Math.max(m + r, width - m - r));
      dragging.y = Math.min(Math.max(m + r, dragging.y), Math.max(m + r, height - m - r));
      // Pure-roll under the finger; omega so release continues with matching spin.
      rollByDx(dragging, dragging.x - prevX);
      recordThrowSample(x, y);
      const v = velocityFromSamples();
      dragging.vx = v.vx;
      dragging.vy = v.vy;
      dragging.omega = v.vx / dragging.radius;
    } else {
      clamp(dragging);
      rollByDx(dragging, dragging.x - prevX);
      dragging.omega = 0;
    }
    needsDraw = true;
    return;
  }

  if (!allowsPointer()) {
    canvas.style.cursor = "default";
    return;
  }

  const card = hitTest(x, y);
  const nextHover = card?.id || null;
  if (nextHover === hoverId) return;

  hoverId = nextHover;
  canvas.style.cursor = card ? "grab" : "default";
  const hint = isInteractiveEffect()
    ? "drag to throw, click to open"
    : "drag to move, click to open";
  setStatus(card ? `${card.title} — ${hint}` : effectStatus(hint));
  needsDraw = true;
}

function onPointerUp() {
  if (!dragging) return;
  const card = dragging;
  const wasClick = !moved;

  if (isInteractiveEffect()) {
    // Hand off window velocity so the physics effect can integrate the throw.
    const v = velocityFromSamples();
    card.vx = v.vx;
    card.vy = v.vy;
    card.omega = v.vx / card.radius;
    card.held = false;
    if (!wasClick) setStatus(effectStatus(`threw ${card.title}`));
  } else {
    card.held = false;
    card.vx = 0;
    card.vy = 0;
    card.omega = 0;
    if (!wasClick) setStatus(`Moved ${card.title}`);
  }

  dragging = null;
  throwSamples = [];
  canvas.classList.remove("is-dragging");
  canvas.style.cursor = hoverId ? "grab" : "default";
  needsDraw = true;

  if (wasClick) openCard(card);
}

function onDblClick(event) {
  if (!allowsPointer()) return;
  const { x, y } = canvasPoint(event);
  const card = hitTest(x, y);
  if (card) openCard(card);
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("dblclick", onDblClick);
canvas.addEventListener("pointerleave", () => {
  if (!dragging && hoverId) {
    hoverId = null;
    canvas.style.cursor = "default";
    needsDraw = true;
  }
});
window.addEventListener("resize", resize);

// Theme switcher (theme.js) — redraw so canvas tokens update immediately.
window.addEventListener("themechange", () => {
  needsDraw = true;
});

// ?effect=<id> forces that effect on load (debug).
const forcedEffect = new URLSearchParams(window.location.search).get("effect");
if (forcedEffect && Effects.get(forcedEffect)) {
  Effects.pickRandom = () => Effects.get(forcedEffect);
}

initEffectPicker();
fitCanvas();
greeting = createGreeting({ width, height, reducedMotion });
buildCards();
startRandomEffect();
requestAnimationFrame(loop);

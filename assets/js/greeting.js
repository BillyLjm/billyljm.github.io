/**
 * One-shot greeting underlay for the landing canvas (not an effect).
 * canvas.js paints this after the flat background, before effect.draw / cards.
 *
 * Boot flow:
 *   1. Prefetch + bake profile on module import (parallel with effect load)
 *   2. Hold intro clock until the disc is ready (no race with incomplete image)
 *   3. Avatar: spin 720° CW + scale 0→1.2 → settle 1.2→1
 *   4. Typewriter line → subline fade → static watermark
 *
 * Avatar pipeline is two-step on purpose:
 *   bakeCircularProfile — once: cover-fit + circular mask into an offscreen canvas
 *   drawAvatar          — every frame: place that sprite with live scale/spin
 */

const LINE = "Billy Lim";
const SUBLINE = "This site is under construction, but feel free to poke around";
const TYPE_CPS = 16;
const CARET_HOLD = 0.45;
const SUB_FADE = 0.5;

// Avatar entrance timing (seconds)
const AVATAR_SPIN = 0.55; // 720° + scale up to peak
const AVATAR_SETTLE = 0.2; // scale peak → 1 after spin stops
const AVATAR_TOTAL = AVATAR_SPIN + AVATAR_SETTLE;
const SCALE_PEAK = 1.2;
const AVATAR_TURNS = 2; // full 720° clockwise

const TYPE_DUR = LINE.length / TYPE_CPS;
const INTRO_DUR = AVATAR_TOTAL + TYPE_DUR + CARET_HOLD + SUB_FADE;
const FONT =
  'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

// import.meta.url keeps the path correct when the site is under a baseurl.
const PROFILE_SRC = new URL("../img/profile.png", import.meta.url).href;
// 256px covers max CSS radius (~56) at 2× DPR with headroom for scale peak.
const PROFILE_BAKE_PX = 256;

// Module-level profile so bake runs once and createGreeting can attach late.
let sharedDisc = null;
let sharedReady = false;
let sharedFailed = false;
/** Callbacks fired when prefetch finishes (createGreeting may have already run). */
const profileWaiters = [];

function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

/** Theme tokens from _sass/base.scss (html[data-theme]). */
function themeVar(name, fallback) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * One-time: cover-fit the photo into a circular offscreen canvas.
 * Smoothing here only affects this bake context (JPEG → 256px disc).
 * destination-in + 1px radial feather = hard disc with anti-aliased rim
 * (avoids jagged ctx.clip() on the main canvas every frame).
 */
function bakeCircularProfile(img) {
  const size = PROFILE_BAKE_PX;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const x = c.getContext("2d");
  if (!x) return null;

  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";

  // Center-crop square (object-fit: cover).
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  x.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size
  );

  // Keep pixels only inside a circle; feather the last 1px for AA.
  x.globalCompositeOperation = "destination-in";
  const mid = size / 2;
  const mask = x.createRadialGradient(mid, mid, mid - 1, mid, mid, mid);
  mask.addColorStop(0, "#000");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = mask;
  x.fillRect(0, 0, size, size);
  return c;
}

function finishProfile(ok, img) {
  if (ok) {
    sharedDisc = bakeCircularProfile(img);
    sharedReady = !!sharedDisc;
    sharedFailed = !sharedDisc;
  } else {
    sharedFailed = true;
  }
  while (profileWaiters.length) profileWaiters.shift()();
}

// Start fetch immediately so it overlaps canvas effect loading / first paint.
{
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    // decode() finishes pixel decode when supported (smoother first draw).
    if (typeof img.decode === "function") {
      img.decode().then(() => finishProfile(true, img)).catch(() => finishProfile(true, img));
    } else {
      finishProfile(true, img);
    }
  };
  img.onerror = () => finishProfile(false, img);
  img.src = PROFILE_SRC;
}

/** Copy shared bake result onto greeting state; skip avatar if load failed. */
function bindProfile(state) {
  state.profileDisc = sharedDisc;
  state.profileReady = sharedReady;
  state.profileFailed = sharedFailed;

  if (sharedFailed) {
    // No photo — jump past avatar phase into typewriter (or fully settle).
    state.t = state.reducedMotion ? INTRO_DUR : AVATAR_TOTAL;
    state.introStarted = true;
    if (state.reducedMotion) state.settled = true;
  } else if (sharedReady && state.reducedMotion) {
    state.t = INTRO_DUR;
    state.introStarted = true;
    state.settled = true;
  }
}

export function createGreeting({ width, height, reducedMotion = false, onDirty = null }) {
  const state = {
    width: Math.max(1, width),
    height: Math.max(1, height),
    t: 0,
    settled: false,
    // False until profile ready/failed — intro clock does not run yet.
    introStarted: false,
    reducedMotion: !!reducedMotion,
    profileDisc: null,
    profileReady: false,
    profileFailed: false,
    // canvas.js sets needsDraw when a late bake finishes after first paint.
    onDirty,
  };

  if (sharedReady || sharedFailed) {
    bindProfile(state);
  } else {
    profileWaiters.push(() => {
      bindProfile(state);
      if (typeof state.onDirty === "function") state.onDirty();
    });
  }
  return state;
}

export function resizeGreeting(state, width, height) {
  state.width = Math.max(1, width);
  state.height = Math.max(1, height);
}

export function updateGreeting(state, dt) {
  if (state.settled || state.reducedMotion) return;

  // Hold until bake finishes so the pop-in never fights a load hitch.
  if (!state.introStarted) {
    if (state.profileReady || state.profileFailed) state.introStarted = true;
    return; // one calm frame after bake before the clock advances
  }

  state.t = Math.min(INTRO_DUR, state.t + dt);
  if (state.t >= INTRO_DUR) state.settled = true;
}

/** Typewriter / caret / progress bar / subline for time t (after avatar phase). */
function poseAt(t) {
  if (t < AVATAR_TOTAL) return { text: "", caret: false, progress: 0, subAlpha: 0 };

  const local = t - AVATAR_TOTAL;
  if (local < TYPE_DUR) {
    const n = Math.min(LINE.length, Math.floor(local * TYPE_CPS) + 1);
    return { text: LINE.slice(0, n), caret: true, progress: n / LINE.length, subAlpha: 0 };
  }
  const after = local - TYPE_DUR;
  return {
    text: LINE,
    caret: after < CARET_HOLD,
    progress: 1,
    // Start subline fade slightly before caret hold ends.
    subAlpha: Math.max(0, Math.min(1, (after - CARET_HOLD * 0.35) / SUB_FADE)),
  };
}

/**
 * Live scale + rotation for the avatar entrance.
 * Photo stays fully opaque; motion is scale/spin only.
 */
function avatarPose(state) {
  if (!state.profileReady || !state.profileDisc) return { scale: 0, angle: 0 };
  if (state.reducedMotion || state.settled) return { scale: 1, angle: 0 };
  if (!state.introStarted) return { scale: 0, angle: 0 };

  if (state.t < AVATAR_SPIN) {
    const e = easeOutCubic(state.t / AVATAR_SPIN);
    // Canvas rotate() is clockwise for +angles. Start at -720° and ease to 0
    // so the motion reads as a clockwise unwind.
    return { scale: e * SCALE_PEAK, angle: (e - 1) * AVATAR_TURNS * Math.PI * 2 };
  }

  // Spin stopped — ease scale from peak back to 1.
  const e = easeOutCubic(Math.min(1, (state.t - AVATAR_SPIN) / AVATAR_SETTLE));
  return { scale: SCALE_PEAK + (1 - SCALE_PEAK) * e, angle: 0 };
}

/**
 * Per-frame: draw the pre-baked disc with current scale/spin.
 * ctx is the shared landing canvas (effects/cards mutate it too), so we set
 * smoothing/shadow here for *destination* scaling — separate from bake-time
 * smoothing on the offscreen context.
 */
function drawAvatar(ctx, state, cx, cy, radius, scale, angle) {
  if (scale < 0.01 || !state.profileDisc) return;

  const r = radius * scale;
  const d = r * 2;
  const ringRgb = themeVar("--greeting-bar", "37, 99, 235");

  ctx.save();
  // How the 256px disc is resampled when scaled onto the main canvas.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Shadow in screen space first (does not spin with the disc).
  ctx.shadowColor = "rgba(15, 23, 42, 0.18)";
  ctx.shadowBlur = r * 0.35;
  ctx.shadowOffsetY = r * 0.08;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.98, 0, Math.PI * 2);
  ctx.fillStyle = "#0f172a";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Photo + ring rotate around disc center.
  ctx.translate(cx, cy);
  if (angle) ctx.rotate(angle);
  ctx.drawImage(state.profileDisc, -r, -r, d, d);

  ctx.beginPath();
  ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${ringRgb}, 0.45)`;
  ctx.lineWidth = Math.max(2, r * 0.045);
  ctx.stroke();
  ctx.restore();
}

export function drawGreeting(state, ctx) {
  const { width, height, t, reducedMotion, settled } = state;
  const cx = width / 2;
  const cy = height * 0.38;
  const size = Math.max(28, Math.min(72, Math.min(width * 0.09, height * 0.11)));
  const avatarR = Math.max(28, Math.min(56, size * 0.85));
  // Stack avatar above the type line with a little gap.
  const avatarCy = cy - size * 0.55 - avatarR;
  const { text, caret, progress, subAlpha } = poseAt(t);
  const { scale, angle } = avatarPose(state);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${size}px ${FONT}`;

  // Soft radial glow behind the greeting block.
  const glowR = size * 2.2;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, themeVar("--greeting-glow-0", "rgba(99, 102, 241, 0.12)"));
  glow.addColorStop(0.55, themeVar("--greeting-glow-1", "rgba(59, 130, 246, 0.05)"));
  glow.addColorStop(1, "rgba(99, 102, 241, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();

  drawAvatar(ctx, state, cx, avatarCy, avatarR, scale, angle);

  if (text) {
    ctx.fillStyle = themeVar("--greeting-text", "rgba(15, 23, 42, 0.86)");
    ctx.fillText(text, cx, cy);
    // Blinking caret while typing (sin wave gate).
    if (!reducedMotion && caret && !settled && Math.sin(t * 8) > 0) {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = themeVar("--greeting-caret", "rgba(37, 99, 235, 0.85)");
      ctx.fillRect(cx + tw / 2 + 4, cy - size * 0.36, 3, size * 0.72);
    }
  }

  // Fade-edge progress bar under the title (grows with type progress).
  if (progress > 0.35) {
    const barW = Math.min(width * 0.28, size * 4.5) * Math.min(1, progress);
    const barY = cy + size * 0.62;
    const barAlpha = 0.5 * Math.min(1, (progress - 0.35) / 0.4);
    // --greeting-bar is "r, g, b" so alpha can vary with reveal progress.
    const barRgb = themeVar("--greeting-bar", "37, 99, 235");
    const bar = ctx.createLinearGradient(cx - barW / 2, barY, cx + barW / 2, barY);
    bar.addColorStop(0, `rgba(${barRgb}, 0)`);
    bar.addColorStop(0.5, `rgba(${barRgb}, ${barAlpha})`);
    bar.addColorStop(1, `rgba(${barRgb}, 0)`);
    ctx.fillStyle = bar;
    ctx.fillRect(cx - barW / 2, barY, barW, 3);
  }

  if (subAlpha > 0.01) {
    ctx.font = `500 ${Math.max(13, Math.round(size * 0.28))}px ${FONT}`;
    // --greeting-sub already includes alpha; multiply via globalAlpha for fade-in.
    ctx.globalAlpha = subAlpha;
    ctx.fillStyle = themeVar("--greeting-sub", "rgba(91, 97, 112, 0.85)");
    ctx.fillText(SUBLINE, cx, cy + size * 0.95);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/** True while waiting on bake or while the one-shot intro is still running. */
export function greetingNeedsAnimation(state) {
  if (!state || state.reducedMotion || state.settled) return false;
  return !state.introStarted || state.t < INTRO_DUR;
}

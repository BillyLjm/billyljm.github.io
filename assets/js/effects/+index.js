/**
 * Landing-page canvas effects
 * ---------------------------
 * To add a new effect:
 *   1. Drop a file in assets/js/effects/my-effect.js
 *      export default { id, label, weight?, interactive?, continuous?, start, update, skip?, resize?, draw? }
 *   2. That's it — Jekyll lists every *.js basename in this folder into
 *      #effects-manifest; this module filters and dynamic-imports effects.
 *
 * Non-effect package files use a leading "+" (e.g. +index.js, +registry.js,
 * +helpers.js) and are skipped before registration. Same rule for any
 * private helper modules you add.
 *
 * Shared greeting underlay lives at assets/js/greeting.js (owned by canvas.js),
 * always painted under every effect. Do not register it as a pickable effect.
 *
 * Effect contract:
 *   start(world) -> void
 *   update(world, dt) -> boolean   // true = still running
 *   skip?(world) -> void           // reduced-motion / instant settle
 *   resize?(world) -> void         // stage size changed (e.g. separate overlaps)
 *   draw?(world, ctx) -> void      // optional underlay (after greeting, before cards)
 *
 * world: { cards, width, height, cardRadius, padding, elapsed, helpers, draggingId?, hoverId? }
 */

import { createRegistry } from "./+registry.js";
import { createHelpers } from "./+helpers.js";

const MANIFEST_ID = "effects-manifest";

/**
 * True for modules that are effects (not package/private files).
 * Convention: basenames starting with "+" are never registered.
 * @param {string} id
 */
function isEffectModuleId(id) {
  return Boolean(id) && !id.startsWith("+") && !id.includes("/") && !id.includes("\\");
}

/**
 * Read module basenames from the Jekyll-generated JSON manifest, then keep
 * only effect modules (filter lives here, not in the Liquid template).
 * @returns {string[]}
 */
function readEffectIds() {
  const el = document.getElementById(MANIFEST_ID);
  if (!el) {
    throw new Error(
      `[effects] Missing #${MANIFEST_ID}. ` +
        "Ensure the landing page emits the Jekyll static_files list for effects/."
    );
  }

  let ids;
  try {
    ids = JSON.parse(el.textContent || "[]");
  } catch (err) {
    throw new Error(`[effects] Invalid manifest JSON: ${err.message}`);
  }

  if (!Array.isArray(ids)) {
    throw new Error("[effects] Manifest must be a JSON array of module basenames");
  }

  return ids.map((id) => String(id).trim()).filter(isEffectModuleId);
}

/**
 * Dynamically import every effect module and register it.
 * Manifest may include _*.js package files; those are filtered out first.
 */
export async function loadEffects() {
  const Effects = createRegistry({ createHelpers });
  const ids = readEffectIds();

  if (!ids.length) {
    console.warn("[effects] No effect modules found after filtering the manifest");
    return Effects;
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const mod = await import(`./${id}.js`);
        const effect = mod.default;
        if (!effect) {
          throw new Error(`module has no default export`);
        }
        if (typeof effect.start !== "function" || typeof effect.update !== "function") {
          throw new Error(`default export is not an effect (need start + update)`);
        }
        if (!effect.id) effect.id = id;
        Effects.register(effect);
        return { id, ok: true };
      } catch (err) {
        console.error(`[effects] Failed to load "./${id}.js":`, err);
        return { id, ok: false, err };
      }
    })
  );

  const loaded = results.filter((r) => r.ok).map((r) => r.id);
  console.info(`[effects] loaded ${loaded.length}/${ids.length}:`, loaded.join(", "));

  return Effects;
}

export { createHelpers };
export default loadEffects;

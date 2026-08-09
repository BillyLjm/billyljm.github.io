/**
 * Effect registry: register, lookup, weighted random pick.
 * Effects are plain objects — see sibling effect modules and +index.js.
 */

const LAST_EFFECT_KEY = "canvas-last-effect-v1";

/**
 * @param {{ createHelpers: Function }} deps
 */
export function createRegistry(deps) {
  /** @type {Array<any>} */
  const registry = [];
  const { createHelpers } = deps;

  function register(effect) {
    if (!effect || typeof effect.id !== "string") {
      throw new Error("Effects.register: effect.id is required");
    }
    if (typeof effect.start !== "function" || typeof effect.update !== "function") {
      throw new Error(`Effects.register(${effect.id}): start and update are required`);
    }
    const existing = registry.findIndex((e) => e.id === effect.id);
    const entry = {
      weight: 1,
      label: effect.id,
      interactive: false,
      continuous: false,
      ...effect,
    };
    if (existing >= 0) registry[existing] = entry;
    else registry.push(entry);
    return entry;
  }

  function list() {
    return registry.map((e) => ({
      id: e.id,
      label: e.label,
      weight: e.weight,
      interactive: !!e.interactive,
      continuous: !!e.continuous,
    }));
  }

  function get(id) {
    return registry.find((e) => e.id === id) || null;
  }

  function weightedPick(pool) {
    const total = pool.reduce((sum, e) => sum + (e.weight > 0 ? e.weight : 0), 0);
    if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];
    let r = Math.random() * total;
    for (const effect of pool) {
      const w = effect.weight > 0 ? effect.weight : 0;
      r -= w;
      if (r <= 0) return effect;
    }
    return pool[pool.length - 1];
  }

  function pickRandom(options = {}) {
    if (!registry.length) return null;

    let excludeId = options.excludeId;
    if (excludeId == null) {
      try {
        excludeId = sessionStorage.getItem(LAST_EFFECT_KEY);
      } catch (_) {
        excludeId = null;
      }
    }

    let pool = registry.filter((e) => e.id !== excludeId);
    if (!pool.length) pool = registry.slice();

    const chosen = weightedPick(pool);

    try {
      sessionStorage.setItem(LAST_EFFECT_KEY, chosen.id);
    } catch (_) {
      /* ignore */
    }

    return chosen;
  }

  return {
    register,
    list,
    get,
    pickRandom,
    createHelpers,
  };
}

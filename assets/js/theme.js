(() => {
  /** Session-only override after the user toggles (not a permanent preference). */
  const SESSION_KEY = "theme-session-v1";
  const root = document.documentElement;

  /** @type {boolean} true once the user has toggled this tab session */
  let userOverrode = false;

  function systemTheme() {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function currentTheme() {
    const t = root.getAttribute("data-theme");
    return t === "dark" ? "dark" : "light";
  }

  function readSessionOverride() {
    try {
      const t = sessionStorage.getItem(SESSION_KEY);
      return t === "light" || t === "dark" ? t : null;
    } catch (_) {
      return null;
    }
  }

  function btn() {
    return document.getElementById("theme-toggle");
  }

  function hint() {
    return document.getElementById("theme-toggle-hint");
  }

  /**
   * @param {"light"|"dark"} theme
   * @param {{ persistSession?: boolean }} [opts]
   */
  function applyTheme(theme, opts = {}) {
    const persistSession = opts.persistSession !== false;
    const next = theme === "dark" ? "dark" : "light";
    root.setAttribute("data-theme", next);

    if (persistSession && userOverrode) {
      try {
        sessionStorage.setItem(SESSION_KEY, next);
      } catch (_) {
        /* ignore */
      }
    }

    syncToggle(next);
    try {
      window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: next } }));
    } catch (_) {
      /* ignore */
    }
  }

  function syncToggle(theme) {
    const el = btn();
    if (!el) return;
    const isDark = theme === "dark";
    el.setAttribute("aria-pressed", isDark ? "true" : "false");
    el.setAttribute(
      "aria-label",
      isDark ? "Switch to light theme" : "Switch to dark theme"
    );
    const h = hint();
    if (h) h.textContent = isDark ? "Currently dark" : "Currently light";
  }

  function toggleTheme() {
    userOverrode = true;
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  function onToggleClick(event) {
    // Only handle our button (also works if the click landed on an SVG child).
    const el = event.target instanceof Element ? event.target.closest("#theme-toggle") : null;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    toggleTheme();
  }

  // Resolve initial theme: session override (after a toggle) else system preference.
  const session = readSessionOverride();
  if (session) {
    userOverrode = true;
    applyTheme(session, { persistSession: false });
  } else if (!root.getAttribute("data-theme")) {
    applyTheme(systemTheme(), { persistSession: false });
  } else {
    syncToggle(currentTheme());
  }

  // Bind on document so we still work if the control is re-rendered, and so
  // clicks on icon/label children hit the handler via closest().
  document.addEventListener("click", onToggleClick);

  // Follow OS scheme until the user toggles in this tab.
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = (e) => {
      if (userOverrode) return;
      applyTheme(e.matches ? "dark" : "light", { persistSession: false });
    };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onScheme);
    else if (typeof mq.addListener === "function") mq.addListener(onScheme);
  } catch (_) {
    /* ignore */
  }

  if (!btn()) {
    console.warn("[theme] #theme-toggle not found — Appearance control inactive");
  }
})();

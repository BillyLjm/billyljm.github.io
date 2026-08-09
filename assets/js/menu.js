(() => {
  const toggle = document.getElementById("menu-toggle");
  const menu = document.getElementById("site-menu");
  const panel = document.getElementById("site-menu-panel");
  const backdrop = document.getElementById("site-menu-backdrop");
  if (!toggle || !menu) return;

  function setOpen(open) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    toggle.classList.toggle("is-open", open);
    menu.classList.toggle("is-open", open);
    document.body.classList.toggle("menu-open", open);

    if (panel) {
      panel.setAttribute("aria-hidden", open ? "false" : "true");
    }

    if (backdrop) {
      if (open) {
        backdrop.hidden = false;
        requestAnimationFrame(() => backdrop.classList.add("is-open"));
      } else {
        backdrop.classList.remove("is-open");
        const hide = () => {
          if (!menu.classList.contains("is-open")) backdrop.hidden = true;
          backdrop.removeEventListener("transitionend", hide);
        };
        backdrop.addEventListener("transitionend", hide);
        setTimeout(hide, 220);
      }
    }
  }

  function close() {
    setOpen(false);
  }

  function toggleMenu() {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    setOpen(!expanded);
  }

  // Tab rides with the drawer: ☰ when collapsed (flush left), ✕ when open (on panel's right).
  toggle.addEventListener("click", toggleMenu);
  backdrop?.addEventListener("click", close);

  // Off-screen panel is non-interactive via CSS pointer-events; hide from AT.
  if (panel) {
    panel.setAttribute("aria-hidden", "true");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      close();
      toggle.focus();
    }
  });
})();

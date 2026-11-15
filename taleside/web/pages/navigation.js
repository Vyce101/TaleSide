export function initNavigation({ display, confirmLeave, isDirty }) {
  let current = { path: location.pathname, index: 0 };
  let pendingTraversal = null;
  let confirmedIndex = null;
  let confirming = false;

  history.replaceState({ index: current.index }, "");
  history.scrollRestoration = "manual";

  function commit(path, { replace = false, afterDisplay } = {}) {
    const index = current.index + (replace ? 0 : 1);
    history[replace ? "replaceState" : "pushState"]({ index }, "", path);
    enter({ index, path }, afterDisplay);
  }

  function enter(entry, afterDisplay) {
    const previous = current.path;
    current = entry;
    display(entry.path, previous);
    afterDisplay?.();
  }

  async function navigate(path) {
    if (path === current.path || confirming) return;
    confirming = true;
    try {
      if (await confirmLeave()) commit(path);
    } finally {
      confirming = false;
    }
  }

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[href]");
    if (!link || link.origin !== location.origin || link.target) return;
    if (link.pathname !== "/" && link.pathname !== "/create" && !link.pathname.startsWith("/worlds/")) return;
    event.preventDefault();
    navigate(link.pathname);
  });

  async function confirmTraversal(entry, distance) {
    if (confirming) return;
    confirming = true;
    try {
      if (await confirmLeave()) {
        confirmedIndex = entry.index;
        history.go(distance);
      }
    } finally {
      confirming = false;
    }
  }

  window.addEventListener("popstate", event => {
    const entry = { index: event.state?.index, path: location.pathname };
    if (entry.index === current.index) {
      const traversal = pendingTraversal;
      pendingTraversal = null;
      if (traversal) confirmTraversal(traversal.entry, traversal.distance);
      return;
    }
    if (entry.index === confirmedIndex || !isDirty()) {
      confirmedIndex = null;
      enter(entry);
      return;
    }

    // Back has already moved the URL. Restore Create before asking, then replay only on confirmation.
    const distance = entry.index - current.index;
    if (pendingTraversal) return;
    pendingTraversal = { entry, distance };
    history.go(-distance);
  });

  return {
    get path() { return current.path; },
    replace(path, options) { commit(path, { ...options, replace: true }); },
  };
}

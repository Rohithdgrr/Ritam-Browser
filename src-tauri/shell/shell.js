// Ritam Browser chrome — interim shell (Rohan, Phase 2).
//
// Speaks only the typed surface in contracts/ipc.md: commands out, events
// in. Every control shows the runtime's real answer — errors land in the
// status bar with their code, and nothing is ever reported as done that the
// runtime did not do (AGENTS.md §6).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** @type {Map<number, object>} tab_id -> NavState */
const tabs = new Map();
let activeTabId = null;
/** The address waiting for the §4.3 external-protocol confirmation. */
let pendingExternal = null;

const el = (id) => document.getElementById(id);
const ui = {
  tabs: el("tabs"),
  newTab: el("new-tab"),
  back: el("back"),
  forward: el("forward"),
  reload: el("reload"),
  home: el("home"),
  form: el("omnibox-form"),
  omnibox: el("omnibox"),
  origin: el("origin-chip"),
  enginePill: el("engine-pill"),
  status: el("status"),
  verify: el("verify"),
  verifyPanel: el("verify-panel"),
  verifySummary: el("verify-summary"),
  verifyBody: el("verify-body"),
  verifyClose: el("verify-close"),
  externalDialog: el("external-dialog"),
  externalScheme: el("external-scheme"),
  externalOrigin: el("external-origin"),
  externalUrl: el("external-url"),
  externalCancel: el("external-cancel"),
  externalOpen: el("external-open"),
};

function status(text) {
  ui.status.textContent = text;
}

/** Show a typed IpcError (or anything else) verbatim in the status bar. */
function showError(err) {
  if (err && typeof err === "object" && err.code) {
    status(`${err.code}: ${err.message}${err.detail ? ` (${err.detail})` : ""}`);
  } else {
    status(String(err && err.message ? err.message : err));
  }
}

async function run(command, args, onOk) {
  try {
    const result = await invoke(command, args);
    if (onOk) onOk(result);
    return result;
  } catch (err) {
    showError(err);
    return undefined;
  }
}

/** The runtime's new-tab document — not a navigable site, so no origin. */
function isNewTabUrl(url) {
  return typeof url === "string" && url.endsWith("newtab.html");
}

// --- rendering ---------------------------------------------------------------

function renderTabs() {
  ui.tabs.textContent = "";
  // Test surface: which tab the strip considers active (gates read this).
  ui.tabs.dataset.activeId = activeTabId == null ? "" : String(activeTabId);
  for (const [id, state] of tabs) {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.dataset.tabId = String(id);
    const selected = id === activeTabId;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;

    const label = document.createElement("span");
    label.className = "tab-title";
    const title = state.title || (state.url && !isNewTabUrl(state.url) ? state.url : "New tab");
    label.textContent = state.loading ? "Loading…" : title;
    tab.appendChild(label);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close tab: ${title}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(id);
    });
    tab.appendChild(close);

    tab.addEventListener("click", () => selectTab(id));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectTab(id);
      }
    });
    ui.tabs.appendChild(tab);
  }
}

function renderActive(state) {
  if (!state) return;
  if (document.activeElement !== ui.omnibox) {
    ui.omnibox.value = state.url && !isNewTabUrl(state.url) ? state.url : "";
  }
  ui.origin.textContent = state.origin || "";
  ui.origin.hidden = !state.origin;
  ui.back.disabled = !state.can_go_back;
  ui.forward.disabled = !state.can_go_forward;
  ui.reload.setAttribute("aria-busy", state.loading ? "true" : "false");
  ui.reload.textContent = state.loading ? "■" : "⟳";
  ui.reload.setAttribute(
    "aria-label",
    state.loading ? "Stop loading (Esc)" : "Reload (Ctrl+R)",
  );
  ui.reload.title = state.loading ? "Stop — Esc" : "Reload — Ctrl+R";
  document.title = state.title ? `${state.title} — Ritam Browser` : "Ritam Browser";
}

function applyState(state) {
  if (!state || !tabs.has(state.tab_id)) return;
  tabs.set(state.tab_id, state);
  if (state.tab_id === activeTabId) renderActive(state);
  renderTabs();
}

function renderEngine(statusValue) {
  if (!statusValue) return;
  switch (statusValue.state) {
    case "ready":
      ui.enginePill.textContent = `Engine: ready ${statusValue.version || ""} @ ${statusValue.endpoint}`;
      break;
    case "starting":
      ui.enginePill.textContent = "Engine: starting…";
      break;
    default:
      ui.enginePill.textContent = `Engine: unavailable${statusValue.detail ? ` — ${statusValue.detail}` : ""}`;
  }
}

// --- actions -----------------------------------------------------------------

function activeState() {
  return activeTabId == null ? undefined : tabs.get(activeTabId);
}

/** ROT (PLAN.md item 10): the chrome's first `tab_list`/`runtime:ready`
 * read can race the runtime's `select_tab` during startup, so the stale
 * sentinel id 0 must never survive: whenever the active id is not a live
 * tab, adopt the first tab we actually know about. */
function coerceActiveTab() {
  if (activeTabId == null || !tabs.has(activeTabId)) {
    const first = tabs.keys().next();
    activeTabId = first.done ? null : first.value;
  }
}

function selectTab(id) {
  if (id === activeTabId) return;
  run("tab_select", { tab_id: id }, (state) => {
    activeTabId = id;
    tabs.set(id, state);
    renderTabs();
    renderActive(state);
  });
}

function closeTab(id) {
  run("tab_close", { tab_id: id }, () => {
    tabs.delete(id);
    if (activeTabId === id) {
      const next = tabs.keys().next();
      activeTabId = next.done ? null : next.value;
    }
    renderTabs();
    renderActive(activeState());
    status(`Closed tab ${id}`);
  });
}

function newTab(url) {
  run("tab_create", url ? { url } : {}, (state) => {
    tabs.set(state.tab_id, state);
    activeTabId = state.tab_id;
    renderTabs();
    renderActive(state);
    ui.omnibox.focus();
  });
}

function navCommand(command) {
  if (activeTabId == null) return;
  run(command, { tab_id: activeTabId }, (state) => applyState(state));
}

function showExternalDialog(outcome) {
  pendingExternal = outcome.url;
  ui.externalScheme.textContent = outcome.scheme;
  ui.externalOrigin.textContent = outcome.origin || "no origin";
  ui.externalUrl.textContent = outcome.url;
  ui.externalDialog.showModal();
}

// --- wiring ------------------------------------------------------------------

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = ui.omnibox.value.trim();
  if (!input || activeTabId == null) return;
  run("nav_submit", { tab_id: activeTabId, input }, (outcome) => {
    switch (outcome.kind) {
      case "navigated":
        applyState(outcome.state);
        status(`Loading ${outcome.url}`);
        break;
      case "search":
        applyState(outcome.state);
        ui.omnibox.value = outcome.url;
        status(`Searching for “${outcome.query}”`);
        break;
      case "external":
        showExternalDialog(outcome);
        break;
      case "rejected":
        showError(outcome.error);
        break;
      default:
        status("Unexpected nav_submit outcome");
    }
  });
});

ui.omnibox.addEventListener("focus", () => ui.omnibox.select());

ui.newTab.addEventListener("click", () => newTab());
ui.back.addEventListener("click", () => navCommand("nav_back"));
ui.forward.addEventListener("click", () => navCommand("nav_forward"));
ui.home.addEventListener("click", () => navCommand("nav_home"));
ui.reload.addEventListener("click", () => {
  const state = activeState();
  navCommand(state && state.loading ? "nav_stop" : "nav_reload");
});

ui.verify.addEventListener("click", () => {
  if (activeTabId == null) return;
  status("Verifying CLI-vs-CDP parity…");
  run("engine_verify", { tab_id: activeTabId }, (report) => {
    ui.verifyPanel.hidden = false;
    ui.verifySummary.textContent = report.identical
      ? "Identical — the Obscura CLI and the CDP path returned byte-for-byte the same value."
      : "DIFFERENT — the two paths disagree; this is a rule-3 violation.";
    ui.verifyBody.textContent = JSON.stringify(report, null, 2);
    status(report.identical ? "Rule 3: verification passed." : "Rule 3: verification FAILED.");
  });
});
ui.verifyClose.addEventListener("click", () => {
  ui.verifyPanel.hidden = true;
});

ui.externalCancel.addEventListener("click", () => {
  pendingExternal = null;
  ui.externalDialog.close();
  status("Cancelled — nothing was opened.");
});
ui.externalOpen.addEventListener("click", () => {
  ui.externalDialog.close();
  const address = pendingExternal;
  pendingExternal = null;
  if (!address) return;
  run("external_open", { url: address }, () => status(`Handed to the OS: ${address}`));
});

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && key === "t") {
    event.preventDefault();
    newTab();
  } else if (mod && key === "w") {
    event.preventDefault();
    if (activeTabId != null) closeTab(activeTabId);
  } else if (mod && key === "l") {
    event.preventDefault();
    ui.omnibox.focus();
    ui.omnibox.select();
  } else if (mod && key === "r") {
    event.preventDefault();
    navCommand("nav_reload");
  } else if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    navCommand("nav_back");
  } else if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    navCommand("nav_forward");
  } else if (event.key === "Escape") {
    // The stop control promises "Stop loading (Esc)" — so Esc really stops
    // the active tab, but only while it is loading (AGENTS.md §6).
    const state = activeState();
    if (state && state.loading && !ui.externalDialog.open) {
      event.preventDefault();
      navCommand("nav_stop");
    }
  }
});

// --- runtime events ----------------------------------------------------------

listen("runtime:ready", (event) => {
  tabs.clear();
  for (const state of event.payload.tabs) tabs.set(state.tab_id, state);
  activeTabId = event.payload.active_tab_id;
  coerceActiveTab();
  renderTabs();
  renderActive(activeState());
});
listen("nav:state", (event) => applyState(event.payload));
listen("tab:created", (event) => {
  tabs.set(event.payload.tab.tab_id, event.payload.tab);
  renderTabs();
});
listen("tab:closed", (event) => {
  tabs.delete(event.payload.tab_id);
  if (activeTabId === event.payload.tab_id) activeTabId = null;
  renderTabs();
});
listen("tab:activated", (event) => {
  activeTabId = event.payload.tab_id;
  renderTabs();
  renderActive(activeState());
});
listen("engine:status", (event) => renderEngine(event.payload));
listen("download:started", (event) => {
  const name = event.payload.filename || event.payload.url;
  status(`Downloading ${name}…`);
});
listen("download:finished", (event) => {
  if (event.payload.success) {
    status(`Downloaded to ${event.payload.path || "(unknown path)"}`);
  } else {
    status(`Download failed: ${event.payload.url}`);
  }
});

// --- start -------------------------------------------------------------------
// The chrome also re-reads state on load: events emitted during startup are
// lost on any listener that did not exist yet.
(async function init() {
  try {
    const info = await invoke("runtime_info");
    renderEngine(info.engine);
    const list = await invoke("tab_list");
    tabs.clear();
    for (const state of list.tabs) tabs.set(state.tab_id, state);
    activeTabId = list.active_tab_id;
    coerceActiveTab();
    renderTabs();
    renderActive(activeState());
    status("Ready");
  } catch (err) {
    showError(err);
  }
})();

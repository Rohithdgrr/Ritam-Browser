// Ritam Browser chrome (Govinda) — the typed surface of contracts/ipc.md
// only. Commands out, events in; every result shown is the runtime's real
// answer (AGENTS.md §6). Where a command does not exist yet, the control is
// disabled with a tooltip that names the gap — never a fake success.

"use strict";

/* ------------------------------------------------------------------ bridge */

const tauri = window.__TAURI__;

/** Invoke a contract command, normalizing failures to {code,message,detail}. */
async function cmd(name, args) {
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    throw { code: "no_runtime", message: "chrome loaded outside the app (no Tauri bridge)" };
  }
  try {
    return await tauri.core.invoke(name, args || {});
  } catch (e) {
    if (e && typeof e === "object" && e.code) throw e;
    throw { code: "command_failed", message: typeof e === "string" ? e : JSON.stringify(e) };
  }
}

function onEvent(name, handler) {
  if (tauri && tauri.event && typeof tauri.event.listen === "function") {
    tauri.event.listen(name, (ev) => handler(ev.payload));
  }
}

function errLine(e) {
  const code = (e && e.code) || "error";
  const msg = (e && e.message) || String(e);
  const detail = e && e.detail ? ` — ${e.detail}` : "";
  return `${code}: ${msg}${detail}`;
}

/* ------------------------------------------------------------------- state */

/** @type {Map<number, object>} tab_id -> NavState */
const tabs = new Map();
let activeTabId = null;
/** Pending §4.3 external-protocol confirmation. */
let pendingExternal = null;
/**
 * chrome_resize availability (docs/DESIGN_SYSTEM.md §2.1):
 * null = probing, true/false once known. Every overlay is gated on it.
 */
let overlaySpace = null;
/** Element that opened the current overlay, for focus return. */
let overlayTrigger = null;
/** Currently open overlay: "menu" | "panel" | "external" | "engine" | null. */
let overlay = null;

/**
 * Store-command availability per panel view (probed once at init, rule 6:
 * a command the runtime does not expose disables its trigger instead of
 * failing on every click). Maps view -> representative SCHEMA §6 command.
 */
const storeAvailable = { bookmarks: true, history: true, downloads: true, scratchpad: true, settings: true };
const storeProbe = {
  bookmarks: ["bookmark_list", { folder_id: null }],
  history: ["history_list", { limit: 1 }],
  downloads: ["download_list", {}],
  scratchpad: ["note_list", { limit: 1 }],
  settings: ["settings_list", {}],
};

const PANEL_HEIGHT = 460; // desired panel body height (runtime may clamp)
const $ = (id) => document.getElementById(id);
const el = {
  tabs: $("tabs"),
  newTab: $("new-tab"),
  back: $("back"),
  forward: $("forward"),
  reload: $("reload"),
  home: $("home"),
  form: $("omnibox-form"),
  omnibox: $("omnibox"),
  origin: $("origin-chip"),
  star: $("star"),
  menuBtn: $("menu-btn"),
  menu: $("menu"),
  status: $("status"),
  mode: $("mode-chip"),
  enginePill: $("engine-pill"),
  enginePillText: $("engine-pill-text"),
  panel: $("panel"),
  panelClose: $("panel-close"),
  externalDialog: $("external-dialog"),
  extScheme: $("ext-scheme"),
  extOrigin: $("ext-origin"),
  extUrl: $("ext-url"),
  extCancel: $("ext-cancel"),
  extOpen: $("ext-open"),
  engineDialog: $("engine-dialog"),
  engStatus: $("eng-status"),
  engFacts: $("eng-facts"),
  engClose: $("eng-close"),
  engVerify: $("eng-verify"),
  engVerifyStatus: $("eng-verify-status"),
  engVerifyBody: $("eng-verify-body"),
};

function status(text, isError) {
  el.status.textContent = text;
  el.status.classList.toggle("error", !!isError);
}

function showError(e) {
  status(errLine(e), true);
}

const activeState = () => (activeTabId != null ? tabs.get(activeTabId) || null : null);

/**
 * The runtime may report a not-yet-assigned active id (ROT finding #10,
 * PLAN.md): never command a tab that is not in the map — fall back to the
 * first live tab. Events (`tab.activated`) correct any transient pick.
 */
function syncActive() {
  if (activeTabId == null || !tabs.has(activeTabId)) {
    activeTabId = tabs.size ? tabs.keys().next().value : null;
  }
}

/* ------------------------------------------------------- overlay plumbing */

function setOverlayUnavailable(reason) {
  overlaySpace = false;
  const title = `${reason} (PLAN.md Request G-1)`;
  el.menuBtn.disabled = true;
  el.menuBtn.title = title;
  el.enginePill.disabled = true;
  el.enginePill.title = reason;
  document.querySelectorAll("[data-panel]").forEach((b) => {
    b.disabled = true;
    b.title = title;
  });
}

/** Only a not-found rejection means "the runtime does not expose this". */
function missingCommand(e) {
  return /not\s*-?found|unknown command|no such command|command_missing/i.test(String((e && e.message) || e));
}

/** Probe each store-backed panel once; disable triggers the runtime lacks. */
async function probeStore() {
  for (const [view, [name, args]] of Object.entries(storeProbe)) {
    try {
      await cmd(name, args);
      storeAvailable[view] = true;
    } catch (e) {
      // Command exists but errored ⇒ leave enabled: the real error
      // surfaces when the user opens the panel (honest state, not a fake one).
      storeAvailable[view] = !missingCommand(e);
    }
  }
  document.querySelectorAll("[data-panel]").forEach((b) => {
    const view = b.dataset.panel;
    if (storeAvailable[view] === false && overlaySpace !== false) {
      b.disabled = true;
      b.title = "Storage commands are not available in this runtime yet (PLAN.md Request G-2)";
    }
  });
  const state = activeState();
  if (state) renderActive(state);
}

/** Reserve strip space for an overlay. Returns true when there is room. */
async function reserveSpace(height) {
  if (overlaySpace === false) return false;
  try {
    const res = await cmd("chrome_resize", { height });
    const applied = (res && typeof res === "object" ? res.height : res) || 0;
    overlaySpace = applied > 108 || applied >= height;
    if (!overlaySpace) {
      status(`Window too small to show this (chrome_resize applied ${applied}px).`, true);
      return false;
    }
    return true;
  } catch (e) {
    setOverlayUnavailable(`This control needs the runtime's chrome_resize command`);
    status(`Cannot open this here: ${errLine(e)}`, true);
    return false;
  }
}

async function releaseSpace(height) {
  if (overlaySpace === false) return;
  try {
    await cmd("chrome_resize", { height: height || 108 });
  } catch (e) {
    setOverlayUnavailable(`This control needs the runtime's chrome_resize command`);
    status(errLine(e), true);
  }
}

/** Current overlay keeps its space; closing the last one resets the strip. */
function releaseToRemaining() {
  if (overlay === "panel" || overlay === "external" || overlay === "engine") {
    // Another overlay may still be open — recompute its height instead of 108.
    releaseSpace(108);
  }
}

async function closeOverlay(opts) {
  const options = opts || {};
  const wasPanel = overlay === "panel";
  if (overlay === "menu") {
    el.menu.hidden = true;
    el.menuBtn.setAttribute("aria-expanded", "false");
  } else if (wasPanel) {
    el.panel.hidden = true;
  } else if (overlay === "external") {
    pendingExternal = null;
    if (el.externalDialog.open) el.externalDialog.close();
  } else if (overlay === "engine") {
    if (el.engineDialog.open) el.engineDialog.close();
  }
  const trigger = overlayTrigger;
  overlay = null;
  overlayTrigger = null;
  await releaseSpace(108);
  if (!options.keepFocus && trigger && document.contains(trigger)) trigger.focus();
}

/* -------------------------------------------------------------- rendering */

function faviconNode(state) {
  if (state.loading) {
    const spin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    spin.setAttribute("class", "icon spin");
    spin.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-loader-circle");
    spin.appendChild(use);
    return spin;
  }
  if (state.favicon_url) {
    const img = document.createElement("img");
    img.className = "tab-favicon";
    img.src = state.favicon_url;
    img.alt = "";
    img.addEventListener("error", () => img.replaceWith(globeNode()), { once: true });
    return img;
  }
  return globeNode();
}

function globeNode() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon tab-favicon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-globe");
  svg.appendChild(use);
  return svg;
}

function renderTabs() {
  const focusedTab = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest(".tab")
    : null;
  const focusId = focusedTab ? focusedTab.dataset.tabId : null;
  el.tabs.textContent = "";
  for (const [id, state] of tabs) {
    const selected = id === activeTabId;
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.role = "tab";
    tab.dataset.tabId = String(id);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    tab.title = state.title || state.url || "New tab";

    tab.appendChild(faviconNode(state));

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = state.title || state.url || "New tab";
    tab.appendChild(title);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.setAttribute("aria-label", `Close tab: ${state.title || state.url || "New tab"}`);
    close.title = "Close tab — Ctrl+W";
    const x = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    x.setAttribute("class", "icon");
    x.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-x");
    x.appendChild(use);
    close.appendChild(x);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    tab.appendChild(close);

    tab.addEventListener("click", () => selectTab(id));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const ids = [...tabs.keys()];
        const i = ids.indexOf(id);
        const next = ids[(i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % tabs.length];
        selectTab(next);
        requestAnimationFrame(() => {
          const node = el.tabs.querySelector(`[data-tab-id="${next}"]`);
          if (node) node.focus();
        });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        closeTab(id);
      }
    });
    el.tabs.appendChild(tab);
  }
  if (focusId != null) {
    const node = el.tabs.querySelector(`[data-tab-id="${focusId}"]`);
    if (node) node.focus();
  }
}

function bookmarkable(url) {
  return /^(https?|file):/i.test(url || "");
}

function renderActive(state) {
  if (!state) return;
  el.back.disabled = !state.can_go_back;
  el.forward.disabled = !state.can_go_forward;

  // reload <-> stop: one button, honest label for the current state
  const use = el.reload.querySelector("use");
  if (state.loading) {
    use.setAttribute("href", "#i-square");
    el.reload.setAttribute("aria-label", "Stop loading (Esc)");
    el.reload.title = "Stop loading — Esc";
  } else {
    use.setAttribute("href", "#i-rotate-cw");
    el.reload.setAttribute("aria-label", "Reload (Ctrl+R)");
    el.reload.title = "Reload — Ctrl+R";
  }

  if (document.activeElement !== el.omnibox) el.omnibox.value = state.url || "";
  if (state.origin) {
    el.origin.hidden = false;
    el.origin.textContent = state.origin;
  } else {
    el.origin.hidden = true;
    el.origin.textContent = "";
  }

  // Star: bookmarkable + store available + known bookmark state (cache is
  // loaded on demand). Missing store commands ⇒ disabled with the gap named.
  const canBookmark = bookmarkable(state.url) && storeAvailable.bookmarks;
  el.star.disabled = !canBookmark;
  if (!storeAvailable.bookmarks) {
    el.star.title = "Bookmark storage is not available in this runtime yet (PLAN.md Request G-2)";
  } else {
    el.star.title = canBookmark ? "Bookmark this page — Ctrl+D" : "Only web addresses can be bookmarked";
  }
  const known = bookmarkState.urls.has(state.url);
  el.star.classList.toggle("bookmarked", known);
  el.star.setAttribute(
    "aria-label",
    !storeAvailable.bookmarks
      ? "Bookmarking unavailable — the runtime has no store commands yet"
      : known
        ? "Remove this bookmark"
        : canBookmark
          ? "Bookmark this page"
          : "Bookmark unavailable for this page"
  );

  // Mode switch (contract §8.1/§8.2): rendered only when the runtime
  // actually reports a mode; absence means no chip, no switch.
  if (state.content_mode) {
    const label = state.content_mode === "engine" ? "Obscura snapshot" : "Direct (Chromium)";
    const other = state.content_mode === "engine" ? "direct" : "engine";
    const otherLabel = other === "engine" ? "Obscura snapshot" : "direct (Chromium)";
    el.mode.hidden = false;
    el.mode.textContent = label;
    el.mode.title = `Content source: ${label}. Switch this tab to ${otherLabel} rendering.`;
    el.mode.setAttribute("aria-label", `Content source ${label} — switch to ${otherLabel} rendering`);
    el.mode.dataset.other = other;
  } else {
    el.mode.hidden = true;
    delete el.mode.dataset.other;
  }
}

function applyState(state) {
  tabs.set(state.tab_id, state);
  if (state.tab_id === activeTabId) renderActive(state);
  renderTabs();
}

/* ---------------------------------------------------------------- actions */

async function closeTab(id) {
  try {
    const res = await cmd("tab_close", { tab_id: id });
    tabs.delete(id);
    activeTabId = res.active_tab_id != null ? res.active_tab_id : null;
    if (activeTabId != null && !tabs.has(activeTabId)) {
      // Last-tab safety: the runtime opens a fresh tab; re-read the truth.
      try {
        const list = await cmd("tab_list");
        tabs.clear();
        (list.tabs || []).forEach((t) => tabs.set(t.tab_id, t));
        activeTabId = list.active_tab_id;
      } catch (_) {
        /* the tab.created/tab.activated events will catch us up */
      }
    }
    syncActive();
    renderTabs();
    const state = activeState();
    if (state) renderActive(state);
    status(`Closed tab ${id}`);
  } catch (e) {
    showError(e);
  }
}

async function newTab(url) {
  try {
    const state = await cmd("tab_create", url ? { url } : {});
    tabs.set(state.tab_id, state);
    activeTabId = state.tab_id;
    renderTabs();
    renderActive(state);
    el.omnibox.focus();
    status(url ? `Opened ${state.url}` : "New tab");
  } catch (e) {
    showError(e);
  }
}

async function selectTab(id) {
  if (id === activeTabId) return;
  try {
    const state = await cmd("tab_select", { tab_id: id });
    tabs.set(state.tab_id, state);
    activeTabId = state.tab_id;
    renderTabs();
    renderActive(state);
  } catch (e) {
    showError(e);
  }
}

async function navCommand(command, label) {
  if (activeTabId == null) return;
  try {
    const state = await cmd(command, { tab_id: activeTabId });
    applyState(state);
    if (label) status(label);
  } catch (e) {
    showError(e);
  }
}

async function openInActiveTab(address) {
  if (activeTabId == null) {
    await newTab(address);
    return;
  }
  try {
    const outcome = await cmd("nav_submit", { tab_id: activeTabId, input: address });
    await handleNavOutcome(outcome, address);
  } catch (e) {
    showError(e);
  }
}

async function handleNavOutcome(outcome, input) {
  switch (outcome.kind) {
    case "navigated":
      applyState(outcome.state);
      el.omnibox.value = outcome.url;
      status(`Loading ${outcome.url}`);
      break;
    case "search":
      applyState(outcome.state);
      el.omnibox.value = outcome.url;
      status(`Searching for “${outcome.query}”`);
      break;
    case "external":
      await showExternalDialog(outcome);
      break;
    case "rejected":
      showError(outcome.error);
      break;
    default:
      status(`Unexpected nav_submit outcome for “${input}”`, true);
  }
}

/* --------------------------------------------------------------- overlays */

async function openMenu(trigger) {
  if (overlaySpace === false) {
    status(`Menu unavailable: the runtime does not expose chrome_resize (PLAN.md Request G-1).`, true);
    return;
  }
  if (overlay === "menu") {
    await closeOverlay();
    return;
  }
  if (overlay) await closeOverlay({ keepFocus: true });

  el.menu.hidden = false;
  el.menu.style.visibility = "hidden";
  const needed = 84 + el.menu.offsetHeight + 8;
  const ok = await reserveSpace(needed);
  el.menu.style.visibility = "";
  if (!ok) {
    el.menu.hidden = true;
    return;
  }
  overlay = "menu";
  overlayTrigger = trigger;
  el.menuBtn.setAttribute("aria-expanded", "true");
  const first = el.menu.querySelector(".menu-item:not(:disabled)");
  if (first) first.focus();
}

async function openPanel(view, trigger) {
  if (storeAvailable[view] === false) {
    status(`Storage commands are not available in this runtime yet (PLAN.md Request G-2).`, true);
    return;
  }
  if (overlaySpace === false) {
    status(`Panels unavailable: the runtime does not expose chrome_resize (PLAN.md Request G-1).`, true);
    return;
  }
  if (overlay) await closeOverlay({ keepFocus: true });

  const ok = await reserveSpace(108 + PANEL_HEIGHT);
  if (!ok) return;
  overlay = "panel";
  overlayTrigger = trigger || el.menuBtn;
  el.panel.hidden = false;
  showView(view);
  const tab = el.panel.querySelector(`.panel-tab[data-view="${view}"]`);
  if (tab) tab.focus();
}

function showView(view) {
  currentView = view;
  document.querySelectorAll(".panel-tab").forEach((t) => {
    const on = t.dataset.view === view;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== view;
  });
  viewLoaders[view]();
}

async function showExternalDialog(outcome) {
  pendingExternal = { url: outcome.url };
  if (overlaySpace === false) {
    status(
      `Cannot ask for confirmation: the runtime does not expose chrome_resize (PLAN.md Request G-1). ` +
        `“${outcome.url}” was NOT opened.`,
      true
    );
    return;
  }
  if (overlay) await closeOverlay({ keepFocus: true });
  el.extScheme.textContent = outcome.scheme;
  el.extOrigin.textContent = outcome.origin || "no origin";
  el.extUrl.textContent = outcome.url;
  el.externalDialog.showModal();
  const needed = 108 + el.externalDialog.offsetHeight + 24;
  const ok = await reserveSpace(needed);
  if (!ok) {
    pendingExternal = null;
    el.externalDialog.close();
    return;
  }
  overlay = "external";
  overlayTrigger = el.omnibox;
  el.extCancel.focus();
}

async function openEngineDialog(trigger) {
  if (overlaySpace === false) {
    status(`Engine details unavailable: the runtime does not expose chrome_resize (PLAN.md Request G-1).`, true);
    return;
  }
  if (overlay) await closeOverlay({ keepFocus: true });
  renderEngineFacts();
  el.engineDialog.showModal();
  const needed = 108 + Math.min(el.engineDialog.offsetHeight || 360, 520) + 24;
  const ok = await reserveSpace(Math.max(needed, 480));
  if (!ok) {
    el.engineDialog.close();
    return;
  }
  overlay = "engine";
  overlayTrigger = trigger;
  el.engVerify.focus();
}

/* ------------------------------------------------------- engine status UI */

let engineStatus = null;

function renderEnginePill() {
  const s = engineStatus;
  const icon = el.enginePill.querySelector("use");
  el.enginePill.classList.remove("ready", "error");
  if (!s) {
    el.enginePillText.textContent = "engine: unknown";
    icon.setAttribute("href", "#i-circle-alert");
    return;
  }
  if (s.state === "ready") {
    el.enginePill.classList.add("ready");
    el.enginePillText.textContent = `engine: ready${s.version ? ` · ${s.version}` : ""}`;
    icon.setAttribute("href", "#i-globe");
    el.enginePill.title = s.detail || `Obscura ${s.version || ""} at ${s.endpoint || ""}`.trim();
  } else if (s.state === "starting") {
    el.enginePillText.textContent = "engine: starting…";
    icon.setAttribute("href", "#i-loader-circle");
    el.enginePill.title = s.detail || "The engine is starting.";
  } else {
    el.enginePill.classList.add("error");
    el.enginePillText.textContent = "engine: unavailable";
    icon.setAttribute("href", "#i-circle-alert");
    el.enginePill.title = s.detail || "The engine is not available.";
  }
}

function renderEngineFacts() {
  const s = engineStatus;
  if (!s) {
    el.engStatus.textContent = "The runtime has not reported an engine status yet.";
    el.engFacts.textContent = "";
    return;
  }
  el.engStatus.textContent =
    s.state === "ready"
      ? "Obscura is running and verified against the pinned binary."
      : s.state === "starting"
        ? "Obscura is starting."
        : `Obscura is unavailable: ${s.detail || "no reason reported"}`;
  el.engFacts.textContent = "";
  const rows = [
    ["State", s.state],
    ["Version", s.version || "—"],
    ["Endpoint", s.endpoint || "—"],
    ["PID", s.pid != null ? String(s.pid) : "—"],
    ["Detail", s.detail || "—"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dd.className = v.length > 40 ? "break" : "";
    el.engFacts.append(dt, dd);
  }
}

/* -------------------------------------------------------------- bookmarks */

const bookmarkState = { urls: new Map(), loaded: false };

async function refreshBookmarks() {
  const list = await cmd("bookmark_list", { folder_id: null });
  bookmarkState.urls = new Map(list.map((b) => [b.url, b.id]));
  bookmarkState.loaded = true;
  return list;
}

async function toggleBookmark() {
  if (!storeAvailable.bookmarks) {
    status(`Storage commands are not available in this runtime yet (PLAN.md Request G-2).`, true);
    return;
  }
  const state = activeState();
  if (!state || !bookmarkable(state.url)) return;
  try {
    const list = await refreshBookmarks();
    const hit = list.find((b) => b.url === state.url);
    if (hit) {
      await cmd("bookmark_delete", { id: hit.id });
      status(`Removed bookmark: ${hit.title || hit.url}`);
    } else {
      await cmd("bookmark_add", { url: state.url, title: state.title || state.url, folder_id: null });
      status(`Bookmarked: ${state.title || state.url}`);
    }
    renderActive(activeState());
    if (overlay === "panel" && currentView === "bookmarks") await loadBookmarks();
  } catch (e) {
    showError(e);
  }
}

const panelError = (id, e, where) => {
  const node = $(id);
  node.hidden = !e;
  node.textContent = e ? `${where}: ${errLine(e)}` : "";
};

async function loadBookmarks() {
  ["bm-loading", "bm-empty"].forEach((id) => ($(id).hidden = true));
  panelError("bm-error", null);
  $("bm-loading").hidden = false;
  try {
    const folder = $("bm-folder").value || null;
    const list = await cmd("bookmark_list", { folder_id: folder ? Number(folder) : null });
    await loadFolders(true);
    bookmarkState.urls = new Map(list.map((b) => [b.url, b.id]));
    bookmarkState.loaded = true;
    const query = $("bm-search").value.trim().toLowerCase();
    const shown = query
      ? list.filter((b) => (b.title || "").toLowerCase().includes(query) || b.url.toLowerCase().includes(query))
      : list;
    renderRows("bm-list", shown, (b) => ({
      title: b.title || b.url,
      meta: b.url,
      onOpen: () => openInActiveTab(b.url),
      onDelete: async () => {
        await cmd("bookmark_delete", { id: b.id });
        status(`Deleted bookmark: ${b.title || b.url}`);
        await loadBookmarks();
      },
      deleteLabel: `Delete bookmark: ${b.title || b.url}`,
    }));
    $("bm-empty").hidden = shown.length !== 0;
    if (shown.length === 0 && query) $("bm-empty").textContent = `No bookmarks match “${query}”.`;
    else $("bm-empty").textContent = "No bookmarks yet. Press the star in the toolbar to save the current page.";
  } catch (e) {
    panelError("bm-error", e, "Bookmarks");
    $("bm-list").textContent = "";
  } finally {
    $("bm-loading").hidden = true;
  }
}

async function loadFolders(silent) {
  try {
    const folders = await cmd("folder_list");
    const select = $("bm-folder");
    const current = select.value;
    select.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All folders";
    select.appendChild(all);
    folders.forEach((f) => {
      const o = document.createElement("option");
      o.value = String(f.id);
      o.textContent = f.name;
      select.appendChild(o);
    });
    select.value = current;
  } catch (e) {
    if (!silent) panelError("bm-error", e, "Folders");
  }
}

/* ---------------------------------------------------------------- history */

async function loadHistory() {
  ["hs-loading", "hs-empty"].forEach((id) => ($(id).hidden = true));
  panelError("hs-error", null);
  $("hs-loading").hidden = false;
  $("hs-count").textContent = "";
  try {
    const query = $("hs-search").value.trim();
    const list = query
      ? await cmd("history_search", { query, limit: 200 })
      : await cmd("history_list", { limit: 200 });
    if (!query) {
      try {
        const count = await cmd("history_count");
        const n = typeof count === "object" ? count.count : count;
        $("hs-count").textContent = `${n} visit${n === 1 ? "" : "s"} recorded`;
      } catch (_) {
        $("hs-count").textContent = "";
      }
    } else {
      $("hs-count").textContent = `${list.length} match${list.length === 1 ? "" : "es"}`;
    }
    renderRows("hs-list", list, (h) => ({
      title: h.title || h.url,
      meta: `${new Date(h.visited_at_ms).toLocaleString()} · ${h.host || h.url}`,
      onOpen: () => openInActiveTab(h.url),
      onDelete: async () => {
        await cmd("history_delete", { id: h.id });
        status("Deleted history entry");
        await loadHistory();
      },
      deleteLabel: `Delete history entry: ${h.title || h.url}`,
    }));
    $("hs-empty").hidden = list.length !== 0;
  } catch (e) {
    panelError("hs-error", e, "History");
    $("hs-list").textContent = "";
  } finally {
    $("hs-loading").hidden = true;
  }
}

/* -------------------------------------------------------------- downloads */

function fmtBytes(n, total) {
  const units = ["B", "KB", "MB", "GB"];
  let v = n || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const head = `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  if (total && total !== n) {
    let t = total;
    let j = 0;
    while (t >= 1024 && j < units.length - 1) {
      t /= 1024;
      j += 1;
    }
    return `${head} of ${Math.round(t)} ${units[j]}`;
  }
  return head;
}

async function loadDownloads() {
  ["dl-loading", "dl-empty"].forEach((id) => ($(id).hidden = true));
  panelError("dl-error", null);
  $("dl-loading").hidden = false;
  try {
    const list = await cmd("download_list");
    renderRows("dl-list", list, (d) => ({
      title: d.filename || d.url,
      meta: `${d.state} · ${fmtBytes(d.bytes_received, d.bytes_total)}${
        d.save_path ? ` · ${d.save_path}` : ""
      }${d.error ? ` · ${d.error}` : ""}`,
      metaBreak: true,
      badge: d.state,
      onOpen: null,
      extra: (row) => {
        const copy = iconAction("i-file-text", `Copy the save path of ${d.filename}`, "Copy path");
        copy.addEventListener("click", async () => {
          if (!d.save_path) {
            status("No save path was reported for this download.", true);
            return;
          }
          try {
            await navigator.clipboard.writeText(d.save_path);
            status(`Copied: ${d.save_path}`);
          } catch (e) {
            status(`Clipboard unavailable: ${errLine(e)}`, true);
          }
        });
        if (!d.save_path) copy.disabled = true;
        row.appendChild(copy);
      },
      onDelete: async () => {
        await cmd("download_delete", { id: d.id });
        status(`Removed download record: ${d.filename}`);
        await loadDownloads();
      },
      deleteLabel: `Remove download record: ${d.filename}`,
    }));
    $("dl-empty").hidden = list.length !== 0;
  } catch (e) {
    panelError("dl-error", e, "Downloads");
    $("dl-list").textContent = "";
  } finally {
    $("dl-loading").hidden = true;
  }
}

/* -------------------------------------------------------------- scratchpad */

let noteRevision = null;
let noteId = null;

async function loadNotes(selectId) {
  ["sc-loading", "sc-empty"].forEach((id) => ($(id).hidden = true));
  panelError("sc-error", null);
  $("sc-loading").hidden = false;
  try {
    const notes = await cmd("note_list", { limit: 100 });
    renderRows("sc-list", notes, (n) => ({
      title: n.title || "Untitled note",
      meta: `updated ${new Date(n.updated_at_ms).toLocaleString()}`,
      active: n.id === noteId,
      onOpen: () => openNote(n),
      onDelete: async () => {
        await cmd("note_delete", { id: n.id });
        if (noteId === n.id) closeEditor();
        status(`Deleted note: ${n.title || "Untitled note"}`);
        await loadNotes();
      },
      deleteLabel: `Delete note: ${n.title || "Untitled note"}`,
    }));
    $("sc-empty").hidden = notes.length !== 0;
    if (selectId) {
      const n = notes.find((x) => x.id === selectId);
      if (n) openNote(n);
    }
  } catch (e) {
    panelError("sc-error", e, "Scratchpad");
    $("sc-list").textContent = "";
  } finally {
    $("sc-loading").hidden = true;
  }
}

function openNote(n) {
  noteId = n.id;
  noteRevision = n.revision;
  $("sc-none").hidden = true;
  $("sc-editor").hidden = false;
  $("sc-title").value = n.title;
  $("sc-body").value = n.body;
  $("sc-rev").textContent = `revision ${n.revision} · saved ${new Date(n.updated_at_ms).toLocaleString()}`;
  panelError("sc-editor-error", null);
  document.querySelectorAll("#sc-list .row").forEach((row) => {
    row.classList.toggle("active", Number(row.dataset.id) === n.id);
  });
}

function closeEditor() {
  noteId = null;
  noteRevision = null;
  $("sc-editor").hidden = true;
  $("sc-none").hidden = false;
}

async function saveNote() {
  if (noteId == null) return;
  panelError("sc-editor-error", null);
  try {
    const updated = await cmd("note_update", {
      id: noteId,
      title: $("sc-title").value,
      body: $("sc-body").value,
      expected_revision: noteRevision,
    });
    noteRevision = updated.revision;
    $("sc-rev").textContent = `revision ${updated.revision} · saved ${new Date(updated.updated_at_ms).toLocaleString()}`;
    status("Note saved");
    await loadNotes();
  } catch (e) {
    panelError("sc-editor-error", e, "Save failed");
    if ((e.code || "").includes("conflict") || (e.message || "").includes("revision")) {
      try {
        const fresh = await cmd("note_get", { id: noteId });
        status("The note changed elsewhere — showing the saved version.", true);
        openNote(fresh);
      } catch (_) {
        /* the inline error already tells the truth */
      }
    }
  }
}

/* ---------------------------------------------------------------- settings */

const settingControls = {
  history_enabled: { input: () => $("st-history"), type: "bool", hint: () => $("st-history-hint") },
  home_page: { input: () => $("st-home"), type: "string", hint: () => $("st-home-hint") },
  search_engine: { input: () => $("st-engine"), type: "string", hint: () => $("st-engine-hint") },
  zoom_percent: { input: () => $("st-zoom"), type: "number", hint: () => $("st-zoom-hint") },
  theme: { input: () => $("st-theme"), type: "string", hint: () => $("st-theme-hint") },
  restore_session: { input: () => $("st-restore"), type: "bool", hint: () => $("st-restore-hint") },
};

async function loadSettings() {
  panelError("st-error", null);
  $("st-save-status").textContent = "";
  try {
    const values = await cmd("settings_list");
    const map = new Map(values.map((v) => [v.key, v.value]));
    for (const [key, spec] of Object.entries(settingControls)) {
      if (!map.has(key)) continue;
      const input = spec.input();
      const value = map.get(key);
      if (spec.type === "bool") input.checked = !!value;
      else if (spec.type === "number") input.value = String(value);
      else input.value = String(value);
      spec.hint().textContent = `saved value: ${value}`;
    }
  } catch (e) {
    panelError("st-error", e, "Settings");
  }
}

async function saveSetting(key, value) {
  const spec = settingControls[key];
  try {
    await cmd("settings_set", { key, value });
    $("st-save-status").textContent = `Saved ${key} = ${value}`;
    if (spec) spec.hint().textContent = `saved value: ${value}`;
  } catch (e) {
    panelError("st-error", e, "Settings");
    $("st-save-status").textContent = `Not saved: ${key}`;
    await loadSettings(); // show the truth that is actually stored
  }
}

async function clearBrowsingData() {
  const range = $("cl-range").value;
  const wantHistory = $("cl-history").checked;
  const wantDownloads = $("cl-downloads").checked;
  const wantSession = $("cl-session").checked;
  const errorNode = $("cl-error");
  errorNode.hidden = true;
  $("cl-result").textContent = "";
  if (!wantHistory && !wantDownloads && !wantSession) {
    errorNode.hidden = false;
    errorNode.textContent = "Select at least one kind of data to remove.";
    return;
  }
  const now = Date.now();
  const history = wantHistory
    ? range === "all"
      ? { from_ms: 0, to_ms: now }
      : { from_ms: now - Number(range), to_ms: now }
    : null;
  try {
    const report = await cmd("clear_browsing_data", {
      scope: { history, downloads: wantDownloads, session: wantSession },
    });
    $("cl-result").textContent =
      `Removed ${report.history_deleted} history entr${report.history_deleted === 1 ? "y" : "ies"}, ` +
      `${report.downloads_deleted} download record${report.downloads_deleted === 1 ? "" : "s"}, ` +
      `session ${report.session_cleared ? "cleared" : "kept"}.`;
    status("Cleared browsing data");
  } catch (e) {
    errorNode.hidden = false;
    errorNode.textContent = errLine(e);
  }
}

async function runIntegrityCheck() {
  $("ig-result").textContent = "Running…";
  $("ig-error").hidden = true;
  try {
    const r = await cmd("integrity_check");
    const malformed = (r.malformed_rows || []).map((m) => `${m.table}: ${m.count}`).join(", ") || "none";
    $("ig-result").textContent =
      `${r.ok ? "OK" : "PROBLEMS"} · schema v${r.schema_version} · foreign-key violations: ` +
      `${r.foreign_key_violations} · malformed rows: ${malformed} · integrity: ${r.integrity_check}`;
  } catch (e) {
    $("ig-result").textContent = "";
    $("ig-error").hidden = false;
    $("ig-error").textContent = errLine(e);
  }
}

/* ------------------------------------------------------------------- rows */

function iconAction(iconId, label, title) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = title || label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${iconId}`);
  svg.appendChild(use);
  b.appendChild(svg);
  return b;
}

function renderRows(listId, items, spec) {
  const list = $(listId);
  list.textContent = "";
  for (const item of items) {
    const s = spec(item);
    const li = document.createElement("li");
    li.className = "row" + (s.active ? " active" : "");
    if (item.id != null) li.dataset.id = String(item.id);

    if (s.onOpen) {
      const main = document.createElement("button");
      main.className = "row-main";
      main.type = "button";
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = s.title;
      const meta = document.createElement("span");
      meta.className = "row-meta" + (s.metaBreak ? " break" : "");
      meta.textContent = s.meta || "";
      main.append(title, meta);
      main.addEventListener("click", s.onOpen);
      li.appendChild(main);
    } else {
      const main = document.createElement("div");
      main.className = "row-static";
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = s.title;
      const meta = document.createElement("span");
      meta.className = "row-meta" + (s.metaBreak ? " break" : "");
      meta.textContent = s.meta || "";
      main.append(title, meta);
      li.appendChild(main);
    }

    if (s.badge) {
      const badge = document.createElement("span");
      badge.className = `row-badge ${/fail|error/i.test(s.badge) ? "failed" : /complete/i.test(s.badge) ? "completed" : ""}`;
      badge.textContent = s.badge;
      li.appendChild(badge);
    }
    if (s.extra) s.extra(li);

    if (s.onDelete) {
      const del = iconAction("i-trash-2", s.deleteLabel, "Delete");
      del.addEventListener("click", async () => {
        try {
          await s.onDelete();
        } catch (e) {
          showError(e);
        }
      });
      li.appendChild(del);
    }
    list.appendChild(li);
  }
}

/* ------------------------------------------------------------- view loaders */

let currentView = "bookmarks";

const viewLoaders = {
  bookmarks: loadBookmarks,
  history: loadHistory,
  downloads: loadDownloads,
  scratchpad: loadNotes,
  settings: loadSettings,
};

/* ------------------------------------------------------------------- wiring */

function wireToolbar() {
  el.back.addEventListener("click", () => navCommand("nav_back"));
  el.forward.addEventListener("click", () => navCommand("nav_forward"));
  el.home.addEventListener("click", () => navCommand("nav_home", "Home"));
  el.reload.addEventListener("click", () => {
    const state = activeState();
    navCommand(state && state.loading ? "nav_stop" : "nav_reload");
  });
  el.newTab.addEventListener("click", () => newTab());
  el.star.addEventListener("click", toggleBookmark);

  el.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = el.omnibox.value.trim();
    if (!input || activeTabId == null) return;
    try {
      const outcome = await cmd("nav_submit", { tab_id: activeTabId, input });
      await handleNavOutcome(outcome, input);
      // after the real outcome, show the URL that is actually loading
      const state = activeState();
      if (state) el.omnibox.value = state.url;
    } catch (e) {
      showError(e);
    }
  });
  el.omnibox.addEventListener("focus", () => el.omnibox.select());
}

function wireMenuAndPanel() {
  el.menuBtn.addEventListener("click", () => openMenu(el.menuBtn));
  el.menu.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item || item.disabled) return;
    if (item.dataset.panel) {
      const view = item.dataset.panel;
      closeOverlay({ keepFocus: true }).then(() => openPanel(view, el.menuBtn));
    } else if (item.dataset.action === "verify") {
      closeOverlay({ keepFocus: true }).then(() => openEngineDialog(el.menuBtn));
    }
  });

  document.querySelectorAll(".panel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      currentView = tab.dataset.view;
      showView(currentView);
    });
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const tabs = [...document.querySelectorAll(".panel-tab")];
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next.click();
      next.focus();
    });
  });
  el.panelClose.addEventListener("click", () => closeOverlay());
  el.enginePill.addEventListener("click", () => openEngineDialog(el.enginePill));
  // Mode switch (contract §8.2): flip the tab's content source.
  el.mode.addEventListener("click", async () => {
    const mode = el.mode.dataset.other;
    if (!mode || activeTabId == null) return;
    try {
      const state = await cmd("tab_set_mode", { tab_id: activeTabId, mode });
      applyState(state);
      status(
        `Content source switched to ${state.content_mode === "engine" ? "Obscura snapshot" : "direct (Chromium)"}`
      );
    } catch (e) {
      showError(e);
    }
  });

  // Clicking the strip outside the menu closes it (standard menu behavior).
  document.addEventListener("mousedown", (e) => {
    if (overlay !== "menu") return;
    if (el.menu.contains(e.target) || el.menuBtn.contains(e.target)) return;
    closeOverlay();
  });
}

function wireDialogs() {
  el.extCancel.addEventListener("click", () => {
    status("Cancelled — nothing was opened.");
    closeOverlay();
  });
  el.extOpen.addEventListener("click", async () => {
    const address = pendingExternal && pendingExternal.url;
    if (!address) return;
    try {
      await cmd("external_open", { url: address });
      status(`Handed to the OS: ${address}`);
    } catch (e) {
      showError(e);
    }
    closeOverlay();
  });
  el.externalDialog.addEventListener("cancel", (e) => {
    if (overlay !== "external") return; // failed to reserve space: let it close
    e.preventDefault();
    status("Cancelled — nothing was opened.");
    closeOverlay();
  });
  el.engineDialog.addEventListener("cancel", (e) => {
    if (overlay !== "engine") return;
    e.preventDefault();
    closeOverlay();
  });
  el.engClose.addEventListener("click", () => closeOverlay());

  el.engVerify.addEventListener("click", async () => {
    if (activeTabId == null) {
      el.engVerifyStatus.textContent = "No active tab to verify against.";
      return;
    }
    el.engVerifyStatus.textContent = "Verifying CLI-vs-CDP parity…";
    el.engVerifyBody.hidden = true;
    try {
      const report = await cmd("engine_verify", { tab_id: activeTabId });
      el.engVerifyStatus.textContent = report.identical
        ? "Identical — the Obscura CLI and the CDP path returned byte-for-byte the same value."
        : "DIFFERENT — the two paths disagree; this is a rule-3 violation.";
      el.engVerifyBody.textContent = JSON.stringify(report, null, 2);
      el.engVerifyBody.hidden = false;
      status(report.identical ? "Rule 3: verification passed." : "Rule 3: verification FAILED.", !report.identical);
    } catch (e) {
      el.engVerifyStatus.textContent = errLine(e);
      status(errLine(e), true);
    }
  });
}

function wirePanel() {
  $("bm-refresh").addEventListener("click", loadBookmarks);
  $("bm-search").addEventListener("input", debounce(loadBookmarks, 250));
  $("bm-folder").addEventListener("change", loadBookmarks);
  $("hs-refresh").addEventListener("click", loadHistory);
  $("hs-search").addEventListener("input", debounce(loadHistory, 250));
  $("dl-refresh").addEventListener("click", loadDownloads);
  $("dl-clear").addEventListener("click", async () => {
    try {
      const removed = await cmd("downloads_clear_completed");
      const n = typeof removed === "object" ? removed.removed : removed;
      status(`Removed ${n} completed download record${n === 1 ? "" : "s"}`);
      await loadDownloads();
    } catch (e) {
      panelError("dl-error", e, "Clear completed");
    }
  });
  $("sc-refresh").addEventListener("click", () => loadNotes());
  $("sc-new").addEventListener("click", async () => {
    try {
      const note = await cmd("note_create", { title: "Untitled note", body: "" });
      status("Created a note");
      await loadNotes(note.id);
    } catch (e) {
      panelError("sc-error", e, "New note");
    }
  });
  $("sc-editor").addEventListener("submit", (e) => {
    e.preventDefault();
    saveNote();
  });
  $("sc-delete").addEventListener("click", async () => {
    if (noteId == null) return;
    try {
      await cmd("note_delete", { id: noteId });
      status("Deleted note");
      closeEditor();
      await loadNotes();
    } catch (e) {
      panelError("sc-editor-error", e, "Delete failed");
    }
  });

  // Settings: save on change (each control is its own honest commit).
  $("st-history").addEventListener("change", (e) => saveSetting("history_enabled", e.target.checked));
  $("st-home").addEventListener("change", (e) => saveSetting("home_page", e.target.value.trim()));
  $("st-engine").addEventListener("change", (e) => saveSetting("search_engine", e.target.value));
  $("st-zoom").addEventListener("change", (e) => saveSetting("zoom_percent", Number(e.target.value)));
  $("st-theme").addEventListener("change", (e) => saveSetting("theme", e.target.value));
  $("st-restore").addEventListener("change", (e) => saveSetting("restore_session", e.target.checked));
  $("cl-run").addEventListener("click", clearBrowsingData);
  $("ig-run").addEventListener("click", runIntegrityCheck);
}

function wireShortcuts() {
  document.addEventListener("keydown", async (e) => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === "Escape") {
      if (overlay) {
        e.preventDefault();
        await closeOverlay();
      } else if (activeState() && activeState().loading) {
        navCommand("nav_stop");
      }
      return;
    }
    if (!ctrl || e.altKey) return;
    const key = e.key.toLowerCase();

    // Windows Ctrl conventions — only these keys are consumed here, so text
    // editing shortcuts (Ctrl+C/V/X/Z, word jumps) stay untouched.
    let action = null;
    if (key === "t") action = () => newTab();
    else if (key === "w") action = () => activeTabId != null && closeTab(activeTabId);
    else if (key === "l") action = () => (el.omnibox.focus(), el.omnibox.select());
    else if (key === "r") action = () => navCommand("nav_reload");
    else if (key === "d") action = () => toggleBookmark();
    else if (key === "h") action = () => openPanel("history", el.menuBtn);
    else if (key === "j") action = () => openPanel("downloads", el.menuBtn);
    else if (key === "o" && e.shiftKey) action = () => openPanel("bookmarks", el.menuBtn);
    else if (key === "p" && e.shiftKey) action = () => openPanel("scratchpad", el.menuBtn);
    else if (e.key === ",") action = () => openPanel("settings", el.menuBtn);
    else if (/^[1-8]$/.test(key)) {
      const id = [...tabs.keys()][Number(key) - 1];
      if (id != null) action = () => selectTab(id);
    } else if (key === "9") {
      const ids = [...tabs.keys()];
      if (ids.length) action = () => selectTab(ids[ids.length - 1]);
    }

    if (!action) return;
    e.preventDefault();
    await action();
  });

  // Alt+arrows / Alt+Home are the Windows convention.
  document.addEventListener("keydown", async (e) => {
    if (!e.altKey || e.ctrlKey) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      await navCommand("nav_back");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      await navCommand("nav_forward");
    } else if (e.key === "Home") {
      e.preventDefault();
      await navCommand("nav_home", "Home");
    }
  });
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ events */

function wireEvents() {
  onEvent("runtime.ready", (payload) => {
    tabs.clear();
    (payload.tabs || []).forEach((t) => tabs.set(t.tab_id, t));
    activeTabId = payload.active_tab_id;
    syncActive();
    renderTabs();
    const state = activeState();
    if (state) renderActive(state);
    status("Ready");
  });
  onEvent("nav.state", (state) => applyState(state));
  onEvent("nav.error", (payload) => {
    // Contract §8.3: a navigation that was accepted but could not complete.
    // Shown verbatim — the UI never hides or softens the runtime's own text.
    const line = errLine(payload.error);
    status(payload.tab_id === activeTabId ? line : `Tab ${payload.tab_id}: ${line}`, true);
  });
  onEvent("tab.created", (payload) => {
    tabs.set(payload.tab.tab_id, payload.tab);
    renderTabs();
  });
  onEvent("tab.activated", (payload) => {
    activeTabId = payload.tab_id;
    renderTabs();
    const state = activeState();
    if (state) renderActive(state);
  });
  onEvent("tab.closed", (payload) => {
    tabs.delete(payload.tab_id);
    if (activeTabId === payload.tab_id) activeTabId = null;
    syncActive();
    renderTabs();
  });
  onEvent("engine.status", (payload) => {
    engineStatus = payload;
    renderEnginePill();
  });
  onEvent("download.started", (payload) => {
    status(`Download started: ${payload.filename || payload.url}`);
    if (overlay === "panel" && currentView === "downloads") loadDownloads();
  });
  onEvent("download.finished", (payload) => {
    if (payload.success) status(`Download saved: ${payload.path || payload.url}`);
    else status(`Download failed: ${payload.url}`, true);
    if (overlay === "panel" && currentView === "downloads") loadDownloads();
  });
}

/* -------------------------------------------------------------------- init */

async function init() {
  wireToolbar();
  wireMenuAndPanel();
  wireDialogs();
  wirePanel();
  wireShortcuts();
  wireEvents();

  // Probe the overlay surface once (docs/DESIGN_SYSTEM.md §2.1).
  try {
    const res = await cmd("chrome_resize", { height: 108 });
    const applied = (res && typeof res === "object" ? res.height : res) || 0;
    overlaySpace = applied >= 108;
    if (!overlaySpace) setOverlayUnavailable("The runtime's chrome_resize clamps below the strip height");
  } catch (e) {
    setOverlayUnavailable("The runtime does not expose chrome_resize");
  }

  try {
    const list = await cmd("tab_list");
    tabs.clear();
    (list.tabs || []).forEach((t) => tabs.set(t.tab_id, t));
    activeTabId = list.active_tab_id;
    syncActive();
    renderTabs();
    const state = activeState();
    if (state) renderActive(state);
  } catch (e) {
    showError(e);
    renderTabs();
  }

  try {
    engineStatus = await cmd("engine_status");
    renderEnginePill();
  } catch (e) {
    renderEnginePill();
    showError(e);
  }

  // Disable any store-backed trigger the runtime does not expose yet.
  await probeStore();
}

init();

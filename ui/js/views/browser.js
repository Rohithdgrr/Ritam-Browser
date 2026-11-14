/**
 * Web-content view.
 * - Tauri: pages render in a native window positioned over this region
 *   (see src-tauri/src/webview.rs). Nothing is drawn here.
 * - Plain browser preview: an <iframe> is used. Sites that forbid framing
 *   (X-Frame-Options / frame-ancestors) will not render; a persistent
 *   banner offers "Open in system browser".
 */

import { $, $$ } from '../lib/dom.js';
import { isNative, openExternal } from '../services/ipc.js';
import { store } from '../state/store.js';

let iframe = null;
const iframeUrls = new Map(); // tabId → url loaded (per-tab iframes kept alive? kept simple: single iframe re-targeted)

export function renderWebView() {
  const view = $('#view-web');
  const host = $('#web-host');
  const tab = store.activeTab();
  if (!view || !tab) return;

  // Remove any stale banner from a previous render
  $$('.web-banner', view).forEach((b) => b.remove());

  if (isNative()) {
    host.innerHTML = '';
    iframe = null;
    return;
  }

  iframe = host.querySelector('iframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.setAttribute('title', 'Web content');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    host.appendChild(iframe);
  }
  if (iframe.src !== tab.url) {
    iframe.src = tab.url;
  }

  // Persistent, dismissable preview banner (honest about iframe limits)
  const banner = document.createElement('div');
  banner.className = 'web-banner';
  banner.innerHTML = `
    <span>Preview mode — some sites refuse to load in a frame.</span>
    <button type="button">Open in system browser ↗</button>
    <button type="button" class="banner-close" aria-label="Dismiss">✕</button>`;
  banner.querySelector('button:not(.banner-close)').addEventListener('click', () => openExternal(tab.url));
  banner.querySelector('.banner-close').addEventListener('click', () => banner.remove());
  view.appendChild(banner);
}

export function reloadWebView() {
  if (isNative()) return; // handled natively via eval
  if (iframe) {
    const src = iframe.src;
    iframe.src = 'about:blank';
    requestAnimationFrame(() => { iframe.src = src; });
  }
}

export function historyWebView(direction) {
  if (isNative()) return;
  try {
    const w = iframe?.contentWindow;
    if (!w) return;
    if (direction === 'back') w.history.back();
    else w.history.forward();
  } catch {
    /* cross-origin — silently ignore */
  }
}

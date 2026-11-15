/**
 * Local browser profiles.
 *
 * A profile is a local identity with its own workspaces and tabs. Ritam never
 * signs in to an account service: the email is a label, exactly like an
 * un-signed-in Chrome profile. Bookmarks and history are shared for now.
 */

import { $, escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';

let profiles = [];
let activeId = null;

const letter = (name) => (String(name ?? '?').trim()[0] ?? '?').toUpperCase();

export function activeProfile() {
  return profiles.find((profile) => profile.id === activeId) ?? null;
}

function renderChip() {
  const chip = $('#profile-avatar');
  const profile = activeProfile();
  if (!chip) return;
  chip.textContent = letter(profile?.name);
  chip.style.background = profile?.color ?? 'var(--zen-sage)';
  const button = $('#btn-profile');
  if (button) {
    button.title = profile ? `${profile.name}${profile.email ? ` — ${profile.email}` : ''}` : 'Profiles';
  }
}

function profileRow(profile, { current = false } = {}) {
  return `
    <button class="profile-row ${current ? 'current' : ''}" data-profile-id="${escapeHtml(profile.id)}" ${current ? 'disabled' : ''}>
      <span class="profile-avatar sm" style="background:${escapeHtml(profile.color)}">${escapeHtml(letter(profile.name))}</span>
      <span class="profile-row-text">
        <span class="profile-row-name">${escapeHtml(profile.name)}</span>
        ${profile.email ? `<span class="profile-row-email">${escapeHtml(profile.email)}</span>` : '<span class="profile-row-email">Local profile</span>'}
      </span>
      ${current ? '<span class="profile-current">Current</span>' : ''}
    </button>`;
}

function renderPopover() {
  const body = $('#profile-popover-body');
  if (!body) return;
  const profile = activeProfile();
  const others = profiles.filter((item) => item.id !== activeId);
  body.innerHTML = `
    <div class="profile-card" ${profile ? `style="--profile-color:${escapeHtml(profile.color)}"` : ''}>
      <span class="profile-avatar lg">${escapeHtml(letter(profile?.name))}</span>
      <strong>${escapeHtml(profile?.name ?? 'Profile')}</strong>
      <span class="profile-email">${escapeHtml(profile?.email || 'Local profile — no account connected')}</span>
    </div>
    <div class="profile-actions">
      <button class="profile-action" id="profile-add-toggle">
        <svg class="icon sm" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Add profile
      </button>
      ${profiles.length > 1 && profile ? `
        <button class="profile-action" id="profile-delete" data-profile-id="${escapeHtml(profile.id)}">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          Delete this profile
        </button>` : ''}
    </div>
    <form class="profile-form hidden" id="profile-form">
      <label>Name<input id="profile-name-input" maxlength="80" placeholder="Work, Personal, …" autocomplete="off"/></label>
      <label>Gmail address <span class="profile-optional">(optional, shown only on this device)</span>
        <input id="profile-email-input" type="email" maxlength="254" placeholder="you@gmail.com" autocomplete="off" spellcheck="false"/>
      </label>
      <div class="profile-form-actions">
        <button type="button" class="btn-secondary" id="profile-form-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Create profile</button>
      </div>
    </form>
    ${others.length ? `
      <div class="profile-list-label">Other profiles</div>
      <div class="profile-list">${others.map((item) => profileRow(item)).join('')}</div>` : '<p class="profile-empty">No other profiles yet.</p>'}
  `;
}

export function toggleProfilePopover(force) {
  const popover = $('#profile-popover');
  if (!popover) return;
  const open = force ?? popover.classList.contains('hidden');
  popover.classList.toggle('hidden', !open);
  $('#quick-popover')?.classList.add('hidden');
  if (open) renderPopover();
}

export async function refreshProfiles() {
  const data = await api.listProfiles().catch(() => null);
  profiles = data?.profiles ?? [];
  activeId = data?.active_profile_id ?? profiles[0]?.id ?? null;
  renderChip();
  return { profiles, activeId };
}

async function switchProfile(profileId) {
  if (!profileId || profileId === activeId) return;
  await api.setActiveProfile(profileId);
  // Workspaces, tabs and native webviews are rebuilt from the new profile.
  location.reload();
}

async function createProfile(form) {
  const name = $('#profile-name-input')?.value.trim() ?? '';
  const email = $('#profile-email-input')?.value.trim() ?? '';
  if (!name) { toast('Give the profile a name.'); return; }
  try {
    await api.createProfile(name, email || null, null);
    await refreshProfiles();
    renderPopover();
    toast(`Profile “${name}” created.`);
  } catch (error) {
    toast(`Could not create profile: ${error?.message ?? error}`);
  }
}

async function deleteProfile(profileId) {
  if (!window.confirm('Delete this profile and its tabs? Bookmarks and history are kept.')) return;
  try {
    await api.deleteProfile(profileId);
    await refreshProfiles();
    renderPopover();
    location.reload();
  } catch (error) {
    toast(`Could not delete profile: ${error?.message ?? error}`);
  }
}

// ── govind://profiles ─────────────────────────────────────────────────
// The full page version of the popover, plus the import flow.

function pageProfileRow(profile, { active, isDefault }) {
  return `
    <div class="perm-row">
      <span class="profile-avatar sm" style="background:${escapeHtml(profile.color)}">${escapeHtml(letter(profile.name))}</span>
      <span class="perm-origin">${escapeHtml(profile.name)}</span>
      <span class="perm-label">${escapeHtml(profile.email || 'Local profile — no account')}${isDefault ? ' · Default' : ''}</span>
      ${active ? '<span class="profile-current">Current</span>' : `<button class="btn-secondary" data-use-profile="${escapeHtml(profile.id)}" type="button">Use</button>`}
      ${isDefault ? '' : `<button class="btn-secondary" data-default-profile="${escapeHtml(profile.id)}" type="button">Set default</button>`}
      <button class="btn-secondary" data-rename-profile="${escapeHtml(profile.id)}" type="button">Rename</button>
      ${profiles.length > 1 && !active ? `<button class="btn-secondary" data-drop-profile="${escapeHtml(profile.id)}" type="button">Delete</button>` : ''}
    </div>`;
}

function renderImportSection(container, sources) {
  const body = container.querySelector('#profiles-import-body');
  if (!body) return;
  if (!sources.length) {
    body.innerHTML = '<p class="s-desc">No Chrome, Edge, Brave, Firefox or Safari profile was found on this machine. Nothing was read.</p>';
    return;
  }
  body.innerHTML = sources.map((source) => `
    <div class="settings-card">
      <h4>${escapeHtml(source.name)}</h4>
      <div class="setting-row">
        <div><div class="s-title">Profile folder</div>
          <div class="s-desc">Read-only copy, opened in place; the browser's own files are never written.</div></div>
        <select data-import-path="${escapeHtml(source.id)}">
          ${source.profile_paths.map((path) => `<option value="${escapeHtml(path)}">${escapeHtml(path.split(/[\\/]/).filter(Boolean).slice(-2).join('/'))}</option>`).join('')}
        </select>
      </div>
      <div class="chip-row">
        <label class="chip"><input type="checkbox" data-import-kind="bookmarks" checked/> Bookmarks</label>
        <label class="chip"><input type="checkbox" data-import-kind="history" checked/> History</label>
        <span class="chip" title="${escapeHtml(source.password_store.reason)}">Passwords — not imported</span>
      </div>
      <div class="setting-row">
        <button class="btn-primary" data-import-run="${escapeHtml(source.id)}" type="button">Import from ${escapeHtml(source.name)}</button>
      </div>
    </div>`).join('')
    + '<div id="profiles-import-report"></div>';
}

async function runImport(container, browserId) {
  const card = container.querySelector(`[data-import-run="${browserId}"]`)?.closest('.settings-card');
  const profilePath = card?.querySelector(`[data-import-path="${browserId}"]`)?.value ?? '';
  const options = {
    bookmarks: !!card?.querySelector('[data-import-kind="bookmarks"]')?.checked,
    history: !!card?.querySelector('[data-import-kind="history"]')?.checked,
    passwords: false,
  };
  if (!options.bookmarks && !options.history) { toast('Choose bookmarks or history to import.'); return; }
  const report = await api.importFromBrowser({ browserId, profilePath, options });
  const target = container.querySelector('#profiles-import-report');
  if (target) {
    target.innerHTML = `
      <section class="settings-card">
        <h4>Last import — ${escapeHtml(report.source)}</h4>
        <div class="setting-row"><div class="s-title">Bookmarks</div>
          <span class="perm-label">${report.bookmarks.imported} imported · ${report.bookmarks.skipped} skipped</span></div>
        <div class="setting-row"><div class="s-title">History</div>
          <span class="perm-label">${report.history.imported} imported · ${report.history.skipped} skipped</span></div>
        <div class="setting-row"><div class="s-title">Passwords</div>
          <span class="perm-label">0 imported — ${escapeHtml(report.passwords.skipped_reason)}</span></div>
        ${report.warnings.length ? `<ul class="about-limitations">${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      </section>`;
  }
  toast(`Imported ${report.bookmarks.imported} bookmarks and ${report.history.imported} history entries.`);
  document.dispatchEvent(new CustomEvent('govind:browser-data-restored'));
}

export async function renderProfilesPage(container) {
  const data = await api.listProfiles().catch(() => null);
  profiles = data?.profiles ?? profiles;
  activeId = data?.active_profile_id ?? activeId;
  const active = activeProfile();
  container.innerHTML = `
    <section class="settings-card">
      <h4>Current profile</h4>
      <div class="setting-row">
        <div>
          <div class="s-title">${escapeHtml(active?.name ?? 'Profile')}</div>
          <div class="s-desc">${escapeHtml(active?.email || 'Local profile — no account connected')}. Downloads, history, bookmarks, site permissions
            and auto-fill data belong to this profile only. Site data lives in its own engine folder.</div>
        </div>
        ${active?.is_default ? '<span class="chip selected">Default</span>' : `<button class="btn-secondary" data-default-profile="${escapeHtml(active?.id ?? '')}" type="button">Set as default</button>`}
      </div>
    </section>
    <section class="settings-card">
      <h4>All profiles</h4>
      ${profiles.map((profile) => pageProfileRow(profile, {
        active: profile.id === activeId,
        isDefault: !!profile.is_default,
      })).join('')}
      <div class="setting-row"><button class="btn-secondary" id="profiles-page-add" type="button">New profile…</button></div>
    </section>
    <section class="settings-card">
      <h4>Import from another browser</h4>
      <p class="s-desc">Copies bookmarks and history into this profile. The other browser's files are
        read, never written. Passwords cannot be imported: every source store is encrypted.</p>
      <div class="setting-row"><button class="btn-secondary" id="profiles-import-scan" type="button">Find installed browsers</button></div>
      <div id="profiles-import-body"></div>
    </section>
    <section class="settings-card">
      <h4>Not in this release</h4>
      <ul class="about-limitations">
        <li>Password manager — skipped: no encrypted credential vault.</li>
        <li>Sync — skipped: Ritam has no account service.</li>
        <li>Payment autofill — skipped: card details are not stored.</li>
      </ul>
    </section>`;

  container.querySelector('#profiles-page-add')?.addEventListener('click', async () => {
    const name = window.prompt('Name this profile (Work, Personal, …)');
    if (!name?.trim()) return;
    try {
      await api.createProfile(name.trim(), '', null);
      await renderProfilesPage(container);
      await refreshProfiles();
      toast(`Profile “${name.trim()}” created.`);
    } catch (error) {
      toast(`Could not create profile: ${error?.message ?? error}`);
    }
  });

  container.querySelector('#profiles-import-scan')?.addEventListener('click', async () => {
    const body = container.querySelector('#profiles-import-body');
    if (body) body.innerHTML = '<p class="s-desc">Looking for browser data…</p>';
    const sources = await api.detectInstalledBrowsers().catch((error) => {
      toast(`Could not scan for browsers: ${error?.message ?? error}`);
      return [];
    });
    renderImportSection(container, sources);
  });

  // Assigned, not added: this function re-renders into the same container.
  container.onclick = async (event) => {
    const use = event.target.closest('[data-use-profile]');
    if (use) { await switchProfile(use.getAttribute('data-use-profile')); return; }

    const makeDefault = event.target.closest('[data-default-profile]');
    if (makeDefault) {
      try {
        await api.setDefaultProfile(makeDefault.getAttribute('data-default-profile'));
        await renderProfilesPage(container);
        await refreshProfiles();
        toast('Default profile updated.');
      } catch (error) {
        toast(`Could not set default: ${error?.message ?? error}`);
      }
      return;
    }

    const rename = event.target.closest('[data-rename-profile]');
    if (rename) {
      const id = rename.getAttribute('data-rename-profile');
      const current = profiles.find((profile) => profile.id === id);
      const name = window.prompt('New name for this profile', current?.name ?? '');
      if (!name?.trim()) return;
      try {
        await api.renameProfile(id, name.trim());
        await renderProfilesPage(container);
        await refreshProfiles();
        toast('Profile renamed.');
      } catch (error) {
        toast(`Could not rename: ${error?.message ?? error}`);
      }
      return;
    }

    const drop = event.target.closest('[data-drop-profile]');
    if (drop) {
      const id = drop.getAttribute('data-drop-profile');
      const current = profiles.find((profile) => profile.id === id);
      if (!window.confirm(`Delete “${current?.name ?? 'this profile'}”? Its workspaces, tabs, bookmarks, history and auto-fill data are removed. Other profiles are untouched.`)) return;
      try {
        await api.deleteProfile(id);
        await renderProfilesPage(container);
        await refreshProfiles();
        toast('Profile deleted.');
      } catch (error) {
        toast(`Could not delete: ${error?.message ?? error}`);
      }
      return;
    }

    const run = event.target.closest('[data-import-run]');
    if (run) {
      try {
        await runImport(container, run.getAttribute('data-import-run'));
      } catch (error) {
        toast(`Import failed: ${error?.message ?? error}`);
      }
    }
  };
}

export function initProfiles() {
  $('#btn-profile')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleProfilePopover();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#profile-popover') && !event.target.closest('#btn-profile')) {
      $('#profile-popover')?.classList.add('hidden');
    }
  });

  const body = $('#profile-popover-body');
  body?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-profile-id]');
    if (row && !event.target.closest('#profile-delete')) {
      switchProfile(row.getAttribute('data-profile-id')).catch((error) => toast(`${error?.message ?? error}`));
      return;
    }
    if (event.target.closest('#profile-add-toggle')) {
      $('#profile-form')?.classList.remove('hidden');
      $('#profile-name-input')?.focus();
      return;
    }
    if (event.target.closest('#profile-form-cancel')) {
      $('#profile-form')?.classList.add('hidden');
      return;
    }
    const remove = event.target.closest('#profile-delete');
    if (remove) deleteProfile(remove.getAttribute('data-profile-id'));
  });

  body?.addEventListener('submit', (event) => {
    if (event.target.id !== 'profile-form') return;
    event.preventDefault();
    createProfile(event.target);
  });

  return refreshProfiles();
}

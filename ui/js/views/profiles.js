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

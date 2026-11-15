/**
 * govind://autofill — per-profile form data.
 *
 * Two kinds of entries: identities (name, email, phone) and addresses. Nothing
 * here is offered to a page on its own: the user presses Ctrl+Shift+L on a tab,
 * Rust reads that tab's real URL, and the values are pushed once, tagged with
 * the origin Rust saw. The in-page script drops any payload from another origin
 * and clears itself after one fill. Passwords and card numbers are not stored.
 */

import { escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';

const IDENTITY_FIELDS = [
  ['label', 'Label', 'Home'],
  ['full_name', 'Full name', 'Ada Lovelace'],
  ['email', 'Email', 'ada@example.com'],
  ['phone', 'Phone', '+1 555 0100'],
];

const ADDRESS_FIELDS = [
  ['label', 'Label', 'Home'],
  ['line1', 'Address line 1', '1 Main Street'],
  ['line2', 'Address line 2', ''],
  ['city', 'City', 'Bengaluru'],
  ['region', 'State / region', ''],
  ['postal_code', 'Postal code', '560001'],
  ['country', 'Country', 'India'],
];

function formRows(fields, prefix) {
  return fields.map(([key, label, placeholder]) => `
    <div class="setting-row">
      <div><div class="s-title">${label}</div></div>
      <input id="${prefix}-${key}" data-field="${key}" type="text" spellcheck="false"
             autocomplete="off" placeholder="${escapeHtml(placeholder)}" maxlength="254"/>
    </div>`).join('');
}

function entryRow(entry, kind) {
  const title = kind === 'identity'
    ? entry.label || entry.full_name || entry.email || 'Identity'
    : entry.label || [entry.line1, entry.city].filter(Boolean).join(', ') || 'Address';
  const detail = kind === 'identity'
    ? [entry.email, entry.phone].filter(Boolean).join(' · ') || '—'
    : [entry.line1, entry.line2, entry.city, entry.region, entry.postal_code, entry.country]
      .filter(Boolean).join(', ') || '—';
  return `
    <div class="perm-row">
      <span class="perm-origin">${escapeHtml(title)}</span>
      <span class="perm-label">${escapeHtml(detail)}</span>
      <button class="btn-secondary" data-af-edit="${escapeHtml(entry.id)}" data-kind="${kind}" type="button">Edit</button>
      <button class="btn-secondary" data-af-delete="${escapeHtml(entry.id)}" data-kind="${kind}" type="button">Delete</button>
    </div>`;
}

function fillForm(container, kind, entry) {
  const prefix = kind === 'identity' ? 'af-id' : 'af-addr';
  const fields = kind === 'identity' ? IDENTITY_FIELDS : ADDRESS_FIELDS;
  for (const [key] of fields) {
    const input = container.querySelector(`#${prefix}-${key}`);
    if (input) input.value = entry?.[key] ?? '';
  }
  const form = container.querySelector(`#${prefix}-form`);
  form?.classList.remove('hidden');
  form.dataset.editId = entry?.id ?? '';
  container.querySelector(`#${prefix}-add`)?.classList.add('hidden');
}

function hideForm(container, kind) {
  const prefix = kind === 'identity' ? 'af-id' : 'af-addr';
  const form = container.querySelector(`#${prefix}-form`);
  if (form) {
    form.classList.add('hidden');
    form.dataset.editId = '';
  }
  container.querySelector(`#${prefix}-add`)?.classList.remove('hidden');
}

function readForm(container, kind) {
  const prefix = kind === 'identity' ? 'af-id' : 'af-addr';
  const fields = kind === 'identity' ? IDENTITY_FIELDS : ADDRESS_FIELDS;
  const payload = {};
  for (const [key] of fields) {
    payload[key] = container.querySelector(`#${prefix}-${key}`)?.value.trim() ?? '';
  }
  const form = container.querySelector(`#${prefix}-form`);
  payload.id = form?.dataset.editId || '';
  return payload;
}

async function renderLists(container) {
  const data = await api.listAutofill().catch((error) => {
    toast(`Could not read auto-fill data: ${error?.message ?? error}`);
    return { identities: [], addresses: [] };
  });
  const identities = container.querySelector('#af-identities');
  const addresses = container.querySelector('#af-addresses');
  if (identities) {
    identities.innerHTML = data.identities.length
      ? data.identities.map((entry) => entryRow(entry, 'identity')).join('')
      : '<p class="s-desc">No saved identities for this profile.</p>';
  }
  if (addresses) {
    addresses.innerHTML = data.addresses.length
      ? data.addresses.map((entry) => entryRow(entry, 'address')).join('')
      : '<p class="s-desc">No saved addresses for this profile.</p>';
  }
  container.dataset.identities = JSON.stringify(data.identities);
  container.dataset.addresses = JSON.stringify(data.addresses);
}

function bindList(container, listSelector, kind) {
  const list = container.querySelector(listSelector);
  if (!list) return;
  list.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-af-edit]');
    if (edit) {
      const entries = JSON.parse(container.dataset[kind === 'identity' ? 'identities' : 'addresses'] ?? '[]');
      const entry = entries.find((item) => item.id === edit.getAttribute('data-af-edit'));
      if (entry) fillForm(container, kind, entry);
      return;
    }
    const remove = event.target.closest('[data-af-delete]');
    if (!remove) return;
    if (!window.confirm('Delete this saved entry?')) return;
    const id = remove.getAttribute('data-af-delete');
    try {
      if (kind === 'identity') await api.deleteIdentity(id);
      else await api.deleteAddress(id);
      await renderLists(container);
      toast('Entry deleted.');
    } catch (error) {
      toast(`Could not delete: ${error?.message ?? error}`);
    }
  });
}

export async function renderAutofillPage(container) {
  container.innerHTML = `
    <section class="settings-card">
      <h4>Saved identities</h4>
      <p class="s-desc">For this profile only. Stored as plain JSON in the profile folder
        (readable only by your user account on Unix, not encrypted). Press
        <strong>Ctrl+Shift+L</strong> on a page to fill it. Passwords are never stored.</p>
      <div id="af-identities"></div>
      <form id="af-id-form" class="hidden">
        ${formRows(IDENTITY_FIELDS, 'af-id')}
        <div class="setting-row">
          <button class="btn-primary" id="af-id-save" type="button">Save identity</button>
          <button class="btn-secondary" id="af-id-cancel" type="button">Cancel</button>
        </div>
      </form>
      <div class="setting-row" id="af-id-add">
        <button class="btn-secondary" type="button" id="af-id-add-button">Add identity…</button>
      </div>
    </section>
    <section class="settings-card">
      <h4>Saved addresses</h4>
      <p class="s-desc">Only offered in the tab you invoke it in, and only if the page's origin
        matches the one Rust read for that tab.</p>
      <div id="af-addresses"></div>
      <form id="af-addr-form" class="hidden">
        ${formRows(ADDRESS_FIELDS, 'af-addr')}
        <div class="setting-row">
          <button class="btn-primary" id="af-addr-save" type="button">Save address</button>
          <button class="btn-secondary" id="af-addr-cancel" type="button">Cancel</button>
        </div>
      </form>
      <div class="setting-row" id="af-addr-add">
        <button class="btn-secondary" type="button" id="af-addr-add-button">Add address…</button>
      </div>
    </section>
    <section class="settings-card">
      <h4>What this does not do</h4>
      <ul class="about-limitations">
        <li>No password manager — skipped: saving credentials needs an encrypted vault this release does not have.</li>
        <li>No automatic filling on page load — you ask for it with Ctrl+Shift+L.</li>
        <li>No card or payment details are stored or filled.</li>
      </ul>
    </section>`;

  container.querySelector('#af-id-add-button')?.addEventListener('click', () => fillForm(container, 'identity', null));
  container.querySelector('#af-addr-add-button')?.addEventListener('click', () => fillForm(container, 'address', null));
  container.querySelector('#af-id-cancel')?.addEventListener('click', () => hideForm(container, 'identity'));
  container.querySelector('#af-addr-cancel')?.addEventListener('click', () => hideForm(container, 'address'));

  container.querySelector('#af-id-save')?.addEventListener('click', async () => {
    const identity = readForm(container, 'identity');
    if (!identity.full_name && !identity.email && !identity.phone) {
      toast('Fill in a name, email or phone.');
      return;
    }
    try {
      await api.upsertIdentity(identity);
      hideForm(container, 'identity');
      await renderLists(container);
      toast('Identity saved for this profile.');
    } catch (error) {
      toast(`Could not save: ${error?.message ?? error}`);
    }
  });

  container.querySelector('#af-addr-save')?.addEventListener('click', async () => {
    const address = readForm(container, 'address');
    if (!address.line1 && !address.city) {
      toast('Fill in a street line or a city.');
      return;
    }
    try {
      await api.upsertAddress(address);
      hideForm(container, 'address');
      await renderLists(container);
      toast('Address saved for this profile.');
    } catch (error) {
      toast(`Could not save: ${error?.message ?? error}`);
    }
  });

  bindList(container, '#af-identities', 'identity');
  bindList(container, '#af-addresses', 'address');

  await renderLists(container);
}

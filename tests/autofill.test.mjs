import test from 'node:test';
import assert from 'node:assert/strict';

const { createFallbackDb } = await import('../ui/js/services/fallback-db.js');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const db = createFallbackDb(memoryStorage());

test('a fresh profile has no saved identities or addresses', async () => {
  const data = await db.list_autofill();
  assert.deepEqual(data.identities, []);
  assert.deepEqual(data.addresses, []);
});

test('an identity is saved with an id and edited in place', async () => {
  const saved = await db.upsert_identity({
    identity: { label: 'Home', full_name: 'Ada Lovelace', email: 'ada@example.com', phone: '' },
  });
  assert.ok(saved.id);
  assert.equal(saved.full_name, 'Ada Lovelace');

  const edited = await db.upsert_identity({
    identity: { ...saved, phone: '+1 555 0100' },
  });
  assert.equal(edited.id, saved.id);
  const data = await db.list_autofill();
  assert.equal(data.identities.length, 1);
  assert.equal(data.identities[0].phone, '+1 555 0100');
});

test('an identity without a name, email or phone is rejected', async () => {
  await assert.rejects(
    () => db.upsert_identity({ identity: { label: 'Empty' } }),
    /needs a field/,
  );
});

test('an address needs a street line or a city', async () => {
  await assert.rejects(() => db.upsert_address({ address: {} }), /needs a field/);
  const saved = await db.upsert_address({
    address: { id: '', label: 'Office', line1: '', city: 'Bengaluru', postal_code: '560001' },
  });
  assert.ok(saved.id);
});

test('deleting one entry leaves the others', async () => {
  const extra = await db.upsert_identity({
    identity: { label: 'Work', full_name: 'Grace Hopper', email: 'grace@example.com' },
  });
  const before = await db.list_autofill();
  assert.equal(before.identities.length, 2);

  assert.equal(await db.delete_identity({ id: extra.id }), true);
  assert.equal(await db.delete_identity({ id: extra.id }), false);
  const after = await db.list_autofill();
  assert.equal(after.identities.length, 1);
  assert.equal(after.identities[0].full_name, 'Ada Lovelace');
});

test('auto-fill data belongs to the profile it was saved in', async () => {
  const created = await db.create_profile({ name: 'Isolated', email: '' });
  const home = (await db.list_profiles()).profiles.find((profile) => profile.name === 'Personal');

  await db.set_active_profile({ profile_id: created.id });
  assert.deepEqual((await db.list_autofill()).identities, []);
  await db.upsert_identity({ identity: { full_name: 'Only In Isolated' } });

  await db.set_active_profile({ profile_id: home.id });
  const homeData = await db.list_autofill();
  assert.ok(!homeData.identities.some((entry) => entry.full_name === 'Only In Isolated'));
  assert.equal(homeData.identities.length, 1);

  // Deleting a profile takes its auto-fill data with it.
  await db.delete_profile({ profile_id: created.id });
  const remaining = (await db.list_profiles()).profiles.map((profile) => profile.id);
  assert.ok(!remaining.includes(created.id));
});

test('the preview reports that filling needs the installed app', async () => {
  const result = await db.request_autofill({ tab_id: 'x' });
  assert.equal(result.filled, false);
  assert.match(result.reason, /installed app/);
});

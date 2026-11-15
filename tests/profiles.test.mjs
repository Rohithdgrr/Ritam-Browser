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

test('a fresh database has one active profile and one workspace', async () => {
  const { profiles, active_profile_id } = await db.list_profiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Personal');
  assert.equal(profiles[0].email, '');
  assert.equal(active_profile_id, profiles[0].id);

  const workspaces = await db.list_workspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].profile_id, profiles[0].id);
});

test('creating a profile with a Gmail address gives it its own workspace', async () => {
  const created = await db.create_profile({ name: 'Work', email: 'rohit93dgrr@gmail.com' });
  assert.equal(created.name, 'Work');
  assert.equal(created.email, 'rohit93dgrr@gmail.com');

  const { profiles } = await db.list_profiles();
  assert.equal(profiles.length, 2);
  // The new profile is not active yet, so the workspace list is unchanged.
  assert.equal((await db.list_workspaces()).length, 1);
});

test('malformed email addresses are rejected', async () => {
  for (const email of ['not-an-email', 'a@b', 'two words@example.com', 'x@y.z@example.com']) {
    await assert.rejects(() => db.create_profile({ name: 'Broken', email }), /valid address/);
  }
  assert.equal((await db.list_profiles()).profiles.length, 2);
});

test('switching profile switches the workspace set and keeps tabs apart', async () => {
  const before = await db.list_profiles();
  const work = before.profiles.find((profile) => profile.name === 'Work');
  await db.set_active_profile({ profile_id: work.id });

  const workspaces = await db.list_workspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].profile_id, work.id);

  const tab = await db.create_tab({ url: 'https://example.com/work' });
  assert.equal(tab.workspace_id, workspaces[0].id);

  const home = before.profiles.find((profile) => profile.name === 'Personal');
  await db.set_active_profile({ profile_id: home.id });
  const homeWorkspaces = await db.list_workspaces();
  assert.equal(homeWorkspaces.length, 1);
  assert.notEqual(homeWorkspaces[0].id, workspaces[0].id);

  const homeTabs = await db.list_tabs({ workspace_id: homeWorkspaces[0].id });
  assert.ok(!homeTabs.some((item) => item.url === 'https://example.com/work'));
});

test('the last profile cannot be deleted, others remove their workspaces', async () => {
  const { profiles } = await db.list_profiles();
  const work = profiles.find((profile) => profile.name === 'Work');
  const home = profiles.find((profile) => profile.name === 'Personal');
  await db.set_active_profile({ profile_id: home.id });

  await db.delete_profile({ profile_id: work.id });
  const after = await db.list_profiles();
  assert.equal(after.profiles.length, 1);
  assert.equal(after.profiles[0].id, home.id);
  await assert.rejects(() => db.delete_profile({ profile_id: home.id }), /last profile/);
});

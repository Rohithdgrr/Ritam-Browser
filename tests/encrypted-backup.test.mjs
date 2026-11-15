import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptBrowserBackup, encryptBrowserBackup } from '../ui/js/lib/encrypted-backup.js';

test('encrypted backup round-trips with the correct passphrase', async () => {
  const snapshot = JSON.stringify({ version: 1, bookmarks: [{ url: 'https://example.com' }] });
  const encrypted = await encryptBrowserBackup(snapshot, 'a long backup passphrase');
  assert.equal(await decryptBrowserBackup(encrypted, 'a long backup passphrase'), snapshot);
  assert.notEqual(encrypted, snapshot);
});

test('encrypted backup rejects a wrong passphrase and tampered ciphertext', async () => {
  const encrypted = await encryptBrowserBackup('{"version":1}', 'a long backup passphrase');
  await assert.rejects(decryptBrowserBackup(encrypted, 'a different passphrase'), /Could not decrypt/);
  const envelope = JSON.parse(encrypted);
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
  await assert.rejects(decryptBrowserBackup(JSON.stringify(envelope), 'a long backup passphrase'));
});

test('encrypted backup rejects weak passphrases and unsupported parameters', async () => {
  await assert.rejects(encryptBrowserBackup('{}', 'short'), /at least 12/);
  const encrypted = JSON.parse(await encryptBrowserBackup('{}', 'a long backup passphrase'));
  encrypted.iterations = 1;
  await assert.rejects(decryptBrowserBackup(JSON.stringify(encrypted), 'a long backup passphrase'), /Unsupported/);
});

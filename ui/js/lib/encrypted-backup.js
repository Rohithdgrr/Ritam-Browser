const FORMAT = 'govind-encrypted-backup';
const VERSION = 1;
const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode(`${FORMAT}:v${VERSION}`);
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_FILE_CHARS = 48 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid encrypted backup.');
  }
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error('Invalid encrypted backup.');
  }
  return bytes;
}

async function deriveKey(passphrase, salt, usage) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure encryption is unavailable in this environment.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptBrowserBackup(snapshot, passphrase) {
  if (typeof snapshot !== 'string' || encoder.encode(snapshot).length > MAX_SNAPSHOT_BYTES) {
    throw new Error('Browser data is too large to export.');
  }
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('Use a backup passphrase with at least 12 characters.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 },
    key,
    encoder.encode(snapshot),
  );
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    kdf: 'PBKDF2-SHA-256',
    iterations: ITERATIONS,
    cipher: 'AES-256-GCM',
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptBrowserBackup(file, passphrase) {
  if (typeof file !== 'string' || file.length > MAX_FILE_CHARS) {
    throw new Error('Encrypted backup file is too large.');
  }
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('Enter the backup passphrase.');
  let envelope;
  try {
    envelope = JSON.parse(file);
  } catch {
    throw new Error('This is not a valid Govind encrypted backup.');
  }
  if (
    envelope?.format !== FORMAT
    || envelope.version !== VERSION
    || envelope.kdf !== 'PBKDF2-SHA-256'
    || envelope.iterations !== ITERATIONS
    || envelope.cipher !== 'AES-256-GCM'
  ) {
    throw new Error('Unsupported encrypted backup format.');
  }
  const salt = fromBase64(envelope.salt, 16);
  const iv = fromBase64(envelope.iv, 12);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (ciphertext.length < 16) throw new Error('Invalid encrypted backup.');
  const key = await deriveKey(passphrase, salt, 'decrypt');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 },
      key,
      ciphertext,
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error('Could not decrypt backup; check the passphrase and file.');
  }
}

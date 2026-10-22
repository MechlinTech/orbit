import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';

export const MASKED_VALUE = '••••••••';

/**
 * Derives a consistent 32-byte key from app secrets.
 */
function getEncryptionKey() {
  const master = process.env.INTEGRATION_ENCRYPTION_KEY ||
                 process.env.APP_SECRET ||
                 process.env.SESSION_SECRET ||
                 'orbit-integration-vault-salt-master-2026';
  return scryptSync(master, 'orbit-vault-salt-v1', 32);
}

/**
 * Encrypts a plaintext secret string using AES-256-GCM.
 * Stored as: ivHex:tagHex:encryptedHex
 */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return '';
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM ciphertext string.
 */
export function decryptSecret(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return '';
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    throw new Error('Failed to decrypt secret: invalid key or tampered ciphertext');
  }
}

/**
 * Checks if a string matches the masked secret indicator.
 */
export function isMasked(value) {
  return typeof value === 'string' && (value === MASKED_VALUE || /^•{4,}$/.test(value.trim()));
}

/**
 * Returns a masked representation of a secret value.
 */
export function maskSecret(value) {
  return Boolean(value) ? MASKED_VALUE : '';
}

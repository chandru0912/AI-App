import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

function documentKey(): Buffer | null {
  if (!config.DOCUMENT_ENCRYPTION_KEY) return null;
  const raw = config.DOCUMENT_ENCRYPTION_KEY;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('DOCUMENT_ENCRYPTION_KEY must be 32 bytes (base64 or 64-char hex)');
  }
  return key;
}

export const documentEncryptionAvailable = () => documentKey() !== null;

export function encryptBuffer(plain: Buffer): Buffer {
  const key = documentKey();
  if (!key) throw new Error('Document encryption is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBuffer(sealed: Buffer): Buffer {
  const key = documentKey();
  if (!key) throw new Error('Document encryption is not configured');
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const ciphertext = sealed.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

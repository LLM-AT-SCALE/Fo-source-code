import crypto from 'crypto';

// AES-256-GCM encryption for sensitive data (AWS credentials, MCP credentials)
// Encryption key should be stored in environment variable: KEY_ENCRYPTION_SECRET

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
// AUTH_TAG_LENGTH is 16 bytes (128 bits), which is the default for GCM

function getEncryptionKey(): Buffer {
  const key = process.env.KEY_ENCRYPTION_SECRET;

  if (!key) {
    throw new Error('KEY_ENCRYPTION_SECRET environment variable is not set');
  }

  // Key should be 32 bytes (64 hex characters) for AES-256
  if (key.length !== 64) {
    throw new Error('KEY_ENCRYPTION_SECRET must be 64 hex characters (32 bytes)');
  }

  return Buffer.from(key, 'hex');
}

/**
 * Encrypts a string using AES-256-GCM
 * Returns: iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a string encrypted with AES-256-GCM
 * Input format: iv:authTag:encryptedData (all hex-encoded)
 */
export function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Hash a password using bcrypt-compatible algorithm (scrypt)
 * Returns base64-encoded hash with salt prefix
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(':');
  const saltBuffer = Buffer.from(salt, 'hex');
  const keyBuffer = Buffer.from(key, 'hex');

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltBuffer, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(crypto.timingSafeEqual(keyBuffer, derivedKey));
    });
  });
}

/**
 * Generate a secure random token (for sessions, password reset, etc.)
 */
export function generateToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

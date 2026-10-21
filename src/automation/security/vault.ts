import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { EncryptedBlob } from '../../types/index.js';

/**
 * AES-256-GCM encryption for platform passwords and browser sessions.
 * The key comes from CREDENTIALS_SECRET, or a random key generated on first use
 * and stored next to the database (DATA_DIR/.vault-key).
 */
class Vault {
  private key: Buffer | null = null;

  private getKey(): Buffer {
    if (this.key) return this.key;
    if (env.CREDENTIALS_SECRET) {
      this.key = crypto.createHash('sha256').update(env.CREDENTIALS_SECRET).digest();
      return this.key;
    }
    const file = paths.vaultKeyFile;
    if (fs.existsSync(file)) {
      const hex = fs.readFileSync(file, 'utf-8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        this.key = Buffer.from(hex, 'hex');
        return this.key;
      }
      throw new Error(`Vault key file ${file} is corrupt; delete it and re-enter platform passwords`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(file, generated.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    this.key = generated;
    return this.key;
  }

  encrypt(plaintext: string): EncryptedBlob {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  decrypt(blob: EncryptedBlob): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf-8');
  }

  /** Test hook: forget the cached key (e.g. after DATA_DIR changes). */
  reset(): void {
    this.key = null;
  }
}

export const vault = new Vault();

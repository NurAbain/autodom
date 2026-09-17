import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialVault {
  readonly configured: boolean;
  private readonly key: Buffer | null;

  constructor(encodedKey?: string) {
    if (!encodedKey) {
      this.key = null;
      this.configured = false;
      return;
    }
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) {
      throw new Error("AUTODOM_OUTREACH_CREDENTIAL_KEY must be a base64-encoded 32-byte key");
    }
    this.key = key;
    this.configured = true;
  }

  seal(value: string, context: string): Buffer {
    if (!this.key) throw new Error("Credential vault is not configured");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), encrypted]);
  }

  open(value: Buffer, context: string): string {
    if (!this.key) throw new Error("Credential vault is not configured");
    if (value.length <= 1 + IV_BYTES + TAG_BYTES || value[0] !== VERSION)
      throw new Error("Unsupported encrypted credential");
    const iv = value.subarray(1, 1 + IV_BYTES);
    const tag = value.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const encrypted = value.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}

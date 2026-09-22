/**
 * Secrets vault (plan §5, §10).
 *
 * Each secret is encrypted with AES-256-GCM under a master key, with a random
 * 96-bit nonce and the secret id as additional authenticated data. The master
 * key comes from a KeySource: an environment variable, a passphrase (scrypt with
 * a salt stored in the vault header) or the macOS keychain. Encrypted records
 * live in a SecretRecordStore (blob-backed or in-memory), never in the main
 * database, and the rest of the system only ever holds `vault://<id>` references.
 */
import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { promisify } from "node:util";
import type { BlobStore } from "@vo/storage";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

export type VaultErrorCode =
  "missing_key" | "wrong_key" | "not_found" | "invalid_ref" | "corrupt" | "not_initialized";

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

// ---------------------------------------------------------------------------
// Key sources
// ---------------------------------------------------------------------------

export interface KeySource {
  readonly kind: "raw" | "passphrase";
  /** Returns the 32-byte master key. `salt` is provided for passphrase sources. */
  derive(salt: Uint8Array | null): Promise<Uint8Array>;
}

const KEY_BYTES = 32;

function parseKey(text: string, origin: string): Uint8Array {
  const trimmed = text.trim();
  let bytes: Buffer;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) bytes = Buffer.from(trimmed, "hex");
  else bytes = Buffer.from(trimmed, "base64");
  if (bytes.byteLength !== KEY_BYTES) {
    throw new VaultError(
      "missing_key",
      `${origin} must hold a ${String(KEY_BYTES)}-byte key encoded as base64 or hex`,
    );
  }
  return new Uint8Array(bytes);
}

export function envKeySource(
  variable = "VO_VAULT_KEY",
  env: NodeJS.ProcessEnv = process.env,
): KeySource {
  return {
    kind: "raw",
    derive: () => {
      const value = env[variable];
      if (value === undefined || value.length === 0) {
        return Promise.reject(
          new VaultError("missing_key", `environment variable ${variable} is not set`),
        );
      }
      try {
        return Promise.resolve(parseKey(value, `environment variable ${variable}`));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

export function passphraseKeySource(passphrase: string): KeySource {
  return {
    kind: "passphrase",
    derive: async (salt) => {
      if (salt === null)
        throw new VaultError("missing_key", "a passphrase key needs the vault salt");
      return new Uint8Array(await scrypt(passphrase, salt, KEY_BYTES, SCRYPT));
    },
  };
}

export type Exec = (file: string, args: readonly string[]) => Promise<string>;

const defaultExec: Exec = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, [...args], { encoding: "utf8" });
  return stdout;
};

/** Reads the key from the macOS keychain: `security find-generic-password -s <service> -a <account> -w`. */
export function macosKeychainKeySource(options: {
  service: string;
  account: string;
  exec?: Exec;
}): KeySource {
  const exec = options.exec ?? defaultExec;
  return {
    kind: "raw",
    derive: async () => {
      let output: string;
      try {
        output = await exec("security", [
          "find-generic-password",
          "-s",
          options.service,
          "-a",
          options.account,
          "-w",
        ]);
      } catch (e) {
        throw new VaultError(
          "missing_key",
          `keychain item ${options.service}/${options.account} not available: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return parseKey(output, `keychain item ${options.service}/${options.account}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Records and stores
// ---------------------------------------------------------------------------

export interface EncryptedBlob {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export interface SecretRecord extends EncryptedBlob {
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type VaultKdf =
  | { readonly type: "raw" }
  | {
      readonly type: "scrypt";
      readonly salt: string;
      readonly N: number;
      readonly r: number;
      readonly p: number;
    };

export interface VaultFile {
  readonly version: 1;
  readonly kdf: VaultKdf;
  readonly check: EncryptedBlob;
  readonly secrets: Readonly<Record<string, SecretRecord>>;
}

export interface SecretRecordStore {
  load(): Promise<VaultFile | null>;
  save(file: VaultFile): Promise<void>;
}

export class InMemorySecretRecordStore implements SecretRecordStore {
  private file: VaultFile | null = null;

  load(): Promise<VaultFile | null> {
    return Promise.resolve(this.file ? structuredClone(this.file) : null);
  }

  save(file: VaultFile): Promise<void> {
    this.file = structuredClone(file);
    return Promise.resolve();
  }

  snapshot(): VaultFile | null {
    return this.file ? structuredClone(this.file) : null;
  }

  /** Test helper: corrupts one ciphertext byte of the given secret. */
  tamper(id: string): void {
    const record = this.file?.secrets[id];
    if (!this.file || !record) throw new Error(`no secret ${id}`);
    const bytes = Buffer.from(record.data, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    this.file = {
      ...this.file,
      secrets: { ...this.file.secrets, [id]: { ...record, data: bytes.toString("base64") } },
    };
  }
}

export class BlobSecretRecordStore implements SecretRecordStore {
  constructor(
    private readonly blobs: BlobStore,
    private readonly key = "vault/secrets.json",
  ) {}

  async load(): Promise<VaultFile | null> {
    const blob = await this.blobs.get(this.key);
    return blob ? (JSON.parse(new TextDecoder().decode(blob.data)) as VaultFile) : null;
  }

  save(file: VaultFile): Promise<void> {
    return this.blobs.put(
      this.key,
      new TextEncoder().encode(JSON.stringify(file)),
      "application/json",
    );
  }
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const CHECK_ID = "__vault_check__";
const CHECK_PLAINTEXT = "vo-vault-v1";

function encrypt(key: Uint8Array, aad: string, plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Returns null when authentication fails (wrong key or tampered data). */
function decrypt(key: Uint8Array, aad: string, blob: EncryptedBlob): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export type SecretRef = `vault://${string}`;
const REF = /^vault:\/\/([0-9a-f]{32})$/;

export interface SecretSummary {
  readonly ref: SecretRef;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenVaultOptions {
  /** Create the vault when the store is empty (default true). */
  readonly create?: boolean;
  /** Verify the key against the check record on open (default true). */
  readonly verifyKey?: boolean;
}

const MIN_REDACT_LENGTH = 6;

export class Vault {
  private constructor(
    private readonly store: SecretRecordStore,
    private key: Uint8Array,
    private file: VaultFile,
    private readonly now: () => Date,
  ) {}

  static async open(
    store: SecretRecordStore,
    keySource: KeySource,
    options: OpenVaultOptions = {},
    now: () => Date = () => new Date(),
  ): Promise<Vault> {
    const existing = await store.load();
    if (!existing) {
      if (options.create === false)
        throw new VaultError("not_initialized", "the secrets vault has not been created");
      const { key, kdf } = await deriveFresh(keySource);
      const file: VaultFile = {
        version: 1,
        kdf,
        check: encrypt(key, CHECK_ID, CHECK_PLAINTEXT),
        secrets: {},
      };
      await store.save(file);
      return new Vault(store, key, file, now);
    }
    const salt =
      existing.kdf.type === "scrypt"
        ? new Uint8Array(Buffer.from(existing.kdf.salt, "base64"))
        : null;
    const key = await keySource.derive(salt);
    const vault = new Vault(store, key, existing, now);
    if (options.verifyKey !== false && !vault.keyIsValid()) {
      throw new VaultError("wrong_key", "the provided key does not open this vault");
    }
    return vault;
  }

  private keyIsValid(): boolean {
    return decrypt(this.key, CHECK_ID, this.file.check) === CHECK_PLAINTEXT;
  }

  private static id(ref: string): string {
    const m = REF.exec(ref);
    if (!m?.[1]) throw new VaultError("invalid_ref", `"${ref}" is not a vault reference`);
    return m[1];
  }

  private async persist(file: VaultFile): Promise<void> {
    await this.store.save(file);
    this.file = file;
  }

  async put(name: string, value: string): Promise<SecretRef> {
    const id = randomBytes(16).toString("hex");
    const at = this.now().toISOString();
    const record: SecretRecord = {
      name,
      createdAt: at,
      updatedAt: at,
      ...encrypt(this.key, id, value),
    };
    await this.persist({ ...this.file, secrets: { ...this.file.secrets, [id]: record } });
    return `vault://${id}`;
  }

  async update(ref: string, value: string): Promise<SecretRef> {
    const id = Vault.id(ref);
    const existing = this.file.secrets[id];
    if (!existing) throw new VaultError("not_found", `no secret ${ref}`);
    const record: SecretRecord = {
      ...existing,
      updatedAt: this.now().toISOString(),
      ...encrypt(this.key, id, value),
    };
    await this.persist({ ...this.file, secrets: { ...this.file.secrets, [id]: record } });
    return `vault://${id}`;
  }

  get(ref: string): Promise<string> {
    try {
      const id = Vault.id(ref);
      const record = this.file.secrets[id];
      if (!record) throw new VaultError("not_found", `no secret ${ref}`);
      const value = decrypt(this.key, id, record);
      if (value === null) {
        throw this.keyIsValid()
          ? new VaultError("corrupt", `secret ${ref} failed authentication; the record is damaged`)
          : new VaultError("wrong_key", "the current key does not open this vault");
      }
      return Promise.resolve(value);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  has(ref: string): Promise<boolean> {
    try {
      return Promise.resolve(Vault.id(ref) in this.file.secrets);
    } catch {
      return Promise.resolve(false);
    }
  }

  async delete(ref: string): Promise<boolean> {
    const id = Vault.id(ref);
    if (!(id in this.file.secrets)) return false;
    const { [id]: _removed, ...rest } = this.file.secrets;
    await this.persist({ ...this.file, secrets: rest });
    return true;
  }

  list(): Promise<SecretSummary[]> {
    const out = Object.entries(this.file.secrets).map(([id, r]): SecretSummary => ({
      ref: `vault://${id}`,
      name: r.name,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
    }));
    return Promise.resolve(out.sort((a, b) => a.name.localeCompare(b.name)));
  }

  /** Re-encrypts every secret and the check record under a new key. */
  async rotate(keySource: KeySource): Promise<void> {
    const plaintexts = new Map<string, string>();
    for (const id of Object.keys(this.file.secrets))
      plaintexts.set(id, await this.get(`vault://${id}`));
    const { key, kdf } = await deriveFresh(keySource);
    const secrets: Record<string, SecretRecord> = {};
    for (const [id, record] of Object.entries(this.file.secrets)) {
      secrets[id] = { ...record, ...encrypt(key, id, plaintexts.get(id) ?? "") };
    }
    const file: VaultFile = {
      version: 1,
      kdf,
      check: encrypt(key, CHECK_ID, CHECK_PLAINTEXT),
      secrets,
    };
    await this.persist(file);
    this.key = key;
  }

  /** Replaces every known secret value (6+ chars) in `text` with a labelled placeholder. */
  async redact(text: string): Promise<string> {
    const values: { name: string; value: string }[] = [];
    for (const [id, record] of Object.entries(this.file.secrets)) {
      const value = await this.get(`vault://${id}`);
      if (value.length >= MIN_REDACT_LENGTH) values.push({ name: record.name, value });
    }
    values.sort((a, b) => b.value.length - a.value.length);
    let out = text;
    for (const { name, value } of values) out = out.split(value).join(`[REDACTED:${name}]`);
    return out;
  }
}

async function deriveFresh(keySource: KeySource): Promise<{ key: Uint8Array; kdf: VaultKdf }> {
  if (keySource.kind === "passphrase") {
    const salt = randomBytes(16);
    const key = await keySource.derive(new Uint8Array(salt));
    return { key, kdf: { type: "scrypt", salt: salt.toString("base64"), ...SCRYPT } };
  }
  return { key: await keySource.derive(null), kdf: { type: "raw" } };
}

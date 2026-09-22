import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConnector, unwrap, type ConnectorId, type OfficeId } from "@vo/core";
import { InMemoryBlobStore } from "@vo/storage";
import {
  BlobSecretRecordStore,
  envKeySource,
  InMemorySecretRecordStore,
  macosKeychainKeySource,
  passphraseKeySource,
  Vault,
  VaultError,
  type KeySource,
} from "./vault.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const env = (key: string): NodeJS.ProcessEnv => ({ VO_VAULT_KEY: key });

async function openVault(store = new InMemorySecretRecordStore(), key = KEY_A): Promise<Vault> {
  return Vault.open(store, envKeySource("VO_VAULT_KEY", env(key)));
}

describe("envKeySource", () => {
  it("accepts a 32-byte key as base64 or hex", async () => {
    expect((await envKeySource("K", { K: KEY_A }).derive(null)).byteLength).toBe(32);
    expect(
      (await envKeySource("K", { K: randomBytes(32).toString("hex") }).derive(null)).byteLength,
    ).toBe(32);
  });

  it("fails cleanly when the variable is missing or the wrong size", async () => {
    await expect(envKeySource("K", {}).derive(null)).rejects.toMatchObject({ code: "missing_key" });
    await expect(envKeySource("K", { K: "short" }).derive(null)).rejects.toMatchObject({
      code: "missing_key",
    });
    await expect(
      envKeySource("K", { K: randomBytes(16).toString("base64") }).derive(null),
    ).rejects.toMatchObject({ code: "missing_key" });
  });
});

describe("Vault", () => {
  it("stores a secret encrypted and returns a vault:// reference that decrypts back", async () => {
    const vault = await openVault();
    const ref = await vault.put("github-token", "ghp_supersecret");
    expect(ref).toMatch(/^vault:\/\/[0-9a-f]{32}$/);
    expect(await vault.get(ref)).toBe("ghp_supersecret");
    expect(await vault.has(ref)).toBe(true);
  });

  it("never persists plaintext: the serialized store and the listing contain only ciphertext and names", async () => {
    const store = new InMemorySecretRecordStore();
    const vault = await openVault(store);
    const ref = await vault.put("openai", "sk-live-PLAINTEXT-1234567890");
    const serialized = JSON.stringify(store.snapshot());
    expect(serialized).not.toContain("PLAINTEXT");
    expect(serialized).not.toContain("sk-live");
    expect(serialized).toContain("openai");
    const listing = await vault.list();
    expect(listing).toEqual([
      {
        ref,
        name: "openai",
        createdAt: expect.any(Date) as Date,
        updatedAt: expect.any(Date) as Date,
      },
    ]);
    expect(JSON.stringify(listing)).not.toContain("PLAINTEXT");
  });

  it("a serialized office connector carries only the reference", async () => {
    const vault = await openVault();
    const ref = await vault.put("jira", "jira-api-token-XYZ");
    const connector = unwrap(
      createConnector(
        {
          officeId: "o1" as OfficeId,
          kind: "rest",
          name: "jira",
          tools: ["create_issue"],
          secretRef: ref,
        },
        [],
        { id: () => "k1" as ConnectorId, now: () => new Date(0) },
      ),
    );
    const json = JSON.stringify(connector);
    expect(json).toContain(ref);
    expect(json).not.toContain("XYZ");
  });

  it("fails cleanly with the wrong key, both on open and on read", async () => {
    const store = new InMemorySecretRecordStore();
    const vault = await openVault(store, KEY_A);
    const ref = await vault.put("x", "value");
    await expect(Vault.open(store, envKeySource("VO_VAULT_KEY", env(KEY_B)))).rejects.toMatchObject(
      { code: "wrong_key" },
    );
    const forced = await Vault.open(store, envKeySource("VO_VAULT_KEY", env(KEY_B)), {
      verifyKey: false,
    });
    const err = await forced.get(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).code).toBe("wrong_key");
    expect((err as VaultError).message).not.toMatch(/Unsupported state|auth tag/i);
  });

  it("reports missing references and tampered ciphertext distinctly", async () => {
    const store = new InMemorySecretRecordStore();
    const vault = await openVault(store);
    const ref = await vault.put("x", "value");
    await expect(vault.get("vault://00000000000000000000000000000000")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(vault.get("not-a-ref")).rejects.toMatchObject({ code: "invalid_ref" });
    store.tamper(ref.slice("vault://".length));
    const reopened = await openVault(store);
    await expect(reopened.get(ref)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("updates in place, deletes, and refuses to return deleted secrets", async () => {
    const vault = await openVault();
    const ref = await vault.put("x", "one");
    const same = await vault.update(ref, "two");
    expect(same).toBe(ref);
    expect(await vault.get(ref)).toBe("two");
    expect(await vault.delete(ref)).toBe(true);
    expect(await vault.delete(ref)).toBe(false);
    await expect(vault.get(ref)).rejects.toMatchObject({ code: "not_found" });
  });

  it("derives keys from a passphrase with a stored salt and rejects the wrong passphrase", async () => {
    const store = new InMemorySecretRecordStore();
    const vault = await Vault.open(store, passphraseKeySource("correct horse battery staple"));
    const ref = await vault.put("x", "value");
    const again = await Vault.open(store, passphraseKeySource("correct horse battery staple"));
    expect(await again.get(ref)).toBe("value");
    await expect(Vault.open(store, passphraseKeySource("wrong"))).rejects.toMatchObject({
      code: "wrong_key",
    });
  });

  it("rotates to a new key, re-encrypting every secret", async () => {
    const store = new InMemorySecretRecordStore();
    const vault = await openVault(store, KEY_A);
    const r1 = await vault.put("a", "one");
    const r2 = await vault.put("b", "two");
    const before = JSON.stringify(store.snapshot());
    await vault.rotate(envKeySource("VO_VAULT_KEY", env(KEY_B)));
    expect(JSON.stringify(store.snapshot())).not.toBe(before);
    expect(await vault.get(r1)).toBe("one");
    const reopened = await openVault(store, KEY_B);
    expect(await reopened.get(r2)).toBe("two");
    await expect(openVault(store, KEY_A)).rejects.toMatchObject({ code: "wrong_key" });
  });

  it("redacts known secret values from arbitrary text", async () => {
    const vault = await openVault();
    await vault.put("token", "ghp_abc123");
    await vault.put("empty-ish", "x");
    const text = "Authorization: Bearer ghp_abc123 and again ghp_abc123; x marks the spot";
    expect(await vault.redact(text)).toBe(
      "Authorization: Bearer [REDACTED:token] and again [REDACTED:token]; x marks the spot",
    );
  });

  it("persists through a blob store and reopens", async () => {
    const blobs = new InMemoryBlobStore();
    const store = new BlobSecretRecordStore(blobs, "vault/secrets.json");
    const vault = await Vault.open(store, envKeySource("VO_VAULT_KEY", env(KEY_A)));
    const ref = await vault.put("s", "value");
    expect(await blobs.exists("vault/secrets.json")).toBe(true);
    const raw = new TextDecoder().decode((await blobs.get("vault/secrets.json"))?.data);
    expect(raw).not.toContain("value");
    const reopened = await Vault.open(
      new BlobSecretRecordStore(blobs, "vault/secrets.json"),
      envKeySource("VO_VAULT_KEY", env(KEY_A)),
    );
    expect(await reopened.get(ref)).toBe("value");
  });

  it("refuses to create a vault when the store is empty and create is disabled", async () => {
    await expect(
      Vault.open(new InMemorySecretRecordStore(), envKeySource("VO_VAULT_KEY", env(KEY_A)), {
        create: false,
      }),
    ).rejects.toMatchObject({ code: "not_initialized" });
  });
});

describe("macosKeychainKeySource", () => {
  it("reads a base64 key from the security tool", async () => {
    const calls: string[][] = [];
    const source: KeySource = macosKeychainKeySource({
      service: "vo-vault",
      account: "office-1",
      exec: (file, args) => {
        calls.push([file, ...args]);
        return Promise.resolve(`${KEY_A}\n`);
      },
    });
    expect((await source.derive(null)).byteLength).toBe(32);
    expect(calls[0]).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "vo-vault",
      "-a",
      "office-1",
      "-w",
    ]);
  });

  it("fails cleanly when the item is missing", async () => {
    const source = macosKeychainKeySource({
      service: "s",
      account: "a",
      exec: () => Promise.reject(new Error("The specified item could not be found")),
    });
    await expect(source.derive(null)).rejects.toMatchObject({ code: "missing_key" });
  });
});

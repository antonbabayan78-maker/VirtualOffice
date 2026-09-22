/**
 * Filesystem BlobStore. Layout under the root:
 *
 *   data/<key>        the bytes
 *   meta/<key>.json   { contentType, size }
 *
 * Writes go to a temp file in the target directory and are renamed into place,
 * so readers never observe a partial object. Streams never buffer whole files.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NO_CAPABILITIES, type StoreCapabilities } from "../../stores/capabilities.js";
import type { AdapterFactory, StoreByKind, StoreKind } from "../../stores/registry.js";
import { validateBlobKey, type Blob, type BlobStore } from "../../stores/types.js";

export interface FsBlobStoreOptions {
  readonly root: string;
}

interface Meta {
  readonly contentType: string | null;
  readonly size: number;
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

export class FsBlobStore implements BlobStore {
  readonly capabilities: StoreCapabilities = NO_CAPABILITIES;
  private readonly dataRoot: string;
  private readonly metaRoot: string;
  private tmpCounter = 0;

  constructor(private readonly root: string) {
    this.dataRoot = join(root, "data");
    this.metaRoot = join(root, "meta");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    await mkdir(this.metaRoot, { recursive: true });
  }

  private dataPath(key: string): string {
    validateBlobKey(key);
    const path = resolve(this.dataRoot, ...key.split("/"));
    if (!path.startsWith(this.dataRoot + sep))
      throw new Error(`invalid blob key ${JSON.stringify(key)}`);
    return path;
  }

  private metaPath(key: string): string {
    return `${resolve(this.metaRoot, ...key.split("/"))}.json`;
  }

  private tmpPath(target: string): string {
    this.tmpCounter += 1;
    return `${target}.${String(process.pid)}.${String(this.tmpCounter)}.tmp`;
  }

  private async writeMeta(key: string, meta: Meta): Promise<void> {
    const path = this.metaPath(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = this.tmpPath(path);
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, path);
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    const target = this.dataPath(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = this.tmpPath(target);
    await writeFile(tmp, data);
    await rename(tmp, target);
    await this.writeMeta(key, { contentType: contentType ?? null, size: data.byteLength });
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<void> {
    const target = this.dataPath(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = this.tmpPath(target);
    let size = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        size += chunk.byteLength;
        yield chunk;
      }
    }
    try {
      await pipeline(Readable.from(counted()), createWriteStream(tmp));
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await rename(tmp, target);
    await this.writeMeta(key, { contentType: contentType ?? null, size });
  }

  private async readMeta(key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(key), "utf8")) as Meta;
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<Blob | null> {
    let data: Buffer;
    try {
      data = await readFile(this.dataPath(key));
    } catch {
      return null;
    }
    const meta = await this.readMeta(key);
    return { data: new Uint8Array(data), contentType: meta?.contentType ?? null };
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const path = this.dataPath(key);
    try {
      await stat(path);
    } catch {
      return null;
    }
    return createReadStream(path);
  }

  async delete(key: string): Promise<boolean> {
    try {
      await unlink(this.dataPath(key));
    } catch {
      return false;
    }
    await rm(this.metaPath(key), { force: true });
    return true;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.dataPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !entry.name.endsWith(".tmp"))
          out.push(toPosix(relative(this.dataRoot, full)));
      }
    };
    await walk(this.dataRoot);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** The configured root directory. */
  get location(): string {
    return this.root;
  }
}

export async function openFsBlobStore(options: FsBlobStoreOptions): Promise<FsBlobStore> {
  const store = new FsBlobStore(resolve(options.root));
  await store.initialize();
  return store;
}

/** `file:///absolute/dir`; remote hosts are not supported. */
export function fsRootFromUrl(url: URL): string {
  if (url.hostname.length > 0 && url.hostname !== "localhost") {
    throw new Error(`file: blob stores must be local (got host "${url.hostname}")`);
  }
  return decodeURIComponent(url.pathname);
}

export const fileAdapterFactory: AdapterFactory = {
  scheme: "file",
  supports: ["blobs"],
  async create<K extends StoreKind>(kind: K, url: URL): Promise<StoreByKind[K]> {
    if (kind !== "blobs") throw new Error(`file adapter does not support ${kind}`);
    return (await openFsBlobStore({ root: fsRootFromUrl(url) })) as unknown as StoreByKind[K];
  },
};

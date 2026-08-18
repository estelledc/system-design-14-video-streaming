import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_SOURCE_BYTES } from './contracts.js';
import { sha256 } from './crypto.js';
import { DependencyError, IntegrityError, ValidationError } from './errors.js';

const digestPattern = /^[0-9a-f]{64}$/;

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class LocalImmutableObjectStore {
  constructor(root, { maximumObjectBytes = MAX_SOURCE_BYTES + 262_144 } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new ValidationError('object root is required');
    this.root = resolve(root);
    this.maximumObjectBytes = maximumObjectBytes;
  }

  async init() {
    await mkdir(join(this.root, 'objects'), { recursive: true, mode: 0o700 });
  }

  #path(digest) {
    if (!digestPattern.test(digest)) throw new ValidationError('object digest is invalid');
    return join(this.root, 'objects', digest.slice(0, 2), digest);
  }

  async #verifiedBytes(digest) {
    const path = this.#path(digest);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new IntegrityError('Referenced object is missing');
      throw new DependencyError('Object metadata read failed', error);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > this.maximumObjectBytes) {
      throw new IntegrityError('Object type or size is invalid');
    }
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new DependencyError('Object read failed', error);
    }
    if (sha256(bytes) !== digest) throw new IntegrityError();
    return bytes;
  }

  async put(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > this.maximumObjectBytes) {
      throw new ValidationError('object bytes are outside supported bounds');
    }
    await this.init();
    const digest = sha256(bytes);
    const target = this.#path(digest);
    const directory = join(this.root, 'objects', digest.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.pending-${randomUUID()}`);
    let handle;
    let created = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, target);
        created = true;
        await syncDirectory(directory);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await this.#verifiedBytes(digest);
        if (!existing.equals(bytes)) throw new IntegrityError();
      }
      return { created, digest, bytes: bytes.length };
    } catch (error) {
      if (error instanceof IntegrityError || error instanceof ValidationError) throw error;
      throw new DependencyError('Immutable object write failed', error);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      await syncDirectory(directory).catch(() => {});
    }
  }

  async read(digest, expectedBytes) {
    const bytes = await this.#verifiedBytes(digest);
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new IntegrityError();
    return bytes;
  }

  async verify(digest, expectedBytes) {
    await this.read(digest, expectedBytes);
    return true;
  }
}

import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalImmutableObjectStore } from '../../src/object-store.js';
import { IntegrityError, ValidationError } from '../../src/errors.js';

test('concurrent immutable installs converge on one verified object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-object-store-'));
  const store = new LocalImmutableObjectStore(root);
  const bytes = Buffer.alloc(32_768, 42);
  const writes = await Promise.all(Array.from({ length: 16 }, () => store.put(bytes)));
  assert.equal(new Set(writes.map((result) => result.digest)).size, 1);
  assert.equal(writes.filter((result) => result.created).length, 1);
  assert.ok((await store.read(writes[0].digest, bytes.length)).equals(bytes));
  const directory = join(root, 'objects', writes[0].digest.slice(0, 2));
  assert.deepEqual(await readdir(directory), [writes[0].digest]);
});

test('readback detects external corruption at a content-addressed path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-object-corruption-'));
  const store = new LocalImmutableObjectStore(root);
  const stored = await store.put(Buffer.from('trusted synthetic bytes'));
  const path = join(root, 'objects', stored.digest.slice(0, 2), stored.digest);
  await writeFile(path, 'changed');
  await assert.rejects(store.read(stored.digest), IntegrityError);
  await assert.rejects(store.put(Buffer.from('trusted synthetic bytes')), IntegrityError);
});

test('object adapter rejects empty, oversized, and invalid digest inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-object-bounds-'));
  const store = new LocalImmutableObjectStore(root, { maximumObjectBytes: 8 });
  await assert.rejects(store.put(Buffer.alloc(0)), ValidationError);
  await assert.rejects(store.put(Buffer.alloc(9)), ValidationError);
  await assert.rejects(store.read('../escape'), ValidationError);
});

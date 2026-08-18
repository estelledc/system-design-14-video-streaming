import assert from 'node:assert/strict';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { sha256 } from '../../src/crypto.js';
import {
  GoneError,
  IntegrityError,
  LeaseConflictError,
  NotFoundError,
  OffsetConflictError,
  RequestConflictError,
} from '../../src/errors.js';
import { LocalImmutableObjectStore } from '../../src/object-store.js';
import { PostgresVideoRepository } from '../../src/postgres-repository.js';
import { VideoService } from '../../src/video-service.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ownerToken = 'integration-owner-token-0001';
let repository;
let service;
let objectRoot;
let nowMs;

before(async () => {
  await pool.query('SELECT 1');
});

beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  objectRoot = await mkdtemp(join(tmpdir(), 'video-postgres-objects-'));
  repository = new PostgresVideoRepository(pool, new LocalImmutableObjectStore(objectRoot));
  await repository.migrate();
  nowMs = 1_000;
  service = new VideoService(repository, { now: () => nowMs });
});

after(async () => {
  await pool.end();
});

async function openUpload(bytes, key = `upload-${randomUUID()}`, expectedSha256 = sha256(bytes)) {
  return service.openUpload({
    ownerToken,
    idempotencyKey: key,
    request: { expectedBytes: bytes.length, expectedSha256, visibility: 'public' },
  });
}

async function commitBytes(uploadId, bytes, { chunkBytes = 32_768 } = {}) {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
    await service.commitChunk({
      ownerToken,
      uploadId,
      idempotencyKey: `chunk-${String(index).padStart(4, '0')}-${randomUUID()}`,
      offset,
      bytes: Buffer.from(chunk),
    });
    offset += chunk.length;
    index += 1;
  }
}

async function finalizedVideo(bytes, key) {
  const opened = await openUpload(bytes, key);
  await commitBytes(opened.upload.id, bytes);
  const finalized = await service.finalizeUpload({ ownerToken, uploadId: opened.upload.id });
  return { opened, finalized };
}

test('concurrent upload opening converges on one immutable intent', async () => {
  const bytes = Buffer.from('one upload identity');
  const request = {
    ownerToken,
    idempotencyKey: 'concurrent-upload-key-0001',
    request: { expectedBytes: bytes.length, expectedSha256: sha256(bytes), visibility: 'public' },
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => service.openUpload(request)));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.upload.id)).size, 1);
  assert.equal(new Set(results.map((result) => result.upload.videoId)).size, 1);
  await assert.rejects(service.openUpload({
    ...request,
    request: { ...request.request, expectedBytes: bytes.length + 1 },
  }), RequestConflictError);
  const stats = await repository.stats();
  assert.equal(stats.uploads, 1);
  assert.deepEqual(stats.videos, { uploading: 1 });
});

test('chunk offset serialization permits one winner and exact replay only', async () => {
  const bytes = Buffer.from('abcdef');
  const opened = await openUpload(bytes, 'offset-upload-key-0001');
  const first = {
    ownerToken,
    uploadId: opened.upload.id,
    idempotencyKey: 'offset-chunk-key-0001',
    offset: 0,
    bytes: Buffer.from('abc'),
  };
  const competitor = { ...first, idempotencyKey: 'offset-chunk-key-0002' };
  const raced = await Promise.allSettled([
    service.commitChunk(first),
    service.commitChunk(competitor),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => result.status === 'rejected' && result.reason instanceof OffsetConflictError).length, 1);
  const winningInput = raced[0].status === 'fulfilled' ? first : competitor;
  const replay = await service.commitChunk(winningInput);
  assert.equal(replay.created, false);
  assert.equal(replay.offset, 3);
  await assert.rejects(service.commitChunk({ ...winningInput, bytes: Buffer.from('abd') }), RequestConflictError);
  await service.commitChunk({
    ownerToken,
    uploadId: opened.upload.id,
    idempotencyKey: 'offset-chunk-key-0003',
    offset: 3,
    bytes: Buffer.from('def'),
  });
  assert.equal((await service.headUpload({ ownerToken, uploadId: opened.upload.id })).offset, 6);
});

test('full digest gates finalization and job creation atomically', async () => {
  const bytes = Buffer.from('digest-gated source');
  const wrong = await openUpload(bytes, 'wrong-digest-upload-0001', '0'.repeat(64));
  await commitBytes(wrong.upload.id, bytes);
  await assert.rejects(service.finalizeUpload({ ownerToken, uploadId: wrong.upload.id }), IntegrityError);
  assert.equal((await repository.stats()).jobs.queued ?? 0, 0);

  const good = await openUpload(bytes, 'good-digest-upload-0001');
  await commitBytes(good.upload.id, bytes);
  const first = await service.finalizeUpload({ ownerToken, uploadId: good.upload.id });
  const replay = await service.finalizeUpload({ ownerToken, uploadId: good.upload.id });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, first.job.id);
  const stats = await repository.stats();
  assert.equal(stats.jobs.queued, 1);
  assert.equal(stats.renditions.ready ?? 0, 0);
});

test('expired lease recovery fences the stale worker and ready remains invisible', async () => {
  const bytes = Buffer.alloc(150_000, 7);
  const { opened } = await finalizedVideo(bytes, 'lease-video-upload-0001');
  const oldClaim = await repository.claimJob({ nowMs: 1_000, leaseMs: 100, token: 'old-worker-token' });
  assert.equal(await repository.claimJob({ nowMs: 1_099, leaseMs: 100, token: 'too-early-token' }), null);
  await assert.rejects(repository.materializeJob({
    jobId: oldClaim.id,
    token: oldClaim.token,
    now: () => 1_100,
  }), LeaseConflictError);
  const recovered = await repository.claimJob({ nowMs: 1_100, leaseMs: 100, token: 'new-worker-token' });
  assert.equal(recovered.id, oldClaim.id);
  assert.equal(recovered.attempt, 2);
  await assert.rejects(repository.materializeJob({
    jobId: oldClaim.id,
    token: oldClaim.token,
    now: () => 1_050,
  }), LeaseConflictError);
  const ready = await repository.materializeJob({
    jobId: recovered.id,
    token: recovered.token,
    now: () => 1_100,
  });
  assert.equal(ready.changed, true);
  assert.equal(ready.rendition.segmentCount, 3);
  const replay = await repository.materializeJob({
    jobId: recovered.id,
    token: recovered.token,
    now: () => 1_100,
  });
  assert.equal(replay.changed, false);
  await assert.rejects(service.readManifest({ videoId: opened.upload.videoId }), NotFoundError);
  nowMs = 1_200;
  await service.publishVideo({ ownerToken, videoId: opened.upload.videoId });
  const manifest = await service.readManifest({ videoId: opened.upload.videoId });
  assert.equal(manifest.segments.length, 3);
  assert.equal(manifest.totalBytes, bytes.length);
});

test('objects written before ready can be reused after a failed worker attempt', async () => {
  const bytes = Buffer.alloc(80_000, 11);
  await finalizedVideo(bytes, 'orphan-object-upload-0001');
  const first = await repository.claimJob({ nowMs: 2_000, leaseMs: 100, token: 'crashing-worker-token' });
  await assert.rejects(repository.materializeJob({
    jobId: first.id,
    token: first.token,
    now: () => 2_000,
    afterObjects: async () => { throw new Error('simulated worker exit before ready'); },
  }), /simulated worker exit/);
  assert.equal((await repository.stats()).renditions.ready ?? 0, 0);
  const retry = await repository.claimJob({ nowMs: 2_100, leaseMs: 100, token: 'recovered-worker-token' });
  const ready = await repository.materializeJob({ jobId: retry.id, token: retry.token, now: () => 2_100 });
  assert.equal(ready.changed, true);
  assert.equal(ready.objectsCreated, 0);
});

test('a missing referenced segment blocks publication without changing visibility', async () => {
  const bytes = Buffer.alloc(90_000, 13);
  const { opened } = await finalizedVideo(bytes, 'missing-segment-upload-0001');
  const claim = await repository.claimJob({ nowMs: 3_000, leaseMs: 100, token: 'missing-object-worker' });
  await repository.materializeJob({ jobId: claim.id, token: claim.token, now: () => 3_000 });
  const selected = await pool.query(
    `SELECT segment_sha256 FROM rendition_segments ORDER BY segment_index LIMIT 1`,
  );
  const digest = selected.rows[0].segment_sha256;
  await unlink(join(objectRoot, 'objects', digest.slice(0, 2), digest));
  await assert.rejects(service.publishVideo({ ownerToken, videoId: opened.upload.videoId }), IntegrityError);
  await assert.rejects(service.readManifest({ videoId: opened.upload.videoId }), NotFoundError);
  assert.deepEqual((await repository.stats()).videos, { ready: 1 });
});

test('tombstone immediately denies origin manifest and segment reads', async () => {
  const bytes = Buffer.alloc(70_000, 17);
  const { opened } = await finalizedVideo(bytes, 'tombstone-video-upload-0001');
  const claim = await repository.claimJob({ nowMs: 4_000, leaseMs: 100, token: 'publish-worker-token' });
  await repository.materializeJob({ jobId: claim.id, token: claim.token, now: () => 4_000 });
  nowMs = 4_010;
  await service.publishVideo({ ownerToken, videoId: opened.upload.videoId });
  const manifest = await service.readManifest({ videoId: opened.upload.videoId });
  const digest = manifest.segments[0].path.split('/').at(-1);
  assert.ok((await service.readSegment({ videoId: opened.upload.videoId, digest })).bytes.length > 0);
  const first = await service.tombstoneVideo({ ownerToken, videoId: opened.upload.videoId });
  const replay = await service.tombstoneVideo({ ownerToken, videoId: opened.upload.videoId });
  assert.deepEqual({ changed: first.changed, version: first.tombstoneVersion }, { changed: true, version: 1 });
  assert.deepEqual({ changed: replay.changed, version: replay.tombstoneVersion }, { changed: false, version: 1 });
  await assert.rejects(service.readManifest({ videoId: opened.upload.videoId }), GoneError);
  await assert.rejects(service.readSegment({ videoId: opened.upload.videoId, digest }), GoneError);
});

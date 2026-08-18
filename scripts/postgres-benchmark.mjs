import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { sha256 } from '../src/crypto.js';
import { LocalImmutableObjectStore } from '../src/object-store.js';
import { PostgresVideoRepository } from '../src/postgres-repository.js';
import { VideoService } from '../src/video-service.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL benchmark');

function rate(count, started) {
  return Number((count / ((performance.now() - started) / 1_000)).toFixed(3));
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const objectRoot = await mkdtemp(join(tmpdir(), 'video-benchmark-'));
const repository = new PostgresVideoRepository(pool, new LocalImmutableObjectStore(objectRoot));
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
await repository.migrate();

let clock = 1_000;
const service = new VideoService(repository, { now: () => clock });
const ownerToken = 'benchmark-owner-token-0001';
const sourceBytes = 524_288;
const chunkBytes = 8_192;
const source = Buffer.allocUnsafe(sourceBytes);
for (let index = 0; index < source.length; index += 1) source[index] = (index * 31 + 17) & 0xff;
const runId = randomUUID();

const opened = await service.openUpload({
  ownerToken,
  idempotencyKey: `benchmark-upload-${runId}`,
  request: { expectedBytes: source.length, expectedSha256: sha256(source), visibility: 'public' },
});
const chunkCount = Math.ceil(source.length / chunkBytes);
const uploadStarted = performance.now();
for (let index = 0; index < chunkCount; index += 1) {
  const start = index * chunkBytes;
  const bytes = source.subarray(start, Math.min(start + chunkBytes, source.length));
  await service.commitChunk({
    ownerToken,
    uploadId: opened.upload.id,
    idempotencyKey: `benchmark-chunk-${runId}-${String(index).padStart(4, '0')}`,
    offset: start,
    bytes: Buffer.from(bytes),
  });
}
const uploadChunksPerSecond = rate(chunkCount, uploadStarted);

const finalizeStarted = performance.now();
await service.finalizeUpload({ ownerToken, uploadId: opened.upload.id });
const finalizeMilliseconds = Number((performance.now() - finalizeStarted).toFixed(3));

clock = 2_000;
const materializeStarted = performance.now();
const ready = await service.runOneJob({ nowMs: clock, leaseMs: 1_000 });
const materializeMilliseconds = Number((performance.now() - materializeStarted).toFixed(3));
assert.equal(ready.claimed, true);
assert.equal(ready.rendition.segmentCount, 8);

clock = 3_000;
await service.publishVideo({ ownerToken, videoId: opened.upload.videoId });
const manifest = await service.readManifest({ videoId: opened.upload.videoId });
const digests = manifest.segments.map((segment) => segment.path.split('/').at(-1));
const rangeReads = 500;
const readsStarted = performance.now();
for (let index = 0; index < rangeReads; index += 1) {
  const digest = digests[index % digests.length];
  const response = await service.readSegment({
    videoId: opened.upload.videoId,
    digest,
    range: `bytes=${index % 512}-${(index % 512) + 255}`,
  });
  assert.equal(response.status, 206);
  assert.equal(response.bytes.length, 256);
}
const rangeReadsPerSecond = rate(rangeReads, readsStarted);
const version = await pool.query('SHOW server_version');
const stats = await repository.stats();

process.stdout.write(`${JSON.stringify({
  kind: 'postgres_video_publication_benchmark_receipt',
  node: process.versions.node,
  postgres: version.rows[0].server_version,
  sourceBytes,
  chunkBytes,
  chunkCount,
  uploadChunksPerSecond,
  finalizeMilliseconds,
  segments: stats.segments,
  materializeMilliseconds,
  rangeReads,
  rangeReadsPerSecond,
  filesystem: 'runner-local-temporary-directory',
  codecWork: false,
  networkDelivery: false,
})}\n`);

await pool.end();

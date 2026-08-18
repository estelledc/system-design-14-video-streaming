import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { LocalImmutableObjectStore } from '../src/object-store.js';
import { PostgresVideoRepository } from '../src/postgres-repository.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test');

const token = 'video-smoke-owner-token-0001';
const uploadKey = 'video-smoke-upload-key-0001';
const chunkKeys = [
  'video-smoke-chunk-key-0001',
  'video-smoke-chunk-key-0002',
  'video-smoke-chunk-key-0003',
];
const fixtureMarker = 'SYNTHETIC-MEDIA-PRIVATE-FIXTURE';
const fixture = Buffer.alloc(150_000);
for (let offset = 0; offset < fixture.length; offset += 1) {
  fixture[offset] = fixtureMarker.charCodeAt(offset % fixtureMarker.length);
}
const expectedSha256 = createHash('sha256').update(fixture).digest('hex');
const objectRoot = await mkdtemp(join(tmpdir(), 'video-process-smoke-'));

function startProcess(command, extraEnvironment = {}) {
  const child = spawn(process.execPath, ['src/main.js', command], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AUTH_TOKENS_JSON: JSON.stringify([token]),
      HOST: '127.0.0.1',
      OBJECT_ROOT: objectRoot,
      PORT: '0',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  const records = [];
  let stdoutBuffer = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const record = JSON.parse(line);
      records.push(record);
      events.emit('record', record);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, stderr });
    });
  });
  return { child, events, exit, records, hasExited: () => exited };
}

async function waitForRecord(processHandle, kind, timeoutMs = 5_000) {
  const existing = processHandle.records.find((record) => record.kind === kind);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);
    const onRecord = (record) => {
      if (record.kind !== kind) return;
      cleanup();
      resolve(record);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.events.removeListener('record', onRecord);
    };
    processHandle.events.on('record', onRecord);
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.hasExited()) return processHandle?.exit;
  processHandle.child.kill('SIGTERM');
  const result = await processHandle.exit;
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function runCommand(command, environment = {}) {
  const processHandle = startProcess(command, environment);
  const result = await processHandle.exit;
  return { processHandle, result };
}

async function request(baseUrl, path, {
  method = 'GET',
  headers = {},
  json,
  bytes,
} = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: json === undefined ? bytes : JSON.stringify(json),
  });
}

async function startApi(environment = {}) {
  const processHandle = startProcess('serve', environment);
  const ready = await waitForRecord(processHandle, 'api_listening');
  return { processHandle, baseUrl: `http://127.0.0.1:${ready.port}` };
}

const inspectionPool = new Pool({ connectionString: process.env.DATABASE_URL });
await inspectionPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
const inspectionRepository = new PostgresVideoRepository(
  inspectionPool,
  new LocalImmutableObjectStore(objectRoot),
);
await inspectionRepository.migrate();

const processes = [];
try {
  const crashingApi = await startApi({ CLOCK_MS: '1000', CRASH_AFTER_CHUNK_COMMIT: '1' });
  processes.push(crashingApi.processHandle);
  const openedResponse = await request(crashingApi.baseUrl, '/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': uploadKey },
    json: { expectedBytes: fixture.length, expectedSha256, visibility: 'public' },
  });
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  const { upload } = opened;
  const firstChunk = fixture.subarray(0, 65_536);
  await assert.rejects(request(crashingApi.baseUrl, `/v1/uploads/${upload.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/offset+octet-stream',
      'idempotency-key': chunkKeys[0],
      'upload-offset': '0',
    },
    bytes: firstChunk,
  }));
  const apiCrash = await crashingApi.processHandle.exit;
  assert.equal(apiCrash.signal, 'SIGKILL');

  const api = await startApi({ CLOCK_MS: '2000' });
  processes.push(api.processHandle);
  const replayResponse = await request(api.baseUrl, `/v1/uploads/${upload.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/offset+octet-stream',
      'idempotency-key': chunkKeys[0],
      'upload-offset': '0',
    },
    bytes: firstChunk,
  });
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.created, false);
  assert.equal(replay.offset, 65_536);

  const boundaries = [65_536, 131_072, fixture.length];
  for (let index = 1; index < boundaries.length; index += 1) {
    const start = boundaries[index - 1];
    const end = boundaries[index];
    const response = await request(api.baseUrl, `/v1/uploads/${upload.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/offset+octet-stream',
        'idempotency-key': chunkKeys[index],
        'upload-offset': String(start),
      },
      bytes: fixture.subarray(start, end),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).offset, end);
  }

  const finalizedResponse = await request(api.baseUrl, `/v1/uploads/${upload.id}/finalize`, { method: 'POST' });
  assert.equal(finalizedResponse.status, 201);
  assert.equal((await finalizedResponse.json()).evidence, 'source_finalized');
  const beforeReady = await request(api.baseUrl, `/v1/videos/${upload.videoId}/manifest`);
  assert.equal(beforeReady.status, 404);

  const crashingWorker = await runCommand('worker-once', {
    CLOCK_MS: '3000',
    CRASH_AFTER_OBJECTS: '1',
    LEASE_MS: '100',
  });
  processes.push(crashingWorker.processHandle);
  assert.equal(crashingWorker.result.signal, 'SIGKILL');
  const objectsWritten = crashingWorker.processHandle.records.find((record) => record.kind === 'rendition_objects_written');
  assert.equal(objectsWritten.segmentCount, 3);
  const afterObjectCrash = await request(api.baseUrl, `/v1/videos/${upload.videoId}/manifest`);
  assert.equal(afterObjectCrash.status, 404);

  const recoveredWorker = await runCommand('worker-once', {
    CLOCK_MS: '3100',
    LEASE_MS: '100',
  });
  processes.push(recoveredWorker.processHandle);
  assert.equal(recoveredWorker.result.code, 0, recoveredWorker.result.stderr);
  const workerReceipt = recoveredWorker.processHandle.records.find((record) => record.kind === 'worker_once_receipt');
  assert.equal(workerReceipt.attempt, 2);
  assert.equal(workerReceipt.objectsCreated, 0);
  const readyButUnpublished = await request(api.baseUrl, `/v1/videos/${upload.videoId}/manifest`);
  assert.equal(readyButUnpublished.status, 404);
  await stopProcess(api.processHandle);

  const finalApi = await startApi({ CLOCK_MS: '4000' });
  processes.push(finalApi.processHandle);

  const publishResponse = await request(finalApi.baseUrl, `/v1/videos/${upload.videoId}/publish`, { method: 'POST' });
  assert.equal(publishResponse.status, 201);
  assert.equal((await publishResponse.json()).evidence, 'manifest_published');
  const manifestResponse = await request(finalApi.baseUrl, `/v1/videos/${upload.videoId}/manifest`);
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.headers.get('cache-control'), 'private, no-store');
  const manifest = await manifestResponse.json();
  assert.equal(manifest.segments.length, 3);

  const segmentResponse = await request(finalApi.baseUrl, manifest.segments[0].path, {
    headers: { range: 'bytes=1-5' },
  });
  assert.equal(segmentResponse.status, 206);
  assert.equal(segmentResponse.headers.get('content-range'), `bytes 1-5/${manifest.segments[0].bytes}`);
  assert.ok(Buffer.from(await segmentResponse.arrayBuffer()).equals(fixture.subarray(1, 6)));
  const bytesWritten = await waitForRecord(finalApi.processHandle, 'server_bytes_written');
  assert.equal(bytesWritten.bytes, 5);

  const tombstoneResponse = await request(finalApi.baseUrl, `/v1/videos/${upload.videoId}`, { method: 'DELETE' });
  assert.equal(tombstoneResponse.status, 200);
  assert.equal((await tombstoneResponse.json()).tombstoneVersion, 1);
  assert.equal((await request(finalApi.baseUrl, `/v1/videos/${upload.videoId}/manifest`)).status, 410);
  assert.equal((await request(finalApi.baseUrl, manifest.segments[0].path)).status, 410);

  const stats = await inspectionRepository.stats();
  assert.deepEqual(stats.videos, { tombstoned: 1 });
  assert.equal(stats.uploads, 1);
  assert.equal(stats.chunks, 3);
  assert.deepEqual(stats.jobs, { completed: 1 });
  assert.deepEqual(stats.renditions, { published: 1 });
  assert.equal(stats.segments, 3);

  const allLogs = JSON.stringify(processes.flatMap((processHandle) => processHandle.records));
  const sensitiveValues = [
    token,
    uploadKey,
    ...chunkKeys,
    fixtureMarker,
    expectedSha256,
    upload.id,
    upload.videoId,
    objectRoot,
  ];
  for (const secret of sensitiveValues) assert.ok(!allLogs.includes(secret), `structured log leaked: ${secret}`);

  process.stdout.write(`${JSON.stringify({
    kind: 'postgres_video_publication_smoke_receipt',
    apiCrashSignal: apiCrash.signal,
    chunkRetryCreated: replay.created,
    committedOffset: fixture.length,
    workerCrashSignal: crashingWorker.result.signal,
    recoveredAttempt: workerReceipt.attempt,
    reusedReadyObjects: workerReceipt.objectsCreated === 0,
    readyInvisibleBeforePublish: readyButUnpublished.status === 404,
    segmentCount: manifest.segments.length,
    rangeStatus: segmentResponse.status,
    bytesWrittenEvidence: bytesWritten.evidence,
    tombstoneVersion: 1,
    decodeClaims: 0,
    playbackClaims: 0,
    humanViewClaims: 0,
  })}\n`);
} finally {
  for (const processHandle of [...processes].reverse()) await stopProcess(processHandle);
  await inspectionPool.end();
}

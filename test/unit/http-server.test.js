import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { sha256 } from '../../src/crypto.js';
import { createHttpServer } from '../../src/http-server.js';
import { VideoService } from '../../src/video-service.js';

const ownerToken = 'http-owner-token-0001';
const uploadId = '10000000-0000-4000-8000-000000000001';
const videoId = '10000000-0000-4000-8000-000000000002';

async function withServer(run) {
  const digest = sha256('abcdef');
  const repository = {
    async health() { return true; },
    async openUpload() {
      return { created: true, upload: { id: uploadId, videoId, expectedBytes: 6, offset: 0, state: 'uploading' } };
    },
    async headUpload() {
      return { id: uploadId, videoId, expectedBytes: 6, offset: 3, state: 'uploading' };
    },
    async commitChunk(input) {
      return { created: true, offset: input.offset + input.bytes.length, bytes: input.bytes.length };
    },
    async finalizeUpload() {
      return {
        created: true,
        upload: { id: uploadId, videoId, expectedBytes: 6, offset: 6, state: 'finalized' },
        job: { id: '10000000-0000-4000-8000-000000000003', state: 'queued' },
      };
    },
    async publishVideo() {
      return {
        changed: true,
        rendition: { id: '10000000-0000-4000-8000-000000000004', segmentCount: 1 },
      };
    },
    async readManifest() {
      return {
        tombstoneVersion: 0,
        manifest: {
          schemaVersion: 1,
          recipeVersion: 'synthetic-segment-v1',
          totalBytes: 6,
          segments: [{ index: 0, sha256: digest, bytes: 6 }],
        },
      };
    },
    async readSegment() {
      return { bytes: Buffer.from('abcdef'), tombstoneVersion: 0 };
    },
    async tombstoneVideo() {
      return { changed: true, tombstoneVersion: 1 };
    },
  };
  const service = new VideoService(repository, {
    now: () => 1,
    idFactory: (() => {
      const values = [uploadId, videoId];
      return () => values.shift();
    })(),
  });
  const logs = [];
  const server = createHttpServer({
    service,
    authTokens: new Set([ownerToken]),
    health: () => repository.health(),
    logger: (record) => logs.push(record),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, digest, logs });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${ownerToken}`, ...extra };
}

test('owner upload routes keep offsets and evidence distinct', async () => {
  await withServer(async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/v1/uploads`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    const opened = await fetch(`${baseUrl}/v1/uploads`, {
      method: 'POST',
      headers: ownerHeaders({ 'content-type': 'application/json', 'idempotency-key': 'upload-http-key-0001' }),
      body: JSON.stringify({ expectedBytes: 6, expectedSha256: sha256('abcdef'), visibility: 'public' }),
    });
    assert.equal(opened.status, 201);
    assert.equal(opened.headers.get('upload-offset'), '0');
    assert.equal((await opened.json()).evidence, 'upload_opened');

    const head = await fetch(`${baseUrl}/v1/uploads/${uploadId}`, {
      method: 'HEAD',
      headers: ownerHeaders(),
    });
    assert.equal(head.status, 204);
    assert.equal(head.headers.get('upload-offset'), '3');
    assert.equal(head.headers.get('upload-length'), '6');

    const chunk = await fetch(`${baseUrl}/v1/uploads/${uploadId}`, {
      method: 'PATCH',
      headers: ownerHeaders({
        'content-type': 'application/offset+octet-stream',
        'idempotency-key': 'chunk-http-key-0001',
        'upload-offset': '3',
      }),
      body: Buffer.from('def'),
    });
    assert.equal(chunk.status, 201);
    assert.equal(chunk.headers.get('upload-offset'), '6');
    assert.equal((await chunk.json()).evidence, 'upload_chunk_committed');
  });
});

test('public manifest and one range are no-store and do not claim playback', async () => {
  await withServer(async ({ baseUrl, digest, logs }) => {
    const manifest = await fetch(`${baseUrl}/v1/videos/${videoId}/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('cache-control'), 'private, no-store');
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.evidence, 'manifest_response');
    assert.equal(manifestBody.segments[0].path, `/v1/videos/${videoId}/segments/${digest}`);

    const segment = await fetch(`${baseUrl}${manifestBody.segments[0].path}`, {
      headers: { range: 'bytes=2-4' },
    });
    assert.equal(segment.status, 206);
    assert.equal(segment.headers.get('content-range'), 'bytes 2-4/6');
    assert.equal(segment.headers.get('accept-ranges'), 'bytes');
    assert.equal(await segment.text(), 'cde');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(logs.some((record) => record.kind === 'server_bytes_written' && record.bytes === 3));
    assert.ok(!JSON.stringify(logs).includes(ownerToken));
    assert.ok(!JSON.stringify(logs).includes(digest));
    assert.ok(!JSON.stringify(logs).includes('played'));
  });
});

test('multi-range is rejected with no byte-write receipt', async () => {
  await withServer(async ({ baseUrl, digest, logs }) => {
    const response = await fetch(`${baseUrl}/v1/videos/${videoId}/segments/${digest}`, {
      headers: { range: 'bytes=0-1,4-5' },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
    assert.ok(!logs.some((record) => record.kind === 'server_bytes_written'));
  });
});

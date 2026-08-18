import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerFingerprint, sha256 } from '../../src/crypto.js';
import { VideoService } from '../../src/video-service.js';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];

test('upload service hashes owner identity and emits only an opened receipt', async () => {
  let captured;
  const repository = {
    async openUpload(input) {
      captured = input;
      return {
        created: true,
        upload: { id: input.uploadId, videoId: input.videoId, expectedBytes: input.expectedBytes, offset: 0, state: 'uploading' },
      };
    },
  };
  let index = 0;
  const service = new VideoService(repository, { now: () => 123, idFactory: () => ids[index++] });
  const token = 'owner-token-not-for-storage';
  const digest = sha256('fixture');
  const result = await service.openUpload({
    ownerToken: token,
    idempotencyKey: 'upload-request-0001',
    request: { expectedBytes: 7, expectedSha256: digest, visibility: 'public' },
  });
  assert.equal(captured.ownerFingerprint, ownerFingerprint(token));
  assert.ok(!JSON.stringify(captured).includes(token));
  assert.equal(result.evidence, 'upload_opened');
  assert.equal(result.upload.offset, 0);
  assert.ok(!('expectedSha256' in result.upload));
});

test('chunk service binds request identity to offset, bytes, and digest', async () => {
  let captured;
  const repository = {
    async commitChunk(input) {
      captured = input;
      return { created: true, offset: input.offset + input.bytes.length, bytes: input.bytes.length };
    },
  };
  const service = new VideoService(repository, { now: () => 456 });
  const bytes = Buffer.from('chunk');
  const result = await service.commitChunk({
    ownerToken: 'owner-token-not-for-storage',
    uploadId: ids[0],
    idempotencyKey: 'chunk-request-0001',
    offset: 3,
    bytes,
  });
  assert.equal(captured.chunkSha256, sha256(bytes));
  assert.equal(captured.committedAtMs, 456);
  assert.equal(result.evidence, 'upload_chunk_committed');
  assert.deepEqual({ created: result.created, offset: result.offset, bytes: result.bytes }, {
    created: true,
    offset: 8,
    bytes: 5,
  });
});

test('manifest paths are scoped to one video while range output stays server evidence', async () => {
  const digest = 'b'.repeat(64);
  const repository = {
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
  };
  const service = new VideoService(repository);
  const manifest = await service.readManifest({ videoId: ids[0] });
  assert.equal(manifest.segments[0].path, `/v1/videos/${ids[0]}/segments/${digest}`);
  assert.equal(manifest.evidence, 'manifest_response');
  const segment = await service.readSegment({ videoId: ids[0], digest, range: 'bytes=2-4' });
  assert.equal(segment.status, 206);
  assert.equal(segment.bytes.toString(), 'cde');
  assert.equal(segment.evidence, 'server_bytes_written');
  assert.ok(!('played' in segment));
});

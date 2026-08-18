import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SEGMENT_BYTES,
  RECIPE_VERSION,
  parseSingleByteRange,
  validateChunk,
  validateDigest,
  validateLeaseMilliseconds,
  validateSegmentBytes,
  validateStableKey,
  validateUploadIntent,
  validateUuid,
} from './contracts.js';
import { digestJson, ownerFingerprint, sha256 } from './crypto.js';

export class VideoService {
  constructor(repository, {
    now = () => Date.now(),
    idFactory = () => randomUUID(),
    tokenFactory = () => randomUUID(),
  } = {}) {
    this.repository = repository;
    this.now = now;
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
  }

  async openUpload({ ownerToken, idempotencyKey, request }) {
    const intent = validateUploadIntent(request);
    validateStableKey(idempotencyKey);
    const owner = ownerFingerprint(ownerToken);
    const result = await this.repository.openUpload({
      uploadId: this.idFactory(),
      videoId: this.idFactory(),
      ownerFingerprint: owner,
      idempotencyKey,
      requestDigest: digestJson({ owner, ...intent }),
      ...intent,
      createdAtMs: this.now(),
    });
    return { ...result, evidence: 'upload_opened' };
  }

  async headUpload({ ownerToken, uploadId }) {
    return this.repository.headUpload({
      uploadId: validateUuid(uploadId, 'upload ID'),
      ownerFingerprint: ownerFingerprint(ownerToken),
    });
  }

  async commitChunk({ ownerToken, uploadId, idempotencyKey, offset, bytes }) {
    validateUuid(uploadId, 'upload ID');
    validateStableKey(idempotencyKey);
    const chunk = validateChunk({ offset, bytes });
    const chunkSha256 = sha256(chunk.bytes);
    const result = await this.repository.commitChunk({
      uploadId,
      ownerFingerprint: ownerFingerprint(ownerToken),
      idempotencyKey,
      requestDigest: digestJson({ offset: chunk.offset, bytes: chunk.bytes.length, sha256: chunkSha256 }),
      chunkSha256,
      ...chunk,
      committedAtMs: this.now(),
    });
    return { ...result, evidence: 'upload_chunk_committed' };
  }

  async finalizeUpload({ ownerToken, uploadId, afterSourceObject }) {
    const result = await this.repository.finalizeUpload({
      uploadId: validateUuid(uploadId, 'upload ID'),
      ownerFingerprint: ownerFingerprint(ownerToken),
      jobId: this.idFactory(),
      renditionId: this.idFactory(),
      recipeVersion: RECIPE_VERSION,
      segmentBytes: DEFAULT_SEGMENT_BYTES,
      finalizedAtMs: this.now(),
      afterSourceObject,
    });
    return {
      created: result.created,
      upload: result.upload,
      job: { id: result.job.id, state: result.job.state },
      evidence: 'source_finalized',
    };
  }

  async runOneJob({ nowMs = this.now(), leaseMs = 5_000, afterObjects } = {}) {
    validateLeaseMilliseconds(leaseMs);
    const token = this.tokenFactory();
    const job = await this.repository.claimJob({ nowMs, leaseMs, token });
    if (!job) return { claimed: false, evidence: 'no_processing_job' };
    const materialized = await this.repository.materializeJob({
      jobId: job.id,
      token,
      now: this.now,
      afterObjects,
    });
    return {
      claimed: true,
      changed: materialized.changed,
      attempt: job.attempt,
      rendition: {
        id: materialized.rendition.id,
        segmentCount: materialized.rendition.segmentCount,
        totalBytes: materialized.rendition.totalBytes,
        state: materialized.rendition.state,
      },
      objectsCreated: materialized.objectsCreated,
      evidence: 'rendition_ready',
    };
  }

  async publishVideo({ ownerToken, videoId }) {
    const result = await this.repository.publishVideo({
      videoId: validateUuid(videoId, 'video ID'),
      ownerFingerprint: ownerFingerprint(ownerToken),
      publishedAtMs: this.now(),
    });
    return {
      changed: result.changed,
      videoId,
      renditionId: result.rendition.id,
      segmentCount: result.rendition.segmentCount,
      evidence: 'manifest_published',
    };
  }

  async readManifest({ videoId }) {
    validateUuid(videoId, 'video ID');
    const result = await this.repository.readManifest(videoId);
    return {
      videoId,
      schemaVersion: result.manifest.schemaVersion,
      recipeVersion: result.manifest.recipeVersion,
      totalBytes: result.manifest.totalBytes,
      segments: result.manifest.segments.map((segment) => ({
        index: segment.index,
        bytes: segment.bytes,
        path: `/v1/videos/${videoId}/segments/${segment.sha256}`,
      })),
      tombstoneVersion: result.tombstoneVersion,
      evidence: 'manifest_response',
    };
  }

  async readSegment({ videoId, digest, range }) {
    validateUuid(videoId, 'video ID');
    validateDigest(digest, 'segment digest');
    const result = await this.repository.readSegment({ videoId, digest });
    const selected = parseSingleByteRange(range, result.bytes.length);
    return {
      ...selected,
      bytes: result.bytes.subarray(selected.start, selected.end + 1),
      digest,
      totalBytes: result.bytes.length,
      tombstoneVersion: result.tombstoneVersion,
      evidence: 'server_bytes_written',
    };
  }

  async tombstoneVideo({ ownerToken, videoId }) {
    const result = await this.repository.tombstoneVideo({
      videoId: validateUuid(videoId, 'video ID'),
      ownerFingerprint: ownerFingerprint(ownerToken),
      tombstonedAtMs: this.now(),
    });
    return { ...result, videoId, evidence: 'video_tombstoned' };
  }

  static validateRecipe({ segmentBytes }) {
    return { recipeVersion: RECIPE_VERSION, segmentBytes: validateSegmentBytes(segmentBytes) };
  }
}

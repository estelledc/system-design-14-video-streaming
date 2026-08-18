import { buildSyntheticRendition, parseAndVerifyManifest } from './segmenter.js';
import { sha256 } from './crypto.js';
import {
  AppError,
  DependencyError,
  GoneError,
  IntegrityError,
  LeaseConflictError,
  NotFoundError,
  OffsetConflictError,
  RequestConflictError,
  StateConflictError,
} from './errors.js';
import { schemaSql } from './schema.js';

function dependencyFailure(error) {
  return error instanceof AppError ? error : new DependencyError('PostgreSQL operation failed', error);
}

function number(value) {
  return Number(value);
}

function publicUpload(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    expectedBytes: number(row.expected_bytes),
    offset: number(row.committed_offset),
    state: row.state,
  };
}

function publicJob(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    renditionId: row.output_rendition_id,
    sourceSha256: row.source_sha256,
    recipeVersion: row.recipe_version,
    segmentBytes: number(row.segment_bytes),
    state: row.state,
    attempt: number(row.attempt_count),
  };
}

function publicRendition(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    recipeVersion: row.recipe_version,
    manifestSha256: row.manifest_sha256,
    segmentCount: number(row.segment_count),
    totalBytes: number(row.total_bytes),
    state: row.state,
  };
}

export class PostgresVideoRepository {
  constructor(pool, objectStore) {
    this.pool = pool;
    this.objectStore = objectStore;
  }

  async migrate() {
    try {
      await this.objectStore.init();
      await this.pool.query(schemaSql);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async health() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  #classifyUpload(row, requestDigest) {
    if (row.request_digest !== requestDigest) throw new RequestConflictError();
    return { created: false, upload: publicUpload(row) };
  }

  async #uploadAfterRace(ownerFingerprint, idempotencyKey, requestDigest) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM upload_sessions WHERE owner_fingerprint = $1 AND idempotency_key = $2',
        [ownerFingerprint, idempotencyKey],
      );
      if (!result.rows[0]) throw new DependencyError();
      return this.#classifyUpload(result.rows[0], requestDigest);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async openUpload(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT * FROM upload_sessions WHERE owner_fingerprint = $1 AND idempotency_key = $2',
        [input.ownerFingerprint, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const result = this.#classifyUpload(existing.rows[0], input.requestDigest);
        await client.query('COMMIT');
        return result;
      }
      await client.query(
        `INSERT INTO videos (
           id, owner_fingerprint, state, visibility, active_rendition_id,
           tombstone_version, created_at_ms, updated_at_ms
         ) VALUES ($1, $2, 'uploading', $3, NULL, 0, $4, $4)`,
        [input.videoId, input.ownerFingerprint, input.visibility, input.createdAtMs],
      );
      const inserted = await client.query(
        `INSERT INTO upload_sessions (
           id, video_id, owner_fingerprint, idempotency_key, request_digest,
           expected_bytes, expected_sha256, committed_offset, state, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'uploading', $8)
         RETURNING *`,
        [
          input.uploadId,
          input.videoId,
          input.ownerFingerprint,
          input.idempotencyKey,
          input.requestDigest,
          input.expectedBytes,
          input.expectedSha256,
          input.createdAtMs,
        ],
      );
      await client.query('COMMIT');
      return { created: true, upload: publicUpload(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') {
        return this.#uploadAfterRace(input.ownerFingerprint, input.idempotencyKey, input.requestDigest);
      }
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async headUpload({ uploadId, ownerFingerprint }) {
    try {
      const selected = await this.pool.query(
        'SELECT * FROM upload_sessions WHERE id = $1 AND owner_fingerprint = $2',
        [uploadId, ownerFingerprint],
      );
      if (!selected.rows[0]) throw new NotFoundError();
      return publicUpload(selected.rows[0]);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async commitChunk(input) {
    const object = await this.objectStore.put(input.bytes);
    if (object.digest !== input.chunkSha256) throw new IntegrityError();
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT upload.* FROM upload_sessions AS upload
         WHERE upload.id = $1 AND upload.owner_fingerprint = $2 FOR UPDATE`,
        [input.uploadId, input.ownerFingerprint],
      );
      const upload = selected.rows[0];
      if (!upload) throw new NotFoundError();
      const existing = await client.query(
        'SELECT * FROM upload_chunk_requests WHERE upload_id = $1 AND idempotency_key = $2',
        [input.uploadId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== input.requestDigest) throw new RequestConflictError();
        await client.query('COMMIT');
        return {
          created: false,
          offset: number(existing.rows[0].committed_offset),
          bytes: number(existing.rows[0].byte_count),
        };
      }
      if (upload.state !== 'uploading') throw new StateConflictError();
      if (number(upload.committed_offset) !== input.offset) throw new OffsetConflictError();
      const nextOffset = input.offset + input.bytes.length;
      if (nextOffset > number(upload.expected_bytes)) throw new OffsetConflictError();
      await client.query(
        `INSERT INTO upload_chunk_requests (
           upload_id, idempotency_key, request_digest, start_offset,
           byte_count, chunk_sha256, committed_offset, committed_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.uploadId,
          input.idempotencyKey,
          input.requestDigest,
          input.offset,
          input.bytes.length,
          input.chunkSha256,
          nextOffset,
          input.committedAtMs,
        ],
      );
      await client.query(
        'UPDATE upload_sessions SET committed_offset = $2 WHERE id = $1',
        [input.uploadId, nextOffset],
      );
      await client.query('UPDATE videos SET updated_at_ms = $2 WHERE id = $1', [upload.video_id, input.committedAtMs]);
      await client.query('COMMIT');
      return { created: true, offset: nextOffset, bytes: input.bytes.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async finalizeUpload(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT upload.* FROM upload_sessions AS upload
         WHERE upload.id = $1 AND upload.owner_fingerprint = $2 FOR UPDATE`,
        [input.uploadId, input.ownerFingerprint],
      );
      const upload = selected.rows[0];
      if (!upload) throw new NotFoundError();
      if (upload.state === 'finalized') {
        const job = await client.query('SELECT * FROM processing_jobs WHERE video_id = $1', [upload.video_id]);
        await client.query('COMMIT');
        return {
          created: false,
          upload: publicUpload(upload),
          job: publicJob(job.rows[0]),
        };
      }
      if (number(upload.committed_offset) !== number(upload.expected_bytes)) throw new StateConflictError('Upload is incomplete');
      const chunks = await client.query(
        `SELECT start_offset, byte_count, chunk_sha256
         FROM upload_chunk_requests WHERE upload_id = $1 ORDER BY start_offset`,
        [input.uploadId],
      );
      let cursor = 0;
      const buffers = [];
      for (const chunk of chunks.rows) {
        if (number(chunk.start_offset) !== cursor) throw new IntegrityError('Committed chunks are not contiguous');
        const bytes = await this.objectStore.read(chunk.chunk_sha256, number(chunk.byte_count));
        buffers.push(bytes);
        cursor += bytes.length;
      }
      if (cursor !== number(upload.expected_bytes)) throw new IntegrityError('Committed chunks do not cover the source');
      const source = Buffer.concat(buffers, cursor);
      if (sha256(source) !== upload.expected_sha256) throw new IntegrityError('Full source digest does not match intent');
      const stored = await this.objectStore.put(source);
      if (stored.digest !== upload.expected_sha256) throw new IntegrityError();
      await input.afterSourceObject?.({ bytes: source.length });
      await client.query(
        `UPDATE upload_sessions SET state = 'finalized', source_sha256 = $2, finalized_at_ms = $3
         WHERE id = $1`,
        [input.uploadId, stored.digest, input.finalizedAtMs],
      );
      await client.query(
        `INSERT INTO processing_jobs (
           id, video_id, output_rendition_id, source_sha256, recipe_version,
           segment_bytes, state, attempt_count, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, $7)`,
        [
          input.jobId,
          upload.video_id,
          input.renditionId,
          stored.digest,
          input.recipeVersion,
          input.segmentBytes,
          input.finalizedAtMs,
        ],
      );
      await client.query(
        `UPDATE videos SET state = 'queued', updated_at_ms = $2 WHERE id = $1`,
        [upload.video_id, input.finalizedAtMs],
      );
      const updated = await client.query('SELECT * FROM upload_sessions WHERE id = $1', [input.uploadId]);
      const job = await client.query('SELECT * FROM processing_jobs WHERE id = $1', [input.jobId]);
      await client.query('COMMIT');
      return { created: true, upload: publicUpload(updated.rows[0]), job: publicJob(job.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async claimJob({ nowMs, leaseMs, token }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT job.* FROM processing_jobs AS job
         JOIN videos AS video ON video.id = job.video_id
         WHERE video.state <> 'tombstoned'
           AND (job.state = 'queued' OR (job.state = 'processing' AND job.lease_until_ms <= $1))
         ORDER BY job.created_at_ms, job.id
         FOR UPDATE OF job SKIP LOCKED LIMIT 1`,
        [nowMs],
      );
      const job = selected.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return null;
      }
      const updated = await client.query(
        `UPDATE processing_jobs SET state = 'processing', lease_token_hash = $2,
           lease_until_ms = $3, attempt_count = attempt_count + 1
         WHERE id = $1 RETURNING *`,
        [job.id, sha256(token), nowMs + leaseMs],
      );
      await client.query(
        `UPDATE videos SET state = 'processing', updated_at_ms = $2
         WHERE id = $1 AND state IN ('queued', 'processing')`,
        [job.video_id, nowMs],
      );
      await client.query('COMMIT');
      return { ...publicJob(updated.rows[0]), token, leaseUntilMs: nowMs + leaseMs };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async #renditionForJob(jobId) {
    const result = await this.pool.query(
      `SELECT rendition.* FROM processing_jobs AS job
       JOIN renditions AS rendition ON rendition.id = job.output_rendition_id
       WHERE job.id = $1`,
      [jobId],
    );
    if (!result.rows[0]) throw new IntegrityError('Completed job has no rendition');
    return publicRendition(result.rows[0]);
  }

  async materializeJob({ jobId, token, now = () => Date.now(), afterObjects }) {
    const tokenHash = sha256(token);
    const startedAtMs = now();
    let selected;
    try {
      selected = await this.pool.query('SELECT * FROM processing_jobs WHERE id = $1', [jobId]);
    } catch (error) {
      throw dependencyFailure(error);
    }
    const initial = selected.rows[0];
    if (!initial) throw new NotFoundError();
    if (initial.state === 'completed') {
      if (initial.completion_token_hash !== tokenHash) throw new LeaseConflictError();
      return { changed: false, rendition: await this.#renditionForJob(jobId), objectsCreated: 0 };
    }
    if (
      initial.state !== 'processing'
      || initial.lease_token_hash !== tokenHash
      || number(initial.lease_until_ms) <= startedAtMs
    ) throw new LeaseConflictError();

    const source = await this.objectStore.read(initial.source_sha256);
    const artifact = buildSyntheticRendition(source, {
      segmentBytes: number(initial.segment_bytes),
      recipeVersion: initial.recipe_version,
    });
    if (artifact.manifest.sourceSha256 !== initial.source_sha256) throw new IntegrityError();
    let objectsCreated = 0;
    for (const segment of artifact.segments) {
      const stored = await this.objectStore.put(segment.bytes);
      if (stored.digest !== segment.sha256) throw new IntegrityError();
      if (stored.created) objectsCreated += 1;
    }
    const manifestObject = await this.objectStore.put(artifact.manifestBytes);
    if (manifestObject.digest !== artifact.manifestSha256) throw new IntegrityError();
    if (manifestObject.created) objectsCreated += 1;
    await afterObjects?.({ segmentCount: artifact.segments.length, totalBytes: source.length });
    const readyAtMs = now();

    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM processing_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const job = locked.rows[0];
      if (!job) throw new NotFoundError();
      if (job.state === 'completed') {
        if (job.completion_token_hash !== tokenHash) throw new LeaseConflictError();
        await client.query('COMMIT');
        return { changed: false, rendition: await this.#renditionForJob(jobId), objectsCreated };
      }
      if (
        job.state !== 'processing'
        || job.lease_token_hash !== tokenHash
        || number(job.lease_until_ms) <= readyAtMs
      ) throw new LeaseConflictError();
      const video = await client.query('SELECT * FROM videos WHERE id = $1 FOR UPDATE', [job.video_id]);
      if (!video.rows[0] || video.rows[0].state === 'tombstoned') throw new StateConflictError();
      for (const segment of artifact.segments) await this.objectStore.verify(segment.sha256, segment.size);
      await this.objectStore.verify(artifact.manifestSha256, artifact.manifestBytes.length);
      const rendition = await client.query(
        `INSERT INTO renditions (
           id, video_id, recipe_version, source_sha256, manifest_sha256,
           segment_count, total_bytes, state, ready_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', $8) RETURNING *`,
        [
          job.output_rendition_id,
          job.video_id,
          job.recipe_version,
          job.source_sha256,
          artifact.manifestSha256,
          artifact.segments.length,
          source.length,
          readyAtMs,
        ],
      );
      await client.query(
        `INSERT INTO rendition_segments (rendition_id, segment_index, segment_sha256, byte_count)
         SELECT $1, input.segment_index, input.segment_sha256, input.byte_count
         FROM unnest($2::integer[], $3::text[], $4::integer[])
           AS input(segment_index, segment_sha256, byte_count)`,
        [
          job.output_rendition_id,
          artifact.segments.map((segment) => segment.index),
          artifact.segments.map((segment) => segment.sha256),
          artifact.segments.map((segment) => segment.size),
        ],
      );
      await client.query(
        `UPDATE processing_jobs SET state = 'completed', lease_token_hash = NULL,
           lease_until_ms = NULL, completion_token_hash = $2, completed_at_ms = $3
         WHERE id = $1`,
        [jobId, tokenHash, readyAtMs],
      );
      await client.query(
        `UPDATE videos SET state = 'ready', active_rendition_id = NULL, updated_at_ms = $2 WHERE id = $1`,
        [job.video_id, readyAtMs],
      );
      await client.query('COMMIT');
      return { changed: true, rendition: publicRendition(rendition.rows[0]), objectsCreated };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async publishVideo({ videoId, ownerFingerprint, publishedAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT * FROM videos WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE',
        [videoId, ownerFingerprint],
      );
      const video = selected.rows[0];
      if (!video) throw new NotFoundError();
      if (video.state === 'tombstoned') throw new StateConflictError();
      if (video.state === 'published') {
        const existing = await client.query('SELECT * FROM renditions WHERE id = $1', [video.active_rendition_id]);
        await client.query('COMMIT');
        return { changed: false, rendition: publicRendition(existing.rows[0]) };
      }
      if (video.state !== 'ready') throw new StateConflictError();
      const selectedRendition = await client.query(
        `SELECT * FROM renditions WHERE video_id = $1 AND state = 'ready' FOR UPDATE`,
        [videoId],
      );
      const rendition = selectedRendition.rows[0];
      if (!rendition) throw new IntegrityError('Ready video has no ready rendition');
      const segments = await client.query(
        `SELECT segment_index, segment_sha256, byte_count FROM rendition_segments
         WHERE rendition_id = $1 ORDER BY segment_index`,
        [rendition.id],
      );
      const manifestBytes = await this.objectStore.read(rendition.manifest_sha256);
      const manifest = parseAndVerifyManifest(manifestBytes, rendition.manifest_sha256);
      if (manifest.segments.length !== number(rendition.segment_count) || segments.rows.length !== manifest.segments.length) {
        throw new IntegrityError('Manifest and metadata segment counts differ');
      }
      for (const [index, row] of segments.rows.entries()) {
        const item = manifest.segments[index];
        if (
          number(row.segment_index) !== index
          || row.segment_sha256 !== item.sha256
          || number(row.byte_count) !== item.bytes
        ) throw new IntegrityError('Manifest and metadata segments differ');
        await this.objectStore.verify(item.sha256, item.bytes);
      }
      const updated = await client.query(
        `UPDATE renditions SET state = 'published', published_at_ms = $2 WHERE id = $1 RETURNING *`,
        [rendition.id, publishedAtMs],
      );
      await client.query(
        `UPDATE videos SET state = 'published', active_rendition_id = $2, updated_at_ms = $3 WHERE id = $1`,
        [videoId, rendition.id, publishedAtMs],
      );
      await client.query('COMMIT');
      return { changed: true, rendition: publicRendition(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async readManifest(videoId) {
    try {
      const selected = await this.pool.query(
        `SELECT video.state AS video_state, video.tombstone_version,
                rendition.id AS rendition_id, rendition.manifest_sha256
         FROM videos AS video
         LEFT JOIN renditions AS rendition ON rendition.id = video.active_rendition_id
         WHERE video.id = $1`,
        [videoId],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      if (row.video_state === 'tombstoned') throw new GoneError();
      if (row.video_state !== 'published' || !row.rendition_id) throw new NotFoundError();
      const bytes = await this.objectStore.read(row.manifest_sha256);
      const manifest = parseAndVerifyManifest(bytes, row.manifest_sha256);
      return { manifest, tombstoneVersion: number(row.tombstone_version) };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async readSegment({ videoId, digest }) {
    try {
      const selected = await this.pool.query(
        `SELECT video.state AS video_state, video.tombstone_version, segment.byte_count
         FROM videos AS video
         LEFT JOIN rendition_segments AS segment
           ON segment.rendition_id = video.active_rendition_id AND segment.segment_sha256 = $2
         WHERE video.id = $1`,
        [videoId, digest],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      if (row.video_state === 'tombstoned') throw new GoneError();
      if (row.video_state !== 'published' || row.byte_count === null) throw new NotFoundError();
      const bytes = await this.objectStore.read(digest, number(row.byte_count));
      return { bytes, tombstoneVersion: number(row.tombstone_version) };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async tombstoneVideo({ videoId, ownerFingerprint, tombstonedAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM processing_jobs WHERE video_id = $1 FOR UPDATE', [videoId]);
      const selected = await client.query(
        'SELECT * FROM videos WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE',
        [videoId, ownerFingerprint],
      );
      const video = selected.rows[0];
      if (!video) throw new NotFoundError();
      if (video.state === 'tombstoned') {
        await client.query('COMMIT');
        return { changed: false, tombstoneVersion: number(video.tombstone_version) };
      }
      await client.query(
        `UPDATE processing_jobs SET state = 'cancelled', lease_token_hash = NULL, lease_until_ms = NULL
         WHERE video_id = $1 AND state IN ('queued', 'processing')`,
        [videoId],
      );
      const updated = await client.query(
        `UPDATE videos SET state = 'tombstoned', active_rendition_id = NULL,
           tombstone_version = tombstone_version + 1, updated_at_ms = $2
         WHERE id = $1 RETURNING tombstone_version`,
        [videoId, tombstonedAtMs],
      );
      await client.query('COMMIT');
      return { changed: true, tombstoneVersion: number(updated.rows[0].tombstone_version) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async stats() {
    try {
      const [videos, uploads, chunks, jobs, renditions, segments] = await Promise.all([
        this.pool.query('SELECT state, count(*)::integer AS count FROM videos GROUP BY state ORDER BY state'),
        this.pool.query('SELECT count(*)::integer AS count FROM upload_sessions'),
        this.pool.query('SELECT count(*)::integer AS count FROM upload_chunk_requests'),
        this.pool.query('SELECT state, count(*)::integer AS count FROM processing_jobs GROUP BY state ORDER BY state'),
        this.pool.query('SELECT state, count(*)::integer AS count FROM renditions GROUP BY state ORDER BY state'),
        this.pool.query('SELECT count(*)::integer AS count FROM rendition_segments'),
      ]);
      return {
        videos: Object.fromEntries(videos.rows.map((row) => [row.state, row.count])),
        uploads: uploads.rows[0].count,
        chunks: chunks.rows[0].count,
        jobs: Object.fromEntries(jobs.rows.map((row) => [row.state, row.count])),
        renditions: Object.fromEntries(renditions.rows.map((row) => [row.state, row.count])),
        segments: segments.rows[0].count,
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }
}

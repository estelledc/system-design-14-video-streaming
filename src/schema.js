export const schemaSql = `
CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY,
  owner_fingerprint char(64) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('uploading', 'queued', 'processing', 'ready', 'published', 'tombstoned')),
  visibility varchar(16) NOT NULL CHECK (visibility = 'public'),
  active_rendition_id uuid,
  tombstone_version integer NOT NULL DEFAULT 0 CHECK (tombstone_version >= 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK ((state = 'published' AND active_rendition_id IS NOT NULL)
      OR (state <> 'published' AND active_rendition_id IS NULL))
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id uuid PRIMARY KEY,
  video_id uuid NOT NULL UNIQUE REFERENCES videos(id),
  owner_fingerprint char(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  expected_bytes integer NOT NULL CHECK (expected_bytes BETWEEN 1 AND 1048576),
  expected_sha256 char(64) NOT NULL,
  committed_offset integer NOT NULL DEFAULT 0 CHECK (committed_offset >= 0 AND committed_offset <= expected_bytes),
  state varchar(16) NOT NULL CHECK (state IN ('uploading', 'finalized')),
  source_sha256 char(64),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  finalized_at_ms bigint,
  UNIQUE (owner_fingerprint, idempotency_key),
  CHECK ((state = 'uploading' AND source_sha256 IS NULL AND finalized_at_ms IS NULL)
      OR (state = 'finalized' AND source_sha256 IS NOT NULL AND finalized_at_ms IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS upload_chunk_requests (
  upload_id uuid NOT NULL REFERENCES upload_sessions(id),
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 131072),
  chunk_sha256 char(64) NOT NULL,
  committed_offset integer NOT NULL CHECK (committed_offset = start_offset + byte_count),
  committed_at_ms bigint NOT NULL CHECK (committed_at_ms >= 0),
  PRIMARY KEY (upload_id, idempotency_key),
  UNIQUE (upload_id, start_offset)
);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id uuid PRIMARY KEY,
  video_id uuid NOT NULL UNIQUE REFERENCES videos(id),
  output_rendition_id uuid NOT NULL UNIQUE,
  source_sha256 char(64) NOT NULL,
  recipe_version varchar(64) NOT NULL,
  segment_bytes integer NOT NULL CHECK (segment_bytes BETWEEN 1024 AND 262144),
  state varchar(16) NOT NULL CHECK (state IN ('queued', 'processing', 'completed', 'cancelled')),
  lease_token_hash char(64),
  lease_until_ms bigint,
  completion_token_hash char(64),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  completed_at_ms bigint,
  CHECK ((state = 'processing' AND lease_token_hash IS NOT NULL AND lease_until_ms IS NOT NULL
          AND completion_token_hash IS NULL AND completed_at_ms IS NULL)
      OR (state = 'completed' AND lease_token_hash IS NULL AND lease_until_ms IS NULL
          AND completion_token_hash IS NOT NULL AND completed_at_ms IS NOT NULL)
      OR (state IN ('queued', 'cancelled') AND lease_token_hash IS NULL AND lease_until_ms IS NULL
          AND completion_token_hash IS NULL AND completed_at_ms IS NULL))
);

CREATE INDEX IF NOT EXISTS processing_jobs_claim_idx
  ON processing_jobs (state, lease_until_ms, created_at_ms);

CREATE TABLE IF NOT EXISTS renditions (
  id uuid PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES videos(id),
  recipe_version varchar(64) NOT NULL,
  source_sha256 char(64) NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  segment_count integer NOT NULL CHECK (segment_count > 0),
  total_bytes integer NOT NULL CHECK (total_bytes > 0),
  state varchar(16) NOT NULL CHECK (state IN ('ready', 'published')),
  ready_at_ms bigint NOT NULL CHECK (ready_at_ms >= 0),
  published_at_ms bigint,
  UNIQUE (video_id, recipe_version),
  CHECK ((state = 'ready' AND published_at_ms IS NULL)
      OR (state = 'published' AND published_at_ms IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS rendition_segments (
  rendition_id uuid NOT NULL REFERENCES renditions(id),
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  segment_sha256 char(64) NOT NULL,
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 262144),
  PRIMARY KEY (rendition_id, segment_index)
);

CREATE INDEX IF NOT EXISTS rendition_segments_lookup_idx
  ON rendition_segments (rendition_id, segment_sha256);
`;

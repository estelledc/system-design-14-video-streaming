# API contract

## Authentication and common behavior

Mutating and upload-status endpoints require:

```http
Authorization: Bearer <allowlisted-token>
```

The manifest and segment endpoints are public only because v0.1 supports public visibility exclusively. JSON responses and media
responses use `Cache-Control: private, no-store`. Unknown query parameters are rejected. Expected errors contain only a stable
code:

```json
{"error":"invalid_request"}
```

The server never echoes the bearer token, request idempotency key, expected digest, chunk digest, or filesystem path.

## Open an upload

`POST /v1/uploads`

```http
Idempotency-Key: upload-request-0001
Content-Type: application/json
```

```json
{
  "expectedBytes": 150000,
  "expectedSha256": "<64-lowercase-hex>",
  "visibility": "public"
}
```

Returns `201` for creation or `200` for exact replay. `Upload-Offset: 0` is also returned. Reusing the key with changed intent
returns `409 idempotency_conflict`.

## Inspect upload offset

`HEAD /v1/uploads/{uploadId}` returns `204` with:

```http
Upload-Length: 150000
Upload-Offset: 65536
```

This is a tus-like offset shape, not a conforming tus endpoint.

## Commit one chunk

`PATCH /v1/uploads/{uploadId}`

```http
Content-Type: application/offset+octet-stream
Idempotency-Key: chunk-request-0001
Upload-Offset: 65536
```

The body is 1–131,072 opaque bytes. Returns `201` for a new commit or `200` for exact replay, plus the new `Upload-Offset`.

- wrong current offset: `409 offset_conflict`, no offset advance;
- changed body/offset under the same key: `409 idempotency_conflict`;
- wrong content type, malformed header, empty or oversized body: `400 invalid_request`.

An object may have been installed before a rejected database transition. That orphan is not publication evidence.

## Finalize source

`POST /v1/uploads/{uploadId}/finalize` with an empty body.

Returns `201` when full length/digest validation and job creation commit, or `200` for state replay. An incomplete source returns
`409 state_conflict`; a complete but digest-mismatched source returns `422 integrity_failed` and creates no job.

## Publish a ready rendition

`POST /v1/videos/{videoId}/publish` with an empty body.

Returns `201` for the first atomic publication or `200` for replay. A queued/processing video returns `409 state_conflict`. Missing
or mismatched manifest/segment bytes return `422 integrity_failed` without activating the rendition.

## Read manifest

`GET /v1/videos/{videoId}/manifest`

```json
{
  "videoId": "<uuid>",
  "schemaVersion": 1,
  "recipeVersion": "synthetic-segment-v1",
  "totalBytes": 150000,
  "segments": [
    {"index":0,"bytes":65536,"path":"/v1/videos/<uuid>/segments/<digest>"}
  ],
  "tombstoneVersion": 0,
  "evidence": "manifest_response"
}
```

Uploading, queued, processing, and ready videos return `404`; ready is intentionally invisible. Tombstoned videos return `410`.
The JSON is an API projection of the canonical internal manifest, not HLS or DASH.

## Read segment bytes

`GET /v1/videos/{videoId}/segments/{sha256}`

Without `Range`, returns `200` and the complete active segment. One range can be closed, open-ended, or suffix form:

```http
Range: bytes=1024-2047
```

A valid partial response returns:

```http
206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 1024-2047/65536
Content-Length: 1024
ETag: "<segment-sha256>"
Cache-Control: private, no-store
```

Multiple/malformed ranges return `400`; an unsatisfiable range returns `416` with `Content-Range: bytes */<total>`. A digest that
does not belong to the active rendition returns `404`. Tombstone returns `410`.

The response callback produces a structured `server_bytes_written` receipt. No response header claims playback.

## Tombstone video

`DELETE /v1/videos/{videoId}`

Returns `200`. The first call reports `changed: true` and increments `tombstoneVersion`; exact state replay reports
`changed: false`. Later origin manifest/segment authority observations return `410`.

This is logical denial, not object erasure, CDN purge, legal deletion, or proof that a prior recipient discarded bytes.

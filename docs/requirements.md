# Requirements

## Problem statement

An authenticated creator uploads one bounded synthetic source in resumable pieces. A background worker converts those bytes into
an ordered set of immutable segments. A public reader must see either no video or one completely published manifest whose every
segment is present and verified.

This is a lifecycle and publication experiment. The bytes are not a real codec stream, and the reader is an HTTP client rather
than a media player.

## Executable limits

| Input | v0.1 bound |
|---|---:|
| source bytes | 1–1,048,576 |
| one upload chunk | 1–131,072 bytes |
| upload idempotency key | 16–128 restricted ASCII characters |
| chunk idempotency key | 16–128 restricted ASCII characters |
| synthetic segment size | 1,024–262,144 bytes; implementation recipe uses 65,536 |
| segment range | zero or one RFC-style byte range |
| JSON request body | 2,048 bytes |
| worker lease | 50–60,000 ms through the service boundary |

The source chapter's product-scale numbers are design prompts only. These bounds are deliberately small enough to execute file
sync, digest, database transaction, process-crash, and readback checks in CI.

## Functional requirements

1. Open or exactly replay an upload with expected byte count, full SHA-256, and public visibility.
2. Discover the committed upload offset through `HEAD`.
3. Commit one chunk only at the current offset; exact request replay returns the original offset.
4. Finalize only after all bytes are represented by contiguous committed chunks and the assembled full digest matches.
5. Enqueue one frozen synthetic recipe in the same PostgreSQL transaction that finalizes the upload.
6. Claim expired work with a new lease token and fence every older token.
7. Install content-addressed source, segment, and canonical manifest objects without overwriting an existing digest path.
8. Commit a ready rendition only after every object is present and verified.
9. Keep a ready rendition invisible until its owner explicitly publishes it.
10. Return one manifest only for a currently published video and one segment only if it belongs to that active rendition.
11. Support a full segment response or one satisfiable byte range with strong digest ETag.
12. Commit an idempotent tombstone that immediately denies new origin manifest and segment reads.
13. Emit bounded structured receipts without credentials, idempotency keys, owner identity, media bytes, object paths, or full
    object identifiers.

## State transitions

```text
video:  uploading -> queued -> processing -> ready -> published -> tombstoned
                    ^             |
                    +-- expired lease recovery

upload: uploading -> finalized
job:    queued -> processing -> completed
          |          |
          +----------+-> cancelled by tombstone
rendition: ready -> published
```

Object existence is not a lifecycle state. An unreferenced immutable object is an orphan eligible for future reconciliation; it
cannot make a video ready or published.

## Correctness invariants

1. Owner plus upload idempotency key binds one immutable expected length/digest/visibility intent.
2. One upload row lock serializes offset advancement. Mismatch leaves the offset unchanged.
3. Chunk request identity binds start offset, byte count, and chunk digest. Changed replay conflicts.
4. Chunk/source object creation precedes its metadata reference. A database row never points at bytes that this process has not
   synced and read-verified.
5. Finalization commits source identity, upload state, video state, and processing job together.
6. One job freezes source digest, recipe version, segment size, and output rendition identity.
7. Only the hash of the current token plus an unexpired lease may commit. Recovery changes the hash; old work cannot win later.
8. Synthetic segmentation covers each source byte exactly once in order. Repeated equal segments may share one content object but
   remain separate manifest positions.
9. Manifest bytes are canonical and immutable. Their digest binds recipe, source, total bytes, segment size, ordering, sizes, and
   segment digests.
10. All manifest and segment objects are verified before `ready`, then reverified before `published`.
11. `ready` has no active pointer. Publication changes rendition state, video state, and active rendition in one transaction.
12. A read makes one PostgreSQL authority observation. A tombstone committed before that statement yields `410`; a later
    concurrent tombstone may race a response already authorized by the earlier observation.
13. Mutable lookup and segment delivery use `private, no-store`; this slice makes no external cache purge claim.
14. `server_bytes_written` is a Node response callback, not client receipt, durable storage, decode, playback, screen display,
    audibility, attention, or a human view.

## Evidence vocabulary

| Receipt | Maximum supported claim | Explicitly excluded |
|---|---|---|
| `upload_opened` | server accepted or replayed one upload intent | any media bytes accepted |
| `upload_chunk_committed` | one chunk metadata reference and offset committed after object install | full source completeness |
| `source_finalized` | full digest verified and one job transaction committed | rendition readiness |
| `rendition_ready` | all synthetic objects and one ready metadata set committed | viewer visibility |
| `manifest_published` | one active complete manifest selected | CDN propagation or playback |
| `manifest_response` | server returned one active manifest representation | segment fetch or decode |
| `server_bytes_written` | Node completed its response write callback | remote receipt or human outcome |
| `video_tombstoned` | origin authority denies later observations | physical erasure or cache purge |

## Non-functional requirements

- All mutating owner endpoints require an allowlisted bearer token; the database stores only its SHA-256 domain-separated
  fingerprint.
- Database operations use parameterized SQL and bounded transactions.
- Filesystem paths derive only from validated server-generated digests/UUIDs, never a client filename.
- CI executes Node 22/24/26, PostgreSQL 17.6, real filesystem operations, no skipped tests, dependency audit, process `SIGKILL`,
  and a bounded benchmark.
- No performance threshold converts shared-runner wall time into a correctness gate.

## Not implemented

Parallel multipart upload, direct pre-signed storage access, upload expiration, orphan collection, real transcoding, codec/media
validation, HLS/DASH, quality ladders, thumbnails, subtitles, DRM, moderation, malware scanning, copyright workflows, private or
paid access, CDN, signed delivery, cache purge, recommendations, comments, analytics, multi-region replication, backup restore,
production deployment, and user/client outcome instrumentation.

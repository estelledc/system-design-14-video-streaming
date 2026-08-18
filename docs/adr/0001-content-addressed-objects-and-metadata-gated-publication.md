# ADR 0001: Content-addressed objects and metadata-gated publication

## Status

Accepted for v0.1.

## Context

Uploading bytes, producing derived segments, updating metadata, and distributing through a cache are separate effects. A file can
exist without being complete, a completion message can be duplicated or arrive before a CDN object, and a crashed worker can
finish after another worker has recovered its task. Treating any one of those effects as “the video is ready” creates partial
manifests, overwritten work, or stale-worker publication.

The fixed chapter exposes the right data-plane/control-plane split and retryable processing shape, but it does not define the
atomic join. The first executable slice needs one authority and one visibility transition.

## Decision

Use PostgreSQL 17.6 as the lifecycle authority and a bounded local filesystem adapter as immutable object storage.

1. A creator opens one upload with an immutable expected length and full SHA-256 digest. A stable owner/idempotency key binds that
   intent.
2. Each request body is hashed and installed as a content-addressed immutable chunk before a PostgreSQL transaction advances the
   upload's contiguous offset. Exact request replay returns the committed offset; gaps, overlaps, and changed intent conflict.
3. Finalization locks the upload, verifies contiguous chunk rows, reconstructs the bounded source, checks its full digest, installs
   one immutable source object, and enqueues one processing job in the same metadata transaction. A crash can leave an unreferenced
   object, never a falsely finalized upload.
4. The job freezes recipe version and segment size. Claiming sets a random token and expiry. Only the current, unexpired token may
   commit the deterministic rendition; recovery replaces the token and fences a late worker.
5. A worker writes all segments and a canonical manifest before its `ready` transaction. That transaction verifies the current
   token and records the ordered segment set and manifest digest atomically.
6. `ready` is not viewer-visible. An authenticated owner explicitly publishes a verified rendition in one transaction, selecting
   the active manifest and changing the video state together.
7. Manifest and segment requests check the current published video and active rendition in one database statement before reading
   immutable bytes. A tombstone clears publication authority and cancels pending work.
8. v0.1 returns `Cache-Control: private, no-store` for both manifest and segments. It supports zero or one bounded byte range and
   labels the response callback `server_bytes_written`.

The filesystem adapter writes a unique temporary file, syncs it, installs the complete inode through an exclusive hard link at the
digest path, syncs the containing directory, and verifies existing/read objects. This is a tested POSIX-like local behavior, not a
portable object-store abstraction.

## Why sequential chunks instead of parallel multipart

Parallel upload requires part identity, replacement rules, a completion list, incomplete-part expiration, concurrent completion,
and a whole-object checksum contract. Those are valuable, but they are a second state machine. One offset is enough to execute
response-loss recovery, integrity, and publication while keeping WIP bounded. A later multipart version must replace this protocol
explicitly rather than smuggling parallel writes behind the same endpoint.

## Why a canonical JSON manifest instead of HLS

The repository does not encode media. Emitting HLS tags around arbitrary bytes would falsely imply codec, timing, continuity, and
player compatibility. Canonical JSON proves only ordered immutable object publication. Its schema is private to this lab and must
not be called HLS or DASH.

## Alternatives rejected

- **Update metadata when upload starts:** exposes an object before length/digest completion and makes retries ambiguous.
- **Publish on a completion queue event:** a message cannot prove every referenced object exists, and duplicate/out-of-order
  delivery needs its own inbox and reconciliation.
- **Overwrite a stable output filename:** permits concurrent workers or recipes to replace bytes behind an already cached URL.
- **Use a timestamp/worker ID without a lease token:** a recovered worker cannot fence an older process that resumes late.
- **Auto-publish when processing completes:** removes the observable `ready` boundary and the owner decision needed by this slice.
- **Long-lived public immutable caching immediately:** conflicts with the promised read-time tombstone absent signed expiry or
  measured purge.
- **Implement a generic DAG/resource manager:** one real transformation has no second consumer for that abstraction.

## Consequences

### Positive

- Partial output can exist without becoming visible.
- Exact retries reuse immutable objects and stable metadata results.
- Worker recovery has an executable stale-token counterexample.
- Manifest identity and segment ordering are deterministic.
- The read path has one metadata authority and an honest delivery receipt.

### Costs and limits

- Finalization holds one upload row lock while reading a bounded fixture; this does not scale to real media sizes.
- Sequential upload gives up part-level parallelism.
- PostgreSQL and the local object directory share no distributed transaction; orphan objects require later mark-and-sweep cleanup.
- No-store delivery gives up CDN efficiency to preserve the origin tombstone contract.
- Synthetic segmentation says nothing about valid media, transcoding quality, or playback.
- The tested process/fsync path does not prove power-loss, disk-controller, remote-filesystem, or multi-host durability.

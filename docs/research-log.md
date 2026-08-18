# Research log

## Evidence boundary

The secondary chapter is fixed at repository commit `9d8388721e7231442763ad37398b8d82224aa68f`, chapter tree
`242f222b90d7aee225bd59529d60d61b56576ca7`, and `Readme.md` blob
`2ff3c6c2f57513414d607803da84f4566f8901c6`. That tree has no detected license, so this repository contains only independent
analysis and implementation. It does not copy the chapter's prose, diagrams, or code.

Public specifications and vendor documentation are used to check mechanisms, not to claim the future implementation is a
conforming tus, S3, HLS, CDN, or production video service.

## Closed-book comparison

| Question | Closed-book decision | Fixed chapter | Result for v0.1 |
|---|---|---|---|
| product slice | resumable creator upload, background processing, explicit publication, bounded viewer reads | upload and watch video | keep the narrow upload-to-published-read slice |
| upload | one contiguous durable offset with exact replay | recommends parallel chunks and nearby upload centers | implement a tus-like sequential offset first; parallel parts remain a separate protocol |
| source integrity | declared size plus full SHA-256 before processing | max size and original blob storage, without a completion checksum contract | retain explicit full-object verification |
| processing | one deterministic synthetic segmentation recipe with a fenced durable job | preprocessing, DAG scheduler, resource manager, specialized workers, temporary storage | preserve retryable durable work but do not imitate a DAG with one real task |
| readiness | all immutable objects verified before one metadata publication transaction | transcoded storage/CDN and completion-event paths proceed separately | add the missing join; a completion message alone cannot publish |
| delivery | origin-gated manifest and one bounded byte range | direct CDN streaming via HLS, DASH, or HDS | implement HTTP byte delivery only; do not label the custom manifest HLS/DASH |
| deletion | read-time tombstone at the origin | not specified | use `private, no-store`; public immutable caching is deferred until purge/TTL semantics exist |
| evidence | separate upload, ready, published, server write, and client/human outcomes | “watch” and “stream” are used at product level | keep the narrower executable receipt vocabulary |

## What the chapter contributes

- Original and transcoded bytes belong in blob/object storage; interaction and media metadata belong on a separate control path.
- Transcoding supports compatibility and adaptive-quality choices and is expensive enough to justify asynchronous work.
- A DAG can express independent video, audio, thumbnail, and watermark stages and allow parallel workers.
- Persisted intermediate data can prevent a failed task from restarting all expensive work.
- Large uploads benefit from resumable chunks; upload centers can be located nearer creators.
- A CDN is a distinct read data plane, while pre-signed URLs can reduce API-server byte handling.
- Popularity, geography, and on-demand encoding are cost-control inputs rather than correctness rules.

These are useful architecture directions. The v0.1 repository selects one lifecycle invariant instead of creating placeholder
implementations for every box.

## Defects and missing contracts in the fixed chapter

1. **Upload and metadata have no join.** The client is shown writing the original object and metadata in parallel, but there is no
   stable upload identity, idempotency rule, checksum, or transaction that decides when both agree. This permits orphan metadata,
   orphan objects, and changed-intent retries.
2. **Completion can race availability.** Transcoded bytes move toward storage/CDN while a separate completion event updates
   metadata. The chapter does not require every referenced object to be durable/readable before metadata becomes viewable.
3. **Retry is a verb, not a protocol.** Recoverable errors are said to retry, but task identity, lease expiration, attempt fencing,
   duplicate completion, poison input, retry budget, and terminal state are unspecified.
4. **A queue does not make two effects atomic.** No outbox, inbox idempotency, lineage, or reconciliation is defined between object
   creation, completion publication, metadata update, and CDN distribution.
5. **Playlist/version consistency is absent.** HLS/DASH are named, but manifest identity, segment completeness, atomic update,
   cache validators, range responses, and rollback are not defined.
6. **Deletion and access revocation are absent.** Long-lived CDN objects conflict with immediate privacy, moderation, or owner
   deletion unless TTL, signed access, purge, or origin authorization is explicit.
7. **Pre-signed URL scope is overstated if read as safety.** It can authorize a bounded storage operation, but does not itself
   prove byte integrity, ownership metadata, upload completion, safe media, or publication.
8. **The storage estimate omits an upload-rate assumption.** `150 TB/day` at `300 MB/video` implies about 500,000 uploads/day,
   but that input is not stated. The CDN arithmetic is internally reproducible only if every one of 25 million daily watches
   transfers the full 300 MB at the quoted price; duration, partial viewing, quality, cache tier, region, and pricing date are
   omitted.
9. **“Transcoding reduces storage” is not generally true.** Compression can reduce one representation, while retaining an
   original plus multiple renditions can increase total stored bytes. Compatibility, egress, and quality trade-offs need separate
   accounting.
10. **Historical product statistics lack source bindings.** The 2019/2020 values are not current requirements and are not used as
    facts by this repository.

## Primary-source corrections

### Resumable upload is an offset state machine

The [tus 1.0.x protocol](https://tus.io/protocols/resumable-upload.html) defines `HEAD` offset discovery, requires a patch offset to
equal the server's current offset, returns `409 Conflict` without modification on mismatch, and advances the offset by exactly the
accepted byte count. Its checksum extension keeps the offset unchanged when a chunk checksum fails.

v0.1 adopts those invariants but not the protocol name: its creation/authentication/error surface is smaller and has not passed a
tus conformance suite. Parallel parts are intentionally deferred.

### Multipart completion is a separate commit boundary

Amazon S3's official [multipart-upload documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
distinguishes initiation, independently uploaded parts, and explicit completion. It warns that in-progress parts persist and cost
money until completion or abort, that part numbers/ETags must be retained, and that the combined ETag is not necessarily a full
object MD5. A supplied full-object checksum is separately validated.

S3 [conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) can prevent overwriting an
existing key with `If-None-Match: *`, but concurrent completion/delete cases can return `409` or `412`, and in-progress multipart
uploads are not existing completed objects. These are S3-specific behaviors, not generic filesystem guarantees.

The local adapter therefore uses a content digest as identity, an exclusive same-filesystem link to install a fully synced temp
file, and verification on both an existing object and every read. It claims only the tested local filesystem behavior.

### A VOD playlist is not an arbitrary mutable document

[RFC 8216](https://www.rfc-editor.org/rfc/rfc8216) says a media playlist identifies ordered media segments, requires playlist
changes to be atomic from the client point of view, and states that a VOD playlist must not change. It is an informational HLS
specification, not proof that an arbitrary JSON list is HLS.

v0.1 uses an immutable canonical JSON manifest solely to test the same complete, ordered publication property. It makes no codec,
timestamp-continuity, HLS, adaptive-bitrate, or playback-conformance claim.

### HTTP range and cache behavior need explicit limits

[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) defines byte ranges, `206 Partial Content`, `Content-Range`, `416 Range Not
Satisfiable`, and permits rejecting suspicious or inefficient multi-range requests. v0.1 supports at most one validated byte range
and rejects multiple ranges before filesystem work.

[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) separates private and shared caches and defines `no-store`; it also allows stale
serving only in specified circumstances. [RFC 8246](https://www.rfc-editor.org/rfc/rfc8246) makes `immutable` apply only during a
response's freshness lifetime and warns about cache-corruption amplification.

A long-lived public immutable segment and immediate tombstone revocation are incompatible without another mechanism. v0.1 picks
origin authority and returns `private, no-store`. A later CDN design must choose and test signed expiry, purge latency, or a
documented residual-access window.

### Database and filesystem operations have narrower meanings

PostgreSQL 17 [row-level locking](https://www.postgresql.org/docs/17/explicit-locking.html) blocks competing writers/lockers and
releases at transaction end. It can deadlock, so the implementation locks one upload/video/job aggregate in a consistent order and
does not hold multiple aggregates. A lease token remains an application fence, not a PostgreSQL lock that survives a transaction.

Node 22.23.2 [`fs` documentation](https://nodejs.org/download/release/v22.23.2/docs/api/fs.html) states that
`filehandle.sync()` requests flushing to the storage device but that behavior is operating-system/device specific. It also warns
against check-then-open races and documents exclusive `x` flags. The adapter records successful sync/link/readback operations; it
does not claim power-loss durability, network-filesystem correctness, or S3 equivalence.

The moving `latest-v22.x` documentation URL failed the verified fetch route; the versioned 22.23.2 URL succeeded. Only the verified
versioned content is used above.

## Decisions after comparison

- Keep one sequential upload offset and chunk-level immutable objects. This is smaller than parallel multipart upload and makes
  response-loss recovery executable.
- Assemble and verify the bounded source inside the finalization transition; an orphan content-addressed object is safe to reuse
  and later garbage-collect, but never proves metadata completion.
- Use one durable processing job and deterministic synthetic segmentation, not an unexecuted DAG abstraction.
- Write every segment and the manifest before committing `ready`; require explicit owner publication after `ready`.
- Use PostgreSQL row locks plus random lease tokens and lease expiry for stale-worker fencing.
- Gate both manifest and segment reads through the current video state and return `private, no-store`.
- Call a successful response callback `server_bytes_written`, never playback or viewing.

## Remaining unknowns

- Power-loss behavior of the specific filesystem/device and directory-entry persistence beyond the executed CI process crashes.
- A production multipart protocol, direct-to-object-store credential scope, incomplete-part lifecycle, and reconciliation.
- Real codec validation, GOP boundaries, audio/video timestamp continuity, adaptive-bitrate ladders, and player compatibility.
- CDN signed URLs, cache-key isolation, purge propagation, origin shielding, and post-deletion residual access.
- Moderation, malware scanning, copyright rights, privacy/legal deletion, and production disaster recovery.

# Closed-book contract: atomic video publication

## Evidence status

This contract was written from the case title alone, before reading the fixed chapter or implementation. All scale values are
explicit design assumptions, not claims about YouTube or any current service. Later research must record confirmations,
contradictions, additions, and discarded assumptions instead of silently rewriting this baseline.

## User behavior

The v0.1 system serves two roles:

1. An authenticated creator opens one upload, sends bounded byte ranges, finalizes an expected byte length and SHA-256 digest,
   and requests publication.
2. An unauthenticated viewer fetches the currently published streaming manifest and immutable segments for a public video.

A background worker converts the accepted source into a deterministic synthetic segmented rendition. “Synthetic” is important:
the first slice validates lifecycle and publication correctness, not codec quality or real transcoding.

## Scope

- resumable, ordered upload into one source object;
- exact request replay and conflict for changed intent;
- finalize only after expected length and digest match;
- durable asynchronous processing job with lease token and retry;
- immutable segment objects plus a content-addressed manifest;
- one atomic metadata transition that makes the complete rendition visible;
- bounded manifest and segment reads with correct cache/range semantics;
- creator tombstone that denies new reads immediately while physical object cleanup may lag;
- structured receipts that omit media and identity-bearing values.

## Non-goals

- real codec decode/encode, quality ladders, thumbnails, subtitles, live streaming, premieres, or ads;
- search, recommendations, subscriptions, comments, likes, notifications, analytics, watch history, or creator payments;
- collaborative editing, DRM, watermarking, copyright adjudication, malware detection, or content moderation;
- CDN control planes, multi-region replication, origin shielding, peer-to-peer delivery, or production capacity;
- proving a browser decoded, displayed, played, heard, selected, liked, or understood anything.

## Assumed scale for design pressure

The executable fixture will be tiny. The architecture discussion uses these hypothetical inputs only to expose pressure:

- 5 million daily viewers, 20 playback starts per viewer/day: 100 million manifest reads/day, about 1,157 average/s;
- a declared 10x peak: about 11,574 manifest reads/s;
- 100,000 uploads/day averaging 500 MiB: about 48.8 TiB source bytes/day;
- three derived copies averaging 1.2x the source total: about 58.6 TiB derived bytes/day;
- 10-minute videos with 4-second segments: roughly 150 segment identities per rendition;
- a 30-day metadata horizon at 1 KiB per video record is small compared with media bytes; object lifecycle dominates storage.

These assumptions are not a capacity plan. The implementation must publish raw benchmark inputs and results without extrapolating
them to the numbers above.

## State and authority

PostgreSQL is the initial metadata authority. A local object directory emulates an immutable object store for deterministic CI.
Neither a filename nor the presence of derived bytes makes a video viewable.

```text
uploading -> uploaded -> processing -> ready -> published -> tombstoned
                |            |          |
                +------ retry/fenced worker ------+
```

The exact implementation may split these states, but it must keep three identities separate:

- upload identity: creator + stable upload idempotency key + immutable declared intent;
- processing identity: video + rendition recipe version + attempt lease token;
- publication identity: immutable manifest digest selected by one metadata transaction.

## Data model sketch

- `videos`: video ID, owner fingerprint, state, visibility, active manifest, tombstone version, timestamps;
- `upload_sessions`: expected length/digest, current durable offset, stable request digest, finalized source object digest;
- `upload_chunks`: request identity, offset, length, digest, committed result for exact replay;
- `processing_jobs`: recipe, state, lease token, expiry, attempts, source digest, result manifest digest;
- `renditions`: immutable manifest digest, ordered segment digests/sizes, build receipt;
- object directory: content-addressed immutable source, segment, and manifest bytes.

Object paths and raw creator identities must not appear in public responses or structured logs.

## Required invariants

1. **Immutable upload intent:** reusing an upload idempotency key with changed owner, expected length, or expected digest conflicts.
2. **Contiguous durable offset:** a chunk can advance only from the committed offset. Exact replay returns the original result;
   overlaps, gaps, changed bytes, or oversized chunks fail without advancing.
3. **Integrity before processing:** finalization succeeds only when the durable byte count and full-object SHA-256 equal the
   declared intent. A database row alone cannot certify source bytes.
4. **Immutable objects:** one content digest identifies one byte sequence. Existing bytes must be verified, never overwritten.
5. **Fenced processing:** only the current unexpired lease token may commit or fail a job. A late worker cannot publish after its
   lease is recovered by another worker.
6. **Complete-before-visible:** every manifest-referenced segment must exist with the recorded digest and size before the
   publication transaction selects that manifest.
7. **Atomic publication:** readers observe either no published manifest or one complete immutable manifest; never a mixture of
   old metadata, new segment list, missing objects, or a merely `ready` rendition.
8. **Retry-stable recipe:** retrying the same video/recipe reuses its durable result or reconstructs the same manifest digest;
   it does not silently change segmentation parameters.
9. **Read-time authority:** a tombstone committed before a read's authority observation denies manifest and segment access even
   if immutable bytes still exist on disk or in an external cache.
10. **Bounded reads:** manifest size, segment size, range count, and requested byte interval are bounded before allocation/read.
11. **Cache separation:** immutable published segments may be publicly cacheable by digest; mutable video-to-manifest lookup and
    tombstone-sensitive responses require a separately defined freshness policy.
12. **Evidence honesty:** `upload_chunk_committed`, `source_finalized`, `rendition_ready`, `manifest_published`, and
    `server_bytes_written` are distinct. None implies decode, playback, screen display, audibility, attention, or a human view.
13. **Log minimization:** structured logs contain event kinds, sizes, versions, durations, states, and opaque counts—not tokens,
    owner IDs, titles, byte content, upload keys, object paths, or full manifest/segment identifiers.

## API sketch

- `POST /v1/uploads`: authenticate creator; open or exactly replay an upload intent;
- `PUT /v1/uploads/{id}/chunks`: authenticate owner; require expected offset and request identity; commit bounded bytes;
- `POST /v1/uploads/{id}/finalize`: verify length/digest and enqueue processing atomically;
- `POST /v1/videos/{id}/publish`: owner selects only a verified ready rendition;
- `DELETE /v1/videos/{id}`: commit a monotonic tombstone and deny future reads;
- `GET /v1/videos/{id}/manifest`: resolve one current published manifest or deny;
- `GET /v1/segments/{digest}`: serve immutable bytes, optionally one validated byte range.

The processing worker is an operator process, not a public endpoint.

## Failure windows to execute

| Failure | Required observation |
|---|---|
| response lost after chunk commit | exact retry returns the same offset; bytes are not appended twice |
| crash after upload bytes sync but before metadata advance | recovery reconciles or quarantines the tail; it never certifies unknown bytes |
| wrong final digest | upload remains non-processable and no job becomes runnable |
| worker lease expires during processing | recovered worker gets a new token; the old token cannot commit |
| crash after all segments exist but before rendition-ready commit | no viewer manifest appears; exact retry safely reuses verified immutable objects |
| crash after ready commit but before publication | ready data remains invisible until an explicit successful publish transaction |
| one segment absent or digest-mismatched | publication fails without changing the active manifest |
| tombstone races with manifest read | one authority observation decides; no response may combine a post-tombstone mapping with pre-tombstone permission |
| malformed or multi-range request | reject before unbounded allocation or filesystem access |

## Verification plan

1. Pure tests for request canonicalization, chunk/range bounds, manifest canonical bytes, deterministic segmentation, and evidence
   response shaping.
2. Generated tests over small byte arrays proving segment concatenation equals input, every segment digest matches its bytes,
   manifests are deterministic, and boundaries cover each source byte exactly once.
3. Real PostgreSQL tests for concurrent upload replay/conflict, offset serialization, finalize/job atomicity, lease recovery and
   stale-token fencing, publication validation, tombstone races, and transaction rollback.
4. Real filesystem tests for content-addressed create/verify, fsync/rename boundaries, existing-object mismatch, and bounded range
   reads. A local directory proves only this adapter, not S3 durability.
5. A true-process smoke: commit a chunk then kill the API before response; restart/replay; finalize; kill a worker after object
   creation but before ready commit; recover; publish; fetch manifest/range; tombstone; verify denial.
6. Log inspection proving fixture credentials, upload keys, media phrases/bytes, and object paths are absent.
7. A bounded benchmark with exact byte size, segment size, PostgreSQL version, runtime, filesystem, exclusions, and raw timings.

## Initial design choices to challenge after source review

- Is upload order assumed contiguous, or does the case require parallel part upload with an explicit completion manifest?
- Is transcoding modeled as one job or a dependency graph with independent formats, thumbnails, and moderation gates?
- Does publication need a separate creator action, or should a successfully processed upload auto-publish?
- What cache/CDN invalidation contract is needed for mutable manifests and immediate tombstones?
- Which scale assumptions and storage calculations in the source are internally consistent?
- Does the source distinguish object durability, metadata publication, server delivery, client playback, and human viewing?

## Completion gate

The repository is complete only when the closed-book/source comparison, primary-source corrections, one minimal runnable slice,
negative tests, crash smoke, benchmark, threat model, operations guide, exact public commit, and green CI run are all present.

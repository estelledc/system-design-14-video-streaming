# Architecture

## One authority, two byte classes

PostgreSQL owns lifecycle and visibility. The local object directory owns immutable byte readback. Objects fall into two classes:

- upload chunks and the assembled source, which are never public;
- synthetic segments and their canonical manifest, which are still served only after PostgreSQL authorizes one active rendition.

```text
creator HTTP
    |
    v
upload service ---- PostgreSQL upload/video rows
    |                         |
    v                         v
immutable chunk CAS ---> finalized job row
                              |
                              v
                     fenced worker claim
                              |
              +---------------+---------------+
              v                               v
        segment/manifest CAS          ready metadata transaction
                                              |
                                      explicit owner publish
                                              |
viewer GET ---> one authority query ---> active manifest/segment readback
```

The object directory is not queried to discover what is published. The database never synthesizes bytes. The active pointer is the
join between these responsibilities.

## Upload path

1. The service validates exact fields and hashes the bearer token into an owner fingerprint.
2. `openUpload` inserts video and upload rows in one transaction. A unique owner/key constraint settles concurrent retries.
3. For a chunk, the service hashes the body and installs it at a digest path before opening the offset transaction.
4. The transaction locks one upload row, classifies exact replay, compares the requested/current offset, inserts the request
   receipt, and advances the offset.
5. A failed or losing request may leave an unreferenced content object. That is safer than a committed metadata reference to
   missing bytes and is an explicit garbage-collection debt.

This is a sequential tus-like state machine, not tus conformance or parallel multipart upload.

## Immutable local object install

For digest `d`, the adapter uses `objects/d[0:2]/d`:

1. create a random temporary file in the same directory with exclusive `wx`;
2. write all bytes and call `FileHandle.sync()`;
3. create an exclusive hard link from the complete temporary inode to the digest path;
4. sync the containing directory;
5. remove the temporary name;
6. if the target already exists, verify regular-file type, size bound, and full digest instead of overwriting;
7. repeat full digest verification on every read.

The hard link prevents a target name from exposing a partially written file and prevents last-writer overwrite. It depends on a
POSIX-like same-filesystem local directory. Network filesystems, Windows behavior, disk controllers, power loss, and S3 semantics
are outside the result.

## Finalization transaction

Finalization locks one upload row, reads its ordered chunk references, verifies there are no gaps, reads and verifies each immutable
chunk, assembles the bounded source, and checks the declared full digest. It then installs the source object and commits:

- upload `finalized` plus source digest;
- video `queued`;
- one processing job with fixed recipe, segment size, and output rendition ID.

The implementation knowingly holds a row lock across bounded filesystem reads. Real large media would use a separate finalize
state, object-store completion receipt, and reconciliation rather than buffering the full source in a database transaction.

## Worker fencing and ready commit

Claiming chooses one queued or expired job using `FOR UPDATE ... SKIP LOCKED`, stores a SHA-256 of a random lease token, sets an
expiry, and increments the attempt. The raw token stays in the worker process.

The worker reads/verifies the source, deterministically splits it, installs every segment and manifest, then calls the ready
transaction. That transaction locks the job and accepts only the current token hash before expiry. It re-verifies every object,
inserts the rendition and ordered segment rows, marks the job completed, and changes the video to ready.

If a worker crashes after object creation, the job remains processing. A later claim replaces its token. Repeated equal segments
share one CAS object but retain distinct ordered rows.

## Publication and read path

Publication locks the video, loads its ready rendition, parses the canonical manifest, compares every ordered metadata row, and
re-verifies every referenced object. It then marks rendition and video published and sets the active rendition in one transaction.

A manifest read performs one statement over video plus active rendition, then loads the immutable manifest. A segment read performs
one statement over video plus active segment membership, then loads the verified object. This is read-time authorization, not a
transaction spanning the HTTP response.

Only one byte range is supported. Full responses return `200`; valid partial responses return `206`, `Content-Range`, strong digest
ETag, and `Accept-Ranges: bytes`; unsatisfiable ranges return `416`; multiple ranges return `400` before object access.

## Tombstone semantics

Tombstone locks any job, then the video, cancels queued/processing work, clears the active rendition, increments a version, and
sets state to tombstoned. Later authority observations return `410`. Immutable bytes and completed metadata remain for audit and
future garbage collection.

Because responses are `private, no-store`, the executable contract covers the origin only. It does not cover previously copied
bytes, caches that violate policy, or an eventual CDN.

## Scaling seam, not implemented architecture

At production media sizes, the direct replacements would be:

- sequential chunks → explicit object-store multipart state and completion checksum;
- in-transaction assembly → durable finalize state plus reconciler;
- one job → a versioned task DAG with dependency receipts and per-task fencing;
- local CAS → replicated object storage with conditional create and integrity metadata;
- origin no-store → signed immutable segment URLs plus measured expiry/purge and deletion window;
- one PostgreSQL authority → partitioned metadata with an explicit video aggregate owner and migration fence.

Those are named seams. No placeholder queue, DAG, CDN, cache, or sharding code exists in v0.1.

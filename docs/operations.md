# Operations

## Runtime

- Node.js 22 or newer; CI covers exact available 22/24/26 releases selected by the setup action.
- PostgreSQL 17.6.
- One private local directory on a POSIX-like filesystem for the bounded object adapter.

Required environment:

| Variable | Process | Meaning |
|---|---|---|
| `DATABASE_URL` | API and worker | PostgreSQL connection string |
| `OBJECT_ROOT` | API and worker | same local immutable-object directory |
| `AUTH_TOKENS_JSON` | API | JSON array of owner bearer tokens |
| `HOST`, `PORT` | API | listener; defaults to loopback and 3000 |
| `LEASE_MS` | worker | 50–60,000 ms through service validation; default 5,000 |
| `CLOCK_MS` | tests only | fixed non-negative clock for deterministic failure cases |
| `CRASH_AFTER_CHUNK_COMMIT` | tests only | `SIGKILL` after new chunk commit, before response |
| `CRASH_AFTER_OBJECTS` | tests only | `SIGKILL` after rendition objects, before ready transaction |

Do not put real credentials or media in this lab.

## Local commands

```bash
npm ci --ignore-scripts
npm run check
```

The pure gate covers repository policy, JavaScript syntax, 16 unit/generated/filesystem/HTTP tests, and current high-severity npm
advisories. It does not run PostgreSQL.

With a disposable PostgreSQL 17.6 database and object directory:

```bash
npm run test:postgres
npm run smoke:postgres
npm run benchmark:postgres
```

Or run the CI-equivalent sequence:

```bash
npm run check:ci
```

The integration/smoke scripts reset the database's `public` schema. Never point them at a shared or production database.

## Start API and worker

```bash
node src/main.js serve
node src/main.js worker-once
```

The worker processes at most one eligible job and exits. A production scheduler, autoscaler, heartbeat, lease renewal, and retry
budget are not included.

## Health and structured receipts

`GET /healthz` checks PostgreSQL. It does not verify every object, disk capacity, worker availability, or viewer playback.

Safe structured event kinds include:

- `api_listening`;
- `upload_opened`, `upload_chunk_committed`, `source_finalized`;
- `rendition_objects_written`, `worker_once_receipt`, `manifest_published`;
- `manifest_response`, `server_bytes_written`, `video_tombstoned`;
- `request_failed` with code/status only.

Logs omit credentials, owner fingerprints, request keys, UUIDs, expected/content digests, manifest contents, source/segment bytes, and
object paths. External proxy, database, filesystem, and platform logging need separate controls.

## Metrics and alert candidates

No exporter is bundled. A real deployment should derive bounded labels only:

- upload open/chunk/finalize rates by status code, not owner or upload ID;
- offset conflicts, digest failures, and finalization latency;
- queued/processing job counts, oldest eligible age, lease recoveries, stale-token conflicts, attempts;
- ready-but-unpublished age;
- object install/read integrity failures and local disk capacity;
- manifest/segment status and byte-count buckets, not paths/digests;
- tombstone count and denial latency at the origin.

Alert candidates:

- oldest queued/expired job above the declared processing objective;
- any repeated object digest mismatch or missing referenced object;
- sustained finalize integrity failures above a reviewed baseline;
- PostgreSQL unavailable or transaction conflicts/deadlocks increasing;
- object volume approaching capacity or orphan growth without a completed mark/sweep;
- ready age increasing while publication requests succeed poorly.

## Recovery table

| Observation | Safe action | Do not claim |
|---|---|---|
| response lost after chunk commit | `HEAD`, then exact request replay | blindly append the chunk again |
| object exists but chunk row does not | leave as orphan; retry metadata transition; later mark/sweep | object name means accepted upload |
| full digest fails | stop and require corrected upload intent/new upload | retry processing unchanged |
| processing lease expired | claim with new token; old token must conflict | old and new workers can both publish |
| objects exist, no ready row | recover job after lease; deterministic write verifies/reuses objects | make objects viewer-visible directly |
| ready row exists, no active rendition | owner may publish after full verification | ready means public |
| active referenced object missing | publication/read fails integrity; restore verified object or roll back metadata operationally | serve another file under the digest |
| tombstone committed | deny new origin reads; schedule reviewed object cleanup | physical erasure or cache purge completed |

## Backup, restore, and cleanup limits

There is no backup/restore implementation. A consistent recovery would need PostgreSQL plus all referenced objects, followed by a
full manifest/segment verifier before traffic. Restoring only one side is insufficient.

There is no orphan collector. A future mark/sweep must take a database snapshot of all referenced chunk/source/manifest/segment
digests, apply a safety age, and delete only unreferenced objects. Tombstoned objects require a separate retention/legal policy.
Incomplete uploads likewise need an explicit expiration transition before their chunk references can be collected.

## Benchmark interpretation

The benchmark uses one 512 KiB synthetic source, 64 × 8 KiB sequential chunks, eight 64 KiB synthetic segments, and 500 local
256-byte range reads. It includes PostgreSQL and local filesystem sync/readback on one hosted runner. It excludes codecs, network,
TLS, CDN, concurrent creators/viewers, cache, replication, failover, and production media sizes. Compare regressions only after
controlling the environment; never multiply the observed rate into a capacity promise.

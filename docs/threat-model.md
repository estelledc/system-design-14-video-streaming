# Threat model

## Protected assets

- bearer tokens and the owner relationship;
- source/chunk/segment/manifest bytes and their integrity;
- upload offset and idempotency bindings;
- processing lease authority and publication state;
- availability of PostgreSQL, object storage, worker, and read origin;
- deletion/tombstone intent and evidence vocabulary.

No real user data belongs in this repository or fixture set.

## Trust boundaries

```text
untrusted HTTP client
        |
bounded parser + allowlisted bearer authentication
        |
Node service / worker
   |                |
parameterized SQL   digest-derived local object paths
   |                |
PostgreSQL          private local filesystem
```

The bearer allowlist is a lab bootstrap, not account/session management. The local machine/operator and PostgreSQL role are trusted
administratively. There is no tenant sandbox or protection from a malicious local user who can mutate the database/object root.

## Controls and residual risk

| Threat | v0.1 control | Residual risk |
|---|---|---|
| forged creator mutation | exact bearer allowlist; owner fingerprint in rows | tokens are static env secrets; no rotation/session/revocation system |
| token/idempotency leakage | values excluded from responses/logs; owner stored as domain-separated SHA-256 | reverse proxy, crash dump, database admin, and environment exposure are separate |
| path traversal/symlink input | paths derive from validated server UUID/digest; existing target must be a regular non-symlink file | a privileged local actor can race/replace directories; no sandbox/openat fencing |
| partial/overwritten object | synced temp inode plus exclusive hard link; target never overwritten; read digest verification | power-loss and exotic/network filesystem behavior unproven |
| duplicate/lost chunk response | stable request digest and locked contiguous offset | orphan content object remains; no upload expiry/GC |
| corrupted or incomplete source | chunk readback, exact coverage, full declared SHA-256 | SHA-256 does not establish safe/authorized media |
| stale worker commits | random token hash, expiry, job row lock, final token recheck | no heartbeat/renewal; long valid worker can still consume resources |
| duplicate job result | fixed output rendition ID and deterministic manifest; token fence | no multi-task DAG/inbox/outbox |
| partial manifest publication | all object verification before ready and again before one publication transaction | external mutation after authority observation can still fail a read |
| arbitrary segment enumeration | video-scoped path plus active-rendition membership query | public video segment URLs are disclosed in manifest; no signed/private delivery |
| range amplification | one range only; bounded segment/object/body sizes; malformed/multi-range rejected | no connection/request-rate limit or bandwidth quota |
| stale delivery after tombstone | every origin read checks current video state; `private, no-store` | prior recipients, non-compliant caches, logs, backups, and copied objects remain |
| cache poisoning | no shared-cache permission; strong digest ETag | future CDN requires HTTPS, key isolation, signed URLs/purge/TTL |
| malicious media | no codec parser; bytes remain opaque | no malware, decompression bomb, codec exploit, moderation, or copyright control |
| SQL injection | parameterized values and restricted identifiers | database role is not least-privilege/migration-separated in the lab |
| denial of service | strict byte/count/key/range/lease bounds and one-job worker | no global/user quota, rate limiter, connection timeout policy, or autoscaling |
| supply-chain compromise | one pinned runtime dependency, lockfile, audit, pinned CI actions, minimal permissions | audit database is incomplete; registry/action compromise and transitive risk remain |

## Evidence-abuse threats

The most likely design error is semantic escalation:

- a synced local object is not replicated durable storage;
- a finalized source is not a valid or safe video;
- synthetic segmentation is not transcoding;
- ready is not published;
- published at origin is not CDN propagation;
- a response callback is not client receipt, decode, screen display, playback, audibility, attention, or a human view;
- tombstone is not physical/legal erasure.

Static checks forbid unsupported playback evidence labels in source, and the process smoke emits zero counters for decode, playback,
and human-view claims.

## Future security gates

Before real media or public deployment, add account/session lifecycle, per-owner quotas/rate limits, direct-upload credential scope,
multipart expiration, content-type sniffing and sandboxed media validation, malware/moderation/copyright workflows, signed delivery,
CDN purge/expiry measurements, private visibility, TLS/proxy hardening, database least privilege, encryption/key management,
backups/restores, multi-host object durability, audit retention/deletion, and external security review.

# Repository instructions

- Keep the implementation dependency-light and the evidence claims narrower than the executed tests.
- Never log upload bytes, titles, owner tokens, idempotency keys, object paths, or viewing tokens.
- Preserve the distinction between accepted bytes, durable objects, a published manifest, bytes written by the server, client
  decoding, screen display, and human viewing.
- PostgreSQL is the metadata authority. Filesystem objects are immutable payloads, not an independent publication authority.
- Do not weaken crash, fencing, digest, or atomic-publication assertions to make a gate pass.
- Use exact-path staging. Do not add generated media, credentials, local database state, or machine-specific paths.

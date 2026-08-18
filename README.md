# Atomic Video Publication Lab

This clean-room system-design practice asks one narrow question: how can a creator upload bytes in resumable pieces, let an
asynchronous worker derive an immutable streaming artifact, and expose only a completely published manifest to viewers?

The title-level problem is commonly framed as “design YouTube.” This repository does not copy a product, source chapter, UI, or
proprietary behavior. The closed-book contract is frozen before consulting the fixed secondary chapter.

## Current phase

- Closed-book problem contract: [docs/closed-book-contract.md](docs/closed-book-contract.md)
- Source comparison, architecture decision, runnable slice, and public CI: pending the next phases

## Evidence boundary

The intended vertical slice may prove upload acceptance, byte integrity, immutable object durability, worker fencing, complete
manifest publication, and server-side byte writes. It must not call those facts successful decoding, screen display, a completed
view, user attention, recommendation quality, copyright ownership, or production delivery.

## License

MIT. Third-party study material is not included.

import { sha256 } from './crypto.js';
import { IntegrityError, ValidationError } from './errors.js';
import { RECIPE_VERSION, validateSegmentBytes } from './contracts.js';

export function buildSyntheticRendition(source, { segmentBytes, recipeVersion = RECIPE_VERSION }) {
  if (!Buffer.isBuffer(source) || source.length === 0) throw new ValidationError('source bytes are required');
  validateSegmentBytes(segmentBytes);
  if (recipeVersion !== RECIPE_VERSION) throw new ValidationError('recipe version is unsupported');

  const segments = [];
  for (let start = 0, index = 0; start < source.length; start += segmentBytes, index += 1) {
    const bytes = Buffer.from(source.subarray(start, Math.min(start + segmentBytes, source.length)));
    segments.push({ index, bytes, sha256: sha256(bytes), size: bytes.length });
  }
  const manifest = {
    schemaVersion: 1,
    recipeVersion,
    sourceSha256: sha256(source),
    totalBytes: source.length,
    segmentBytes,
    segments: segments.map(({ index, sha256: digest, size }) => ({ index, sha256: digest, bytes: size })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return {
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    segments,
  };
}

export function parseAndVerifyManifest(bytes, expectedDigest) {
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== expectedDigest) throw new IntegrityError();
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new IntegrityError();
  }
  const rebuilt = Buffer.from(JSON.stringify(manifest));
  if (!rebuilt.equals(bytes)) throw new IntegrityError('Manifest is not canonical JSON');
  if (manifest?.schemaVersion !== 1 || manifest?.recipeVersion !== RECIPE_VERSION) throw new IntegrityError();
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceSha256)) throw new IntegrityError();
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes <= 0) throw new IntegrityError();
  if (
    !Number.isSafeInteger(manifest.segmentBytes)
    || manifest.segmentBytes < 1_024
    || manifest.segmentBytes > 262_144
  ) throw new IntegrityError();
  if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) throw new IntegrityError();
  let total = 0;
  for (const [index, segment] of manifest.segments.entries()) {
    if (segment?.index !== index || !/^[0-9a-f]{64}$/.test(segment?.sha256)) throw new IntegrityError();
    const expectedBytes = index === manifest.segments.length - 1
      ? manifest.totalBytes - (manifest.segmentBytes * index)
      : manifest.segmentBytes;
    if (!Number.isSafeInteger(segment.bytes) || segment.bytes !== expectedBytes) throw new IntegrityError();
    total += segment.bytes;
  }
  if (total !== manifest.totalBytes) throw new IntegrityError();
  if (manifest.segments.length !== Math.ceil(manifest.totalBytes / manifest.segmentBytes)) throw new IntegrityError();
  return manifest;
}

import { ValidationError, RangeNotSatisfiableError } from './errors.js';

export const MAX_SOURCE_BYTES = 1_048_576;
export const MAX_CHUNK_BYTES = 131_072;
export const MIN_SEGMENT_BYTES = 1_024;
export const MAX_SEGMENT_BYTES = 262_144;
export const DEFAULT_SEGMENT_BYTES = 65_536;
export const RECIPE_VERSION = 'synthetic-segment-v1';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const stableKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) throw new ValidationError(`${name} has unknown fields`);
  return value;
}

function safeInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} is outside its supported bounds`);
  }
  return value;
}

export function validateStableKey(value, name = 'idempotency key') {
  if (typeof value !== 'string' || !stableKeyPattern.test(value)) {
    throw new ValidationError(`${name} is invalid`);
  }
  return value;
}

export function validateUuid(value, name = 'resource ID') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new ValidationError(`${name} is invalid`);
  return value;
}

export function validateDigest(value, name = 'SHA-256 digest') {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new ValidationError(`${name} is invalid`);
  return value;
}

export function validateUploadIntent(value) {
  const request = exactObject(value, new Set(['expectedBytes', 'expectedSha256', 'visibility']), 'upload request');
  return {
    expectedBytes: safeInteger(request.expectedBytes, 'expectedBytes', { min: 1, max: MAX_SOURCE_BYTES }),
    expectedSha256: validateDigest(request.expectedSha256, 'expectedSha256'),
    visibility: request.visibility === 'public' ? 'public' : (() => {
      throw new ValidationError('visibility must be public');
    })(),
  };
}

export function validateChunk({ offset, bytes }) {
  if (!Buffer.isBuffer(bytes)) throw new ValidationError('chunk body must be bytes');
  safeInteger(offset, 'upload offset', { max: MAX_SOURCE_BYTES });
  if (bytes.length < 1 || bytes.length > MAX_CHUNK_BYTES) {
    throw new ValidationError('chunk body is outside its supported bounds');
  }
  return { offset, bytes };
}

export function parseOffsetHeader(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError('Upload-Offset must be a non-negative integer');
  }
  return safeInteger(Number(value), 'Upload-Offset', { max: MAX_SOURCE_BYTES });
}

export function validateLeaseMilliseconds(value) {
  return safeInteger(value, 'lease duration', { min: 50, max: 60_000 });
}

export function validateSegmentBytes(value) {
  return safeInteger(value, 'segmentBytes', { min: MIN_SEGMENT_BYTES, max: MAX_SEGMENT_BYTES });
}

export function parseSingleByteRange(value, totalBytes) {
  safeInteger(totalBytes, 'object size', { min: 1, max: MAX_SEGMENT_BYTES });
  if (value === undefined) return { status: 200, start: 0, end: totalBytes - 1, length: totalBytes };
  if (typeof value !== 'string' || value.includes(',')) {
    throw new ValidationError('only one byte range is supported');
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (match[1] === '' && match[2] === '')) throw new ValidationError('Range is invalid');

  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeNotSatisfiableError(totalBytes);
    start = Math.max(totalBytes - suffix, 0);
    end = totalBytes - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start >= totalBytes) throw new RangeNotSatisfiableError(totalBytes);
    end = match[2] === '' ? totalBytes - 1 : Number(match[2]);
    if (!Number.isSafeInteger(end) || end < start) throw new RangeNotSatisfiableError(totalBytes);
    end = Math.min(end, totalBytes - 1);
  }
  return { status: 206, start, end, length: end - start + 1 };
}

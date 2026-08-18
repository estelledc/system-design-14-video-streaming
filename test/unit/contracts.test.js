import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseOffsetHeader,
  parseSingleByteRange,
  validateUploadIntent,
} from '../../src/contracts.js';
import { RangeNotSatisfiableError, ValidationError } from '../../src/errors.js';

test('upload intent accepts only one bounded public source identity', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(validateUploadIntent({ expectedBytes: 10, expectedSha256: digest, visibility: 'public' }), {
    expectedBytes: 10,
    expectedSha256: digest,
    visibility: 'public',
  });
  assert.throws(
    () => validateUploadIntent({ expectedBytes: 10, expectedSha256: digest, visibility: 'private' }),
    ValidationError,
  );
  assert.throws(
    () => validateUploadIntent({ expectedBytes: 10, expectedSha256: digest, visibility: 'public', title: 'hidden' }),
    ValidationError,
  );
});

test('offset header is an exact bounded non-negative integer', () => {
  assert.equal(parseOffsetHeader('0'), 0);
  assert.equal(parseOffsetHeader('1048576'), 1_048_576);
  for (const value of ['-1', '+1', '01', '1.0', '', undefined]) {
    assert.throws(() => parseOffsetHeader(value), ValidationError);
  }
});

test('single byte ranges support closed, open, and suffix forms', () => {
  assert.deepEqual(parseSingleByteRange(undefined, 10), { status: 200, start: 0, end: 9, length: 10 });
  assert.deepEqual(parseSingleByteRange('bytes=2-5', 10), { status: 206, start: 2, end: 5, length: 4 });
  assert.deepEqual(parseSingleByteRange('bytes=7-', 10), { status: 206, start: 7, end: 9, length: 3 });
  assert.deepEqual(parseSingleByteRange('bytes=-3', 10), { status: 206, start: 7, end: 9, length: 3 });
  assert.deepEqual(parseSingleByteRange('bytes=8-99', 10), { status: 206, start: 8, end: 9, length: 2 });
});

test('multi-range, malformed, and unsatisfiable requests fail before reads', () => {
  assert.throws(() => parseSingleByteRange('bytes=0-1,4-5', 10), ValidationError);
  assert.throws(() => parseSingleByteRange('items=0-1', 10), ValidationError);
  assert.throws(() => parseSingleByteRange('bytes=10-', 10), RangeNotSatisfiableError);
  assert.throws(() => parseSingleByteRange('bytes=5-4', 10), RangeNotSatisfiableError);
  assert.throws(() => parseSingleByteRange('bytes=-0', 10), RangeNotSatisfiableError);
});

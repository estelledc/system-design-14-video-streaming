import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestJson(value) {
  return sha256(JSON.stringify(value));
}

export function ownerFingerprint(token) {
  return sha256(`video-owner-v1\0${token}`);
}

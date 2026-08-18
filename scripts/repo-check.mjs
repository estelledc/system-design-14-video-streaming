import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ignoredDirectories = new Set(['.git', 'node_modules']);
const requiredFiles = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-content-addressed-objects-and-metadata-gated-publication.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'scripts/postgres-benchmark.mjs',
  'scripts/postgres-smoke.mjs',
  'src/object-store.js',
  'src/postgres-repository.js',
  'src/segmenter.js',
  'test/integration/postgres.test.js',
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = walk(root);
const names = new Set(files.map((file) => relative(root, file)));
for (const name of requiredFiles) assert.ok(names.has(name), `missing required file: ${name}`);

for (const file of files.filter((path) => ['.js', '.mjs'].includes(extname(path)))) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

const textExtensions = new Set(['.js', '.json', '.md', '.mjs', '.yml', '.yaml']);
const localMacPrefix = ['/', 'Users', '/'].join('');
for (const file of files.filter((path) => textExtensions.has(extname(path)))) {
  const source = readFileSync(file, 'utf8');
  const name = relative(root, file);
  assert.ok(!/[\t ]+$/m.test(source), `${name} contains trailing whitespace`);
  assert.ok(!source.includes('\r\n'), `${name} contains CRLF line endings`);
  assert.ok(!source.includes(localMacPrefix), `${name} contains a local macOS path`);
  assert.ok(!/[A-Za-z]:\\Users\\/.test(source), `${name} contains a local Windows path`);
  assert.ok(!/(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/.test(source), `${name} resembles a GitHub token`);
  assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source), `${name} contains a private key`);
  if (name.startsWith('test/')) {
    assert.ok(!/(?:test|describe)\.skip\s*\(/.test(source), `${name} contains a skipped test`);
  }
}

const markdownLinks = /!?\[[^\]]*\]\(([^)]+)\)/g;
for (const file of files.filter((path) => extname(path) === '.md')) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(markdownLinks)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '').split(/\s+['"]/)[0];
    if (/^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split('#')[0]);
    if (target.length === 0) continue;
    assert.ok(existsSync(resolve(dirname(file), target)), `${relative(root, file)} has broken link: ${rawTarget}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
assert.equal(packageJson.dependencies.pg, '8.23.0');
assert.equal(packageLock.packages[''].dependencies.pg, '8.23.0');

const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
for (const match of workflow.matchAll(/^\s*uses:\s*([^\s]+)(?:\s+#.*)?$/gm)) {
  assert.match(match[1], /@[a-f0-9]{40}$/, `GitHub Action is not pinned by commit: ${match[1]}`);
}
assert.match(workflow, /postgres:17\.6-alpine/);
assert.match(workflow, /node:\s*\[22, 24, 26\]/);
assert.match(workflow, /permissions:\s*\n\s*contents: read/);

const research = readFileSync(join(root, 'docs/research-log.md'), 'utf8');
assert.match(research, /9d8388721e7231442763ad37398b8d82224aa68f/);
assert.match(research, /tree has no detected license/i);
assert.match(research, /does not copy the chapter's prose, diagrams, or code/i);
assert.match(research, /custom manifest HLS\/DASH/i);

const implementation = files
  .filter((path) => path.startsWith(join(root, 'src')))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
for (const forbidden of ['client_received', 'video_decoded', 'playback_completed', 'human_viewed']) {
  assert.ok(!implementation.includes(`'${forbidden}'`), `source emits unsupported evidence: ${forbidden}`);
}
for (const required of [
  'upload_opened',
  'upload_chunk_committed',
  'source_finalized',
  'rendition_ready',
  'manifest_published',
  'manifest_response',
  'server_bytes_written',
  'video_tombstoned',
]) {
  assert.ok(implementation.includes(`'${required}'`), `source is missing evidence label: ${required}`);
}

const schema = readFileSync(join(root, 'src/schema.js'), 'utf8');
assert.match(schema, /UNIQUE \(owner_fingerprint, idempotency_key\)/);
assert.match(schema, /PRIMARY KEY \(rendition_id, segment_index\)/);
assert.ok(!/UNIQUE \(rendition_id, segment_sha256\)/.test(schema), 'equal segments must remain valid ordered positions');

const verification = readFileSync(join(root, 'docs/verification.md'), 'utf8');
assert.match(verification, /0 skipped/i);
assert.match(verification, /does not prove|will not prove/i);
assert.match(verification, /screen display/i);

const smoke = readFileSync(join(root, 'scripts/postgres-smoke.mjs'), 'utf8');
assert.match(smoke, /SIGKILL/);
assert.match(smoke, /chunkRetryCreated:\s*replay\.created/);
assert.match(smoke, /readyInvisibleBeforePublish/);
assert.match(smoke, /reusedReadyObjects/);
assert.match(smoke, /decodeClaims:\s*0/);
assert.match(smoke, /playbackClaims:\s*0/);
assert.match(smoke, /humanViewClaims:\s*0/);

process.stdout.write(`${JSON.stringify({
  kind: 'repository_static_receipt',
  files: files.length,
  javascriptFiles: files.filter((path) => ['.js', '.mjs'].includes(extname(path))).length,
  markdownFiles: files.filter((path) => extname(path) === '.md').length,
  actionPins: [...workflow.matchAll(/^\s*uses:/gm)].length,
})}\n`);

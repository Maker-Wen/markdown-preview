'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build, parseArgs } = require('../scripts/package-release.cjs');

async function main() {
  assert.equal(parseArgs(['--version', 'v1.0.0']).version, '1.0.0');
  assert.throws(() => parseArgs(['--version', 'release']), /SemVer/);
  console.log('PASS: release arguments normalize v-prefixed semver');

  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-release-test-'));
  try {
    const files = await build({ version: '1.0.0', output, dryRun: false });
    const listing = execFileSync('tar', ['-tzf', files[0]], { encoding: 'utf8' });
    assert.match(listing, /^markdown-preview-v1\.0\.0\/plugins\/markdown-preview\/plugin\.json$/m);
    assert.doesNotMatch(listing, /node_modules/);
    assert.doesNotMatch(listing, /\.git\//);
    assert.doesNotMatch(listing, /^markdown-preview-v1\.0\.0\/dist\//m);
    const sums = await fs.readFile(files[2], 'utf8');
    assert.match(sums, /markdown-preview-v1\.0\.0\.tar\.gz/);
    assert.match(sums, /markdown-preview-v1\.0\.0\.zip/);
    console.log('PASS: release package contains source without local dependencies');
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

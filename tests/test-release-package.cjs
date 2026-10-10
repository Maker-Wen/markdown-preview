'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
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

    const fixture = path.join(output, 'fixture');
    const fixtureScript = path.join(fixture, 'scripts/package-release.cjs');
    const fixtureOutput = path.join(output, 'fixture-output');
    await fs.mkdir(path.dirname(fixtureScript), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, '../scripts/package-release.cjs'), fixtureScript);

    const help = spawnSync(process.execPath, [fixtureScript, '--output', fixtureOutput, '--help'], { encoding: 'utf8' });
    assert.equal(help.error, undefined);
    assert.equal(help.status, 0, help.stdout + help.stderr);
    assert.match(help.stdout, /用法：node scripts\/package-release\.cjs/);
    assert.equal(help.stderr, '');
    assert.equal(await fs.access(fixtureOutput).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(fixture), ['scripts']);
    console.log('PASS: release help succeeds without creating output files');

    const invalid = spawnSync(process.execPath, [fixtureScript, '--unknown'], { encoding: 'utf8' });
    assert.equal(invalid.error, undefined);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /发布包生成失败：未知参数：--unknown/);
    assert.doesNotMatch(invalid.stderr, /\n\s+at /);
    assert.equal(await fs.access(fixtureOutput).then(() => true, () => false), false);
    console.log('PASS: invalid release arguments use the normal error handler');

    const fixtureBuild = require(fixtureScript).build;
    const fixtureOptions = { version: '1.2.3', output: fixtureOutput, dryRun: false };
    await fs.writeFile(path.join(fixture, 'old-entry.txt'), 'obsolete release content');
    const fixtureFiles = await fixtureBuild(fixtureOptions);
    const previous = await Promise.all(fixtureFiles.map(file => fs.readFile(file)));
    await fs.rm(path.join(fixture, 'old-entry.txt'));
    await fs.writeFile(path.join(fixture, 'new-entry.txt'), 'current release content');

    const failureBin = path.join(output, 'failure-bin');
    await fs.mkdir(failureBin);
    const fakeZip = path.join(failureBin, 'zip');
    await fs.writeFile(fakeZip, '#!/bin/sh\nexit 42\n');
    await fs.chmod(fakeZip, 0o755);
    const failed = spawnSync(process.execPath, [fixtureScript, '--version', fixtureOptions.version, '--output', fixtureOutput], {
      encoding: 'utf8', env: { ...process.env, PATH: failureBin + path.delimiter + process.env.PATH }
    });
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /发布包生成失败/);
    for (let i = 0; i < fixtureFiles.length; i += 1) assert.deepEqual(await fs.readFile(fixtureFiles[i]), previous[i]);
    assert.deepEqual((await fs.readdir(fixtureOutput)).sort(), fixtureFiles.map(file => path.basename(file)).sort());
    console.log('PASS: failed archive generation preserves prior release files and checksums');

    await fixtureBuild(fixtureOptions);
    for (const file of fixtureFiles.slice(0, 2)) {
      const members = file.endsWith('.zip')
        ? execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
        : execFileSync('tar', ['-tzf', file], { encoding: 'utf8' });
      assert.doesNotMatch(members, /old-entry\.txt/);
      assert.match(members, /new-entry\.txt/);
    }
    const rebuiltSums = await fs.readFile(fixtureFiles[2], 'utf8');
    for (const file of fixtureFiles.slice(0, 2)) {
      const digest = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      assert.ok(rebuiltSums.includes(`${digest}  ${path.basename(file)}\n`));
    }
    assert.deepEqual((await fs.readdir(fixtureOutput)).sort(), fixtureFiles.map(file => path.basename(file)).sort());
    console.log('PASS: repackaging removes deleted members from both archives and refreshes checksums');
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

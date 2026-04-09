/**
 * Integration tests for the code-executor sandbox enforcement.
 *
 * These tests replicate what code-executor.ts does when `sandbox: true`:
 * spawning a Node.js child process with `--permission` flags that deny
 * filesystem writes and child_process access.
 *
 * Node 24+ ships the permission model as stable, so these tests require
 * a Node 24+ runtime (the same runtime used in production).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

describe('code-executor sandbox', () => {
  // Resolve the real path of the temp dir — on macOS, tmpdir() returns a
  // symlink (/var/folders/...) but Node resolves it to /private/var/folders/...
  // before evaluating --allow-fs-read permissions. We must pass the resolved
  // path so the permission grant actually covers the code files.
  let tempDir: string;

  beforeAll(async () => {
    const base = join(tmpdir(), 'sandbox-test-' + Date.now());
    await mkdir(base, { recursive: true });
    tempDir = await realpath(base);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('sandbox: true blocks fs.writeFileSync', async () => {
    const code = [
      `import { writeFileSync } from 'fs';`,
      `try {`,
      `  writeFileSync('${tempDir}/hack.txt', 'pwned');`,
      `  console.log('FAIL');`,
      `} catch(e) {`,
      `  console.log('BLOCKED:' + e.code);`,
      `}`,
    ].join('\n');

    const codePath = join(tempDir, 'test-write.mjs');
    await writeFile(codePath, code);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--permission', `--allow-fs-read=${tempDir}`, codePath],
      { cwd: tempDir },
    );

    expect(stdout).toContain('BLOCKED:ERR_ACCESS_DENIED');
  });

  it('sandbox: true blocks child_process.execSync', async () => {
    const code = [
      `import { execSync } from 'child_process';`,
      `try {`,
      `  execSync('echo hi');`,
      `  console.log('FAIL');`,
      `} catch(e) {`,
      `  console.log('BLOCKED:' + e.code);`,
      `}`,
    ].join('\n');

    const codePath = join(tempDir, 'test-cp.mjs');
    await writeFile(codePath, code);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--permission', `--allow-fs-read=${tempDir}`, codePath],
      { cwd: tempDir },
    );

    expect(stdout).toContain('BLOCKED:ERR_ACCESS_DENIED');
  });

  it('sandbox: true allows fetch() (network is unrestricted by permission model)', async () => {
    const code = `console.log('FETCH:' + typeof fetch);`;
    const codePath = join(tempDir, 'test-fetch.mjs');
    await writeFile(codePath, code);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--permission', `--allow-fs-read=${tempDir}`, codePath],
      { cwd: tempDir },
    );

    expect(stdout).toContain('FETCH:function');
  });

  it('without sandbox flags, fs writes and reads succeed', async () => {
    const code = [
      `import { writeFileSync, unlinkSync } from 'fs';`,
      `writeFileSync('${tempDir}/allowed.txt', 'ok');`,
      `unlinkSync('${tempDir}/allowed.txt');`,
      `console.log('OK');`,
    ].join('\n');

    const codePath = join(tempDir, 'test-nosandbox.mjs');
    await writeFile(codePath, code);

    const { stdout } = await execFileAsync(process.execPath, [codePath], {
      cwd: tempDir,
    });

    expect(stdout).toContain('OK');
  });
});

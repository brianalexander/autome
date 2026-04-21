/**
 * Tests for createCli() factory.
 *
 * Validates:
 * - Custom name appears in --help output
 * - Custom version appears in --version output
 * - Default 'autome' branding when no options are provided
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCli } from '../create.js';

describe('createCli() — branding', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('--help output contains the default "autome" name when no name is provided', async () => {
    const cli = createCli();
    await cli.run(['node', 'autome', '--help']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('autome');
  });

  it('--help output contains the custom name when name is provided', async () => {
    const cli = createCli({ name: 'my-product' });
    await cli.run(['node', 'script', '--help']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('my-product');
  });

  it('--help output does NOT contain the old name when a custom name is set', async () => {
    const cli = createCli({ name: 'acme-cli' });
    await cli.run(['node', 'script', '--help']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('Usage: autome');
    expect(output).toContain('Usage: acme-cli');
  });

  it('--version output contains the default version when no version is provided', async () => {
    const cli = createCli();
    await cli.run(['node', 'autome', '--version']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  it('--version output contains the custom version when version is provided', async () => {
    const cli = createCli({ name: 'my-product', version: '2.3.4' });
    await cli.run(['node', 'script', '--version']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('2.3.4');
    expect(output).toContain('my-product');
  });

  it('--version output does NOT contain the default autome version for a branded CLI', async () => {
    const cli = createCli({ name: 'branded', version: '9.9.9' });
    await cli.run(['node', 'script', '--version']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('branded 9.9.9');
    expect(output).not.toContain('autome 0.1.0');
  });

  it('handles -v short flag for version', async () => {
    const cli = createCli({ name: 'mycli', version: '1.2.3' });
    await cli.run(['node', 'script', '-v']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('1.2.3');
  });

  it('handles -h short flag for help', async () => {
    const cli = createCli({ name: 'mycli' });
    await cli.run(['node', 'script', '-h']);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('mycli');
  });
});

import { describe, it, expect } from 'vitest';
import { resolveLucideIcon } from './iconResolver';

describe('resolveLucideIcon', () => {
  it('resolves a known single-word icon name', () => {
    const Icon = resolveLucideIcon('check');
    // lucide-react components are forwardRef objects, not plain functions
    expect(Icon).not.toBeNull();
    expect(Icon).toBeTruthy();
  });

  it('resolves a known kebab-case icon name', () => {
    const Icon = resolveLucideIcon('shield-check');
    expect(Icon).not.toBeNull();
    expect(Icon).toBeTruthy();
  });

  it('resolves a three-word kebab-case icon name', () => {
    const Icon = resolveLucideIcon('circle-alert');
    expect(Icon).not.toBeNull();
    expect(Icon).toBeTruthy();
  });

  it('returns null for an unknown icon name', () => {
    const Icon = resolveLucideIcon('this-icon-does-not-exist');
    expect(Icon).toBeNull();
  });

  it('returns null for an empty string', () => {
    const Icon = resolveLucideIcon('');
    expect(Icon).toBeNull();
  });

  it('is case-sensitive — lowercase input maps correctly via PascalCase conversion', () => {
    // 'play' should resolve to the Play component
    const Icon = resolveLucideIcon('play');
    expect(Icon).not.toBeNull();
  });

  it('resolves multi-segment names with more than two parts', () => {
    // 'arrow-up-right' -> 'ArrowUpRight'
    const Icon = resolveLucideIcon('arrow-up-right');
    expect(Icon).not.toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { getValidLines, extractSnippet, buildContext } from './context.js';

describe('getValidLines', () => {
  it('returns empty set for null/undefined patch', () => {
    expect(getValidLines(null)).toEqual(new Set());
    expect(getValidLines(undefined)).toEqual(new Set());
  });

  it('parses a simple hunk with added and context lines', () => {
    const patch = [
      '@@ -10,4 +10,6 @@',
      ' const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
      ' const d = 4;',
      ' const e = 5;',
    ].join('\n');

    const valid = getValidLines(patch);
    // Context lines: 10, 13, 14; Added lines: 11, 12
    expect(valid.has(10)).toBe(true);
    expect(valid.has(11)).toBe(true);
    expect(valid.has(12)).toBe(true);
    expect(valid.has(13)).toBe(true);
    expect(valid.has(14)).toBe(true);
    expect(valid.size).toBe(5);
  });

  it('skips deleted lines (do not count toward line numbers)', () => {
    const patch = [
      '@@ -5,4 +5,3 @@',
      ' keep',
      '-removed',
      ' also keep',
      ' end',
    ].join('\n');

    const valid = getValidLines(patch);
    expect(valid.has(5)).toBe(true);  // keep
    expect(valid.has(6)).toBe(true);  // also keep
    expect(valid.has(7)).toBe(true);  // end
    expect(valid.size).toBe(3);
  });

  it('handles multiple hunks', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' a',
      '+b',
      ' c',
      '@@ -20,3 +20,3 @@',
      ' x',
      '+y',
      ' z',
    ].join('\n');

    const valid = getValidLines(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.has(2)).toBe(true);
    expect(valid.has(3)).toBe(true);
    expect(valid.has(20)).toBe(true);
    expect(valid.has(21)).toBe(true);
    expect(valid.has(22)).toBe(true);
  });

  it('ignores "No newline at end of file" marker', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');

    const valid = getValidLines(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.size).toBe(1);
  });
});

describe('extractSnippet', () => {
  const patch = [
    '@@ -10,5 +10,7 @@',
    ' line10',
    '+line11',
    '+line12',
    ' line13',
    ' line14',
    '+line15',
    ' line16',
  ].join('\n');

  it('returns null for null patch', () => {
    expect(extractSnippet(null, 11)).toBeNull();
  });

  it('returns null if target line not found', () => {
    expect(extractSnippet(patch, 999)).toBeNull();
  });

  it('extracts 3 lines of context around target', () => {
    const snippet = extractSnippet(patch, 12);
    // line before (11), target (12), line after (13)
    expect(snippet).toBe('line11\nline12\n line13');
  });

  it('handles target at start of patch (no line before)', () => {
    const snippet = extractSnippet(patch, 10);
    // no line before, target (10), line after (11)
    expect(snippet).toBe(' line10\nline11');
  });

  it('handles target at end of patch (no line after)', () => {
    const snippet = extractSnippet(patch, 16);
    // line before (15), target (16), no line after
    expect(snippet).toBe('line15\n line16');
  });

  it('strips + prefix from added lines', () => {
    const snippet = extractSnippet(patch, 11);
    expect(snippet).not.toContain('+');
    expect(snippet).toBe(' line10\nline11\nline12');
  });
});

describe('buildContext', () => {
  it('includes diff for all files', () => {
    const files = [
      { filename: 'a.js', status: 'modified', patch: '+added', content: 'full content' },
      { filename: 'b.js', status: 'added', patch: '+new file', content: 'new' },
    ];
    const { userMessage } = buildContext(files, {});
    expect(userMessage).toContain('## File: a.js (modified)');
    expect(userMessage).toContain('## File: b.js (added)');
    expect(userMessage).toContain('+added');
    expect(userMessage).toContain('+new file');
  });

  it('returns truncatedCount when full content is dropped', () => {
    // Create a file whose diff fits but full content exceeds budget
    const largePatch = 'x'.repeat(100);
    const largeContent = 'y'.repeat(800_000); // ~200K tokens, exceeds budget
    const files = [
      { filename: 'big.js', status: 'modified', patch: largePatch, content: largeContent },
    ];
    const { userMessage, truncatedCount } = buildContext(files, {});
    expect(userMessage).toContain('big.js');
    expect(userMessage).toContain('full content omitted');
    expect(truncatedCount).toBe(1);
  });

  it('returns truncatedCount 0 when everything fits', () => {
    const files = [
      { filename: 'small.js', status: 'modified', patch: '+a', content: 'const a = 1;' },
    ];
    const { truncatedCount } = buildContext(files, {});
    expect(truncatedCount).toBe(0);
  });

  it('handles files with no content', () => {
    const files = [
      { filename: 'a.js', status: 'modified', patch: '+line', content: null },
    ];
    const { userMessage, truncatedCount } = buildContext(files, {});
    expect(userMessage).toContain('+line');
    expect(userMessage).not.toContain('Full file content');
    expect(truncatedCount).toBe(0);
  });

  it('sorts by diff size ascending', () => {
    const files = [
      { filename: 'big.js', status: 'modified', patch: 'x'.repeat(1000), content: null },
      { filename: 'small.js', status: 'modified', patch: 'y', content: null },
    ];
    const { userMessage } = buildContext(files, {});
    const bigIdx = userMessage.indexOf('big.js');
    const smallIdx = userMessage.indexOf('small.js');
    expect(smallIdx).toBeLessThan(bigIdx);
  });
});

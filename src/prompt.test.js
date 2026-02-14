import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './prompt.js';

describe('buildSystemPrompt', () => {
  it('injects skills, title, and body', () => {
    const result = buildSystemPrompt('- Flag null access', 'Fix auth bug', 'Fixes login crash');
    expect(result).toContain('- Flag null access');
    expect(result).toContain('Title: Fix auth bug');
    expect(result).toContain('Description: Fixes login crash');
  });

  it('includes response format with category list', () => {
    const result = buildSystemPrompt('skills', 'title', 'body');
    expect(result).toContain('`bug`');
    expect(result).toContain('`security`');
    expect(result).toContain('`performance`');
    expect(result).toContain('JSON array');
  });

  it('includes instruction about diff-only lines', () => {
    const result = buildSystemPrompt('skills', 'title', 'body');
    expect(result).toContain('Only comment on lines that appear in the diff');
  });
});

const DEFAULT_CONTEXT_WINDOW = 200_000;
const RESERVED_SYSTEM = 4_000;
const RESERVED_RESPONSE = 4_000;

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export function getValidLines(patch) {
  if (!patch) return new Set();
  const lines = patch.split('\n');
  const valid = new Set();
  let currentLine = 0;

  for (const raw of lines) {
    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (raw.startsWith('-')) continue;
    if (raw.startsWith('\\')) continue;
    valid.add(currentLine);
    currentLine++;
  }
  return valid;
}

export function extractSnippet(patch, targetLine) {
  if (!patch) return null;
  const lines = patch.split('\n');
  let currentLine = 0;
  const patchLines = [];

  for (const raw of lines) {
    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (raw.startsWith('-')) continue;
    if (raw.startsWith('\\')) continue;
    patchLines.push({ line: currentLine, text: raw.startsWith('+') ? raw.slice(1) : raw });
    currentLine++;
  }

  const idx = patchLines.findIndex(p => p.line === targetLine);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 1);
  const end = Math.min(patchLines.length, idx + 2);
  return patchLines.slice(start, end).map(p => p.text).join('\n');
}

export function buildContext(files, config) {
  const contextWindow = DEFAULT_CONTEXT_WINDOW;
  const budget = contextWindow - RESERVED_SYSTEM - RESERVED_RESPONSE;

  // Sort by diff size ascending — smaller diffs get full context first
  const sorted = [...files].sort((a, b) => {
    const aDiff = estimateTokens(a.patch || '');
    const bDiff = estimateTokens(b.patch || '');
    return aDiff - bDiff;
  });

  let usedTokens = 0;
  let truncatedCount = 0;
  const sections = [];

  for (const file of sorted) {
    const diffText = file.patch || '(no diff available)';
    const diffTokens = estimateTokens(diffText);

    // Always include the diff — skip if even the diff doesn't fit
    if (usedTokens + diffTokens > budget) {
      truncatedCount++;
      continue;
    }

    let fullContent = file.content || null;
    let fullContentIncluded = false;

    if (fullContent) {
      const fullTokens = estimateTokens(fullContent);
      if (usedTokens + diffTokens + fullTokens <= budget) {
        fullContentIncluded = true;
        usedTokens += diffTokens + fullTokens;
      } else {
        // Diff fits, full content doesn't
        usedTokens += diffTokens;
        truncatedCount++;
      }
    } else {
      usedTokens += diffTokens;
    }

    const ext = file.filename.split('.').pop() || '';
    let section = `## File: ${file.filename} (${file.status})\n\n### Diff\n\`\`\`diff\n${diffText}\n\`\`\`\n`;

    if (fullContentIncluded && fullContent) {
      section += `\n### Full file content\n\`\`\`${ext}\n${fullContent}\n\`\`\`\n`;
    } else if (fullContent) {
      section += `\n### Full file content\n(full content omitted — file too large)\n`;
    }

    sections.push(section);
  }

  return {
    userMessage: sections.join('\n---\n\n'),
    truncatedCount,
  };
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const RESERVED_RESPONSE = 4_000;

export function estimateTokens(text) {
  return Math.ceil(text.length / 3);
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

function buildManifest(files) {
  const lines = ['## All changed files in this PR', ''];
  for (const file of files) {
    lines.push(`- \`${file.filename}\` (${file.status})`);
  }
  lines.push('', '---', '');
  return lines.join('\n');
}

function buildFileSection(file, includeFullContent) {
  const diffText = file.patch || '(no diff available)';
  const ext = file.filename.split('.').pop() || '';
  let section = `## File: ${file.filename} (${file.status})\n\n### Diff\n\`\`\`diff\n${diffText}\n\`\`\`\n`;

  if (includeFullContent && file.content) {
    section += `\n### Full file content\n\`\`\`${ext}\n${file.content}\n\`\`\`\n`;
  } else if (file.content) {
    section += `\n### Full file content\n(full content omitted — file too large)\n`;
  }

  return section;
}

export function buildContext(files, config, { systemTokens = 4000 } = {}) {
  const budget = DEFAULT_CONTEXT_WINDOW - systemTokens - RESERVED_RESPONSE;
  const manifest = buildManifest(files);
  const manifestTokens = estimateTokens(manifest);

  // Sort by diff size ascending — smaller diffs get full context first
  const sorted = [...files].sort((a, b) => {
    return estimateTokens(a.patch || '') - estimateTokens(b.patch || '');
  });

  // Pre-compute section costs
  const fileCosts = sorted.map(file => ({
    file,
    diffSection: buildFileSection(file, false),
    fullSection: file.content ? buildFileSection(file, true) : buildFileSection(file, false),
    diffTokens: estimateTokens(buildFileSection(file, false)),
    fullTokens: estimateTokens(file.content ? buildFileSection(file, true) : buildFileSection(file, false)),
  }));

  const chunks = [];
  let currentSections = [];
  let currentTokens = manifestTokens;
  let truncatedCount = 0;

  for (const { file, diffSection, fullSection, diffTokens, fullTokens } of fileCosts) {
    // Try full content first
    if (currentTokens + fullTokens <= budget) {
      currentSections.push(fullSection);
      currentTokens += fullTokens;
    } else if (currentTokens + diffTokens <= budget) {
      // Diff only fits in current chunk
      currentSections.push(diffSection);
      currentTokens += diffTokens;
      if (file.content) truncatedCount++;
    } else {
      // Doesn't fit — flush current chunk and start a new one
      if (currentSections.length > 0) {
        chunks.push(manifest + currentSections.join('\n---\n\n'));
        currentSections = [];
        currentTokens = manifestTokens;
      }

      // Try again in fresh chunk
      if (currentTokens + fullTokens <= budget) {
        currentSections.push(fullSection);
        currentTokens += fullTokens;
      } else if (currentTokens + diffTokens <= budget) {
        currentSections.push(diffSection);
        currentTokens += diffTokens;
        if (file.content) truncatedCount++;
      } else {
        // Even diff alone exceeds a full chunk — skip
        truncatedCount++;
      }
    }
  }

  // Flush remaining
  if (currentSections.length > 0) {
    chunks.push(manifest + currentSections.join('\n---\n\n'));
  }

  if (chunks.length === 0) {
    chunks.push(manifest + '(all files too large for review)');
  }

  return { chunks, truncatedCount };
}

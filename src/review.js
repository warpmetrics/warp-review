import { readFileSync, existsSync } from 'fs';
import { minimatch } from 'minimatch';
import { run, group, call, outcome, act, flush } from '@warpmetrics/warp';
import { createClient } from './llm.js';
import { findRun } from './warpmetrics.js';
import {
  getChangedFiles, getFileContent, getFileViaBlob,
  postReview, getReviewCommentIds, dismissReview,
} from './github.js';
import { buildContext, getValidLines, extractSnippet } from './context.js';
import { buildSystemPrompt } from './prompt.js';

const DEFAULT_SKILLS = readFileSync(new URL('../defaults/skills.md', import.meta.url), 'utf8');
const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL('../defaults/config.json', import.meta.url), 'utf8'));

function readConfig() {
  try {
    if (existsSync('.warp-review/config.json')) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync('.warp-review/config.json', 'utf8')) };
    }
  } catch { /* fall through */ }
  return DEFAULT_CONFIG;
}

function readSkills() {
  try {
    if (existsSync('.warp-review/skills.md')) {
      return readFileSync('.warp-review/skills.md', 'utf8');
    }
  } catch { /* fall through */ }
  return DEFAULT_SKILLS;
}

function parseComments(text) {
  // Strip markdown code fences
  let cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

  // Extract first [...] block
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return JSON.parse(cleaned);
}

async function llmWithRetry(anthropic, params, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (e) {
      const isRetryable = e.status === 429 || e.status === 529 || e.status >= 500 || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND';
      if (!isRetryable || attempt === maxRetries - 1) throw e;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`LLM API error (${e.status || e.code}), retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function buildSummary(commentsPosted, filesReviewed, runId, wmAvailable, { totalFiltered = 0, truncatedCount = 0, actId } = {}) {
  const analyticsLink = wmAvailable && runId
    ? `\n\n[View review analytics \u2192](https://app.warpmetrics.com/runs/${runId})`
    : '';

  const actTag = actId ? `\n\n<!-- wm:act:${actId} -->` : '';

  const notes = [];
  if (totalFiltered > filesReviewed) {
    notes.push(`Reviewed ${filesReviewed}/${totalFiltered} files. Increase \`maxFilesPerReview\` in \`.warp-review/config.json\` to review more.`);
  }
  if (truncatedCount > 0) {
    notes.push(`Context was truncated for ${truncatedCount} large file(s).`);
  }
  const notesText = notes.length > 0 ? '\n\n' + notes.join(' ') : '';

  if (commentsPosted.length > 0) {
    const fileCount = new Set(commentsPosted.map(c => c.file)).size;
    const firstComment = commentsPosted[0].body.slice(0, 100);
    return `**warp-review** found ${commentsPosted.length} issue(s) in ${fileCount} file(s).${notesText}\n\nMost critical: ${firstComment}${analyticsLink}${actTag}\n\n<sub>Powered by [WarpMetrics](https://warpmetrics.com) \u00b7 Edit \`.warp-review/skills.md\` to customize</sub>`;
  }

  return `**warp-review** reviewed ${filesReviewed} file(s) \u2014 no issues found.${notesText}${analyticsLink}${actTag}\n\n<sub>Powered by [WarpMetrics](https://warpmetrics.com)</sub>`;
}

export async function review(ctx) {
  const { owner, repo, fullRepo, pr, headSha, htmlUrl, prAuthor, additions, deletions, changedFiles, baseBranch, title, body } = ctx;

  // 1. Validate LLM API key
  if (!process.env.LLM_API_KEY) {
    console.error('LLM_API_KEY is required for review mode. Set WARP_REVIEW_LLM_API_KEY as a repository secret.');
    process.exitCode = 1;
    return;
  }

  // 2. Read config
  const config = readConfig();

  // 3. Query WarpMetrics for existing run
  let runDetail = null;
  let wmAvailable = true;
  try {
    if (process.env.WARPMETRICS_API_KEY) {
      runDetail = await findRun(fullRepo, pr);
    } else {
      wmAvailable = false;
    }
  } catch (e) {
    console.warn(`WarpMetrics API unreachable \u2014 skipping re-review detection: ${e.message}`);
    wmAvailable = false;
  }

  // 4. Handle re-review: dismiss previous and supersede
  let runRef;
  let nextRoundNum = 1;

  if (runDetail) {
    const rounds = runDetail.groups.filter(g => g.opts?.round);
    const prevRound = rounds.sort((a, b) => b.opts.round - a.opts.round)[0];
    if (prevRound) {
      nextRoundNum = prevRound.opts.round + 1;

      // Find github_review_id in the _summary sub-group
      const prevSummary = prevRound.groups?.find(g => g.label === '_summary');
      const prevReviewId = prevSummary?.opts?.github_review_id;
      if (prevReviewId) {
        await dismissReview(owner, repo, pr, prevReviewId, headSha);
      }

      outcome(prevRound.id, 'Superseded');
    }
    runRef = runDetail.id;
  } else {
    // Create new run (link as follow-up if warp-coder act ID found in PR body)
    if (wmAvailable) {
      const actMatch = body.match(/<!-- wm:act:(wm_act_\w+) -->/);
      const runOpts = {
        name: `${fullRepo}#${pr}`, repo: fullRepo, pr, pr_url: htmlUrl,
        pr_author: prAuthor, additions, deletions, changed_files: changedFiles, base_branch: baseBranch,
      };
      if (actMatch) {
        runRef = run(actMatch[1], 'warp-review', runOpts);
      } else {
        runRef = run('warp-review', runOpts);
      }
    }
  }

  try {
    // 5. Fetch changed files
    const allFiles = await getChangedFiles(owner, repo, pr);

    // 6. Filter files
    const filtered = allFiles.filter(f => {
      if (f.status === 'removed') return false;
      for (const pattern of config.ignorePatterns || []) {
        if (minimatch(f.filename, pattern, { matchBase: true })) return false;
      }
      return true;
    });

    const filesToReview = filtered.slice(0, config.maxFilesPerReview || 15);

    // 7. Fetch full file content
    for (const file of filesToReview) {
      let content = await getFileContent(owner, repo, file.filename, headSha);
      if (content === null && file.sha) {
        content = await getFileViaBlob(owner, repo, file.sha);
      }
      file.content = content;
    }

    // 8. Read skills
    const skills = readSkills();

    // 9. Create WM round group
    const languages = [...new Set(filesToReview.map(f => {
      const parts = f.filename.split('.');
      return parts.length > 1 ? `.${parts.pop()}` : '';
    }).filter(Boolean))];

    const { userMessage, truncatedCount } = buildContext(filesToReview, config);

    let round = null;
    if (runRef) {
      round = group(runRef, `Review ${nextRoundNum}`, {
        round: nextRoundNum, sha: headSha, model: config.model,
        files_reviewed: filesToReview.length, context_truncated: truncatedCount,
        languages, timestamp: new Date().toISOString(),
      });
    }

    // 10. LLM call
    const anthropic = createClient(process.env.LLM_API_KEY);
    const systemPrompt = buildSystemPrompt(skills, title, body);

    let response;
    try {
      response = await llmWithRetry(anthropic, {
        model: config.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (e) {
      console.error(`LLM API unreachable after retries: ${e.message}`);
      const summaryBody = '**warp-review** could not complete the review \u2014 LLM API unreachable.\n\n<sub>Powered by [WarpMetrics](https://warpmetrics.com)</sub>';
      await postReview(owner, repo, pr, headSha, summaryBody, [], { event: 'COMMENT' });
      return;
    }

    if (round) {
      call(round, response);
    }

    // 11. Parse LLM response
    const responseText = response.content?.[0]?.text || '[]';
    let parsedComments;
    try {
      parsedComments = parseComments(responseText);
    } catch {
      // Retry once with correction
      console.warn('LLM returned invalid JSON, retrying...');
      try {
        const retryResponse = await llmWithRetry(anthropic, {
          model: config.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: responseText },
            { role: 'user', content: 'Your previous response was not valid JSON. Respond with ONLY a JSON array, no other text.' },
          ],
        });
        if (round) call(round, retryResponse);
        parsedComments = parseComments(retryResponse.content?.[0]?.text || '[]');
      } catch {
        console.warn('LLM retry also failed — posting summary only');
        parsedComments = [];
      }
    }

    if (!Array.isArray(parsedComments)) parsedComments = [];

    // 12. Validate line numbers
    const filePatches = new Map();
    for (const f of filesToReview) {
      filePatches.set(f.filename, f.patch);
    }

    const validComments = parsedComments.filter(c => {
      if (!c.file || !c.line || !c.body) return false;
      const validLines = getValidLines(filePatches.get(c.file));
      return validLines.has(c.line);
    });

    // Derive runId for summary link
    const runId = typeof runRef === 'string' ? runRef : runRef?.id;
    const hasIssues = validComments.length > 0;

    // 13. Log comment groups + outcome + act to WM (before posting review, so we know the act ID)
    let reviewActId = null;
    let commentIds = [];

    if (round) {
      // Outcome + act on the round (for the chain)
      const outcomeName = hasIssues ? 'Changes Requested' : 'Approved';
      const oc = outcome(round, outcomeName, { comments: validComments.length });
      if (oc) {
        const actRef = act(oc, hasIssues ? 'revise' : 'merge', { pr, repo: fullRepo });
        if (actRef) reviewActId = actRef.id;
      }
    }

    // 14. Post review (with act ID embedded for warp-coder)
    const summaryBody = buildSummary(validComments, filesToReview.length, runId, wmAvailable, {
      totalFiltered: filtered.length, truncatedCount, actId: reviewActId,
    });
    const reviewResult = await postReview(owner, repo, pr, headSha, summaryBody, validComments);
    const reviewId = reviewResult.id;

    // 15. Get comment IDs (matched by array index order)
    if (validComments.length > 0) {
      try {
        commentIds = await getReviewCommentIds(owner, repo, pr, reviewId);
      } catch (e) {
        console.warn(`Failed to get review comment IDs: ${e.message}`);
      }
    }

    // 16. Log comment groups + summary to WM
    if (round) {
      for (let i = 0; i < validComments.length; i++) {
        const c = validComments[i];
        const snippet = extractSnippet(filePatches.get(c.file), c.line);
        const ghId = commentIds[i] || null;
        group(round, `${c.file}:${c.line}`, {
          file: c.file, line: c.line, body: c.body, category: c.category,
          ...(snippet && { snippet }), github_comment_id: ghId,
        });
      }

      group(round, '_summary', {
        comments_generated: parsedComments.length,
        comments_posted: validComments.length,
        comments_dropped: parsedComments.length - validComments.length,
        github_review_id: reviewId,
      });
    }

    console.log(`warp-review: posted ${validComments.length} comment(s) on PR #${pr}`);
  } finally {
    // 16. Flush
    try {
      await flush();
    } catch (e) {
      console.warn(`Failed to flush WarpMetrics events: ${e.message}`);
    }
  }
}

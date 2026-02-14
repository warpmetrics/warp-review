import { readFileSync } from 'fs';
import { review } from './review.js';
import { trackOutcome } from './outcome.js';

function getContext() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pull = event.pull_request;

  return {
    owner,
    repo,
    fullRepo: `${owner}/${repo}`,
    pr: pull.number,
    action: event.action,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    title: pull.title,
    body: pull.body || '',
    htmlUrl: pull.html_url,
    prAuthor: pull.user.login,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    baseBranch: pull.base.ref,
    merged: pull.merged || false,
    mergedBy: pull.merged_by?.login || null,
  };
}

async function main() {
  const mode = process.env.MODE || 'review';
  const ctx = getContext();

  if (mode === 'review') {
    await review(ctx);
  } else if (mode === 'outcome') {
    await trackOutcome(ctx);
  } else {
    console.error(`Unknown mode: ${mode}. Use 'review' or 'outcome'.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('warp-review failed:', err.message);
  process.exitCode = 1;
});

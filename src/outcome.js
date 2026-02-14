import { outcome, flush } from '@warpmetrics/warp';
import { findRun } from './warpmetrics.js';
import { buildThreadMap, getThreadStatus } from './github.js';

export async function trackOutcome(ctx) {
  const { owner, repo, fullRepo, pr, merged, mergedBy } = ctx;

  // 1. Find the run
  let runDetail;
  try {
    if (!process.env.WARPMETRICS_API_KEY) return;
    runDetail = await findRun(fullRepo, pr);
  } catch (e) {
    console.warn(`WarpMetrics API unreachable during outcome tracking: ${e.message}`);
    return;
  }

  // 2. No run found — exit silently
  if (!runDetail) return;

  try {
    // 3. PR-level outcome
    if (merged) {
      outcome(runDetail.id, 'Merged', { merged_by: mergedBy });
    } else {
      outcome(runDetail.id, 'Closed');
    }

    // 4. Find active round (non-Superseded)
    const activeRound = runDetail.groups
      .filter(g => g.opts?.round)
      .sort((a, b) => b.opts.round - a.opts.round)
      .find(g => !g.outcomes?.some(o => o.name === 'Superseded'));

    if (!activeRound) return;

    // 5. Round-level outcome
    outcome(activeRound.id, 'Active');

    // 6. Comment-level outcomes
    const threadMap = await buildThreadMap(owner, repo, pr);

    const commentGroups = (activeRound.groups || []).filter(g => g.label !== '_summary');
    for (const commentGroup of commentGroups) {
      const commentId = commentGroup.opts?.github_comment_id;
      if (!commentId) continue;

      const thread = await getThreadStatus(commentId, threadMap, fullRepo);
      if (thread.resolved) {
        outcome(commentGroup.id, 'Accepted');
      } else {
        const opts = thread.latestReply ? { reason: thread.latestReply } : {};
        outcome(commentGroup.id, 'Ignored', opts);
      }
    }
  } finally {
    // 7. Flush
    try {
      await flush();
    } catch (e) {
      console.warn(`Failed to flush WarpMetrics events: ${e.message}`);
    }
  }
}

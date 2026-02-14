function ghHeaders() {
  return {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      const delay = retryAfter * 1000 * (attempt + 1);
      console.warn(`Rate limited by GitHub API, retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  throw new Error(`GitHub API rate limit exceeded after ${maxRetries} retries`);
}

export async function getChangedFiles(owner, repo, pr) {
  const files = [];
  let page = 1;
  while (true) {
    const res = await fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100&page=${page}`,
      { headers: ghHeaders() },
    );
    if (!res.ok) throw new Error(`Failed to fetch changed files: ${res.status}`);
    const batch = await res.json();
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return files;
}

export async function getFileContent(owner, repo, path, ref) {
  const res = await fetchWithRetry(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    { headers: ghHeaders() },
  );

  if (res.status === 403) {
    // File too large for contents API — try Git Blob API
    // Need to get the file SHA first from the tree
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  // Binary file or unexpected encoding
  return null;
}

export async function getFileViaBlob(owner, repo, sha) {
  const res = await fetchWithRetry(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`,
    { headers: ghHeaders() },
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  return null;
}

export async function postReview(owner, repo, pr, headSha, body, comments) {
  const res = await fetchWithRetry(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/reviews`,
    {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({
        commit_id: headSha,
        body,
        event: 'COMMENT',
        comments: comments.map(c => ({
          path: c.file,
          line: c.line,
          side: 'RIGHT',
          body: c.body,
        })),
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post review: ${res.status} ${text}`);
  }
  return res.json();
}

export async function getReviewCommentIds(owner, repo, pr, reviewId) {
  const res = await fetchWithRetry(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/reviews/${reviewId}/comments`,
    { headers: ghHeaders() },
  );
  if (!res.ok) throw new Error(`Failed to fetch review comments: ${res.status}`);
  const comments = await res.json();
  return comments.map(c => c.id);
}

export async function dismissReview(owner, repo, pr, reviewId, headSha) {
  const shortSha = headSha.slice(0, 7);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/reviews/${reviewId}/dismissals`,
      {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({ message: `Superseded by new review after commit ${shortSha}` }),
      },
    );
    if (!res.ok) {
      console.warn(`Failed to dismiss review ${reviewId}: ${res.status} — posting new review alongside old one`);
    }
  } catch (e) {
    console.warn(`Failed to dismiss review ${reviewId}: ${e.message} — continuing`);
  }
}

export async function buildThreadMap(owner, repo, pr) {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes { isResolved, comments(first: 1) { nodes { databaseId } } }
        }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ query, variables: { owner, repo, pr } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL error: ${res.status}`);
  const { data } = await res.json();

  const map = new Map();
  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  for (const thread of threads) {
    const id = thread.comments.nodes[0]?.databaseId;
    if (id) map.set(id, { resolved: thread.isResolved });
  }
  return map;
}

export async function getThreadStatus(commentId, threadMap, fullRepo) {
  const thread = threadMap.get(commentId);
  if (!thread) return { resolved: false, latestReply: null };

  let latestReply = null;
  if (!thread.resolved) {
    try {
      const res = await fetchWithRetry(
        `https://api.github.com/repos/${fullRepo}/pulls/comments/${commentId}/replies`,
        { headers: ghHeaders() },
      );
      if (res.ok) {
        const replies = await res.json();
        if (replies.length > 0) {
          latestReply = replies[replies.length - 1].body.slice(0, 280);
        }
      }
    } catch {
      // Failed to fetch replies — leave latestReply as null
    }
  }
  return { resolved: thread.resolved, latestReply };
}

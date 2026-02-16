const API = 'https://api.warpmetrics.com/v1';

function headers() {
  return { Authorization: `Bearer ${process.env.WARPMETRICS_API_KEY}` };
}

export async function findRun(repo, pr) {
  const name = `${repo}#${pr}`;
  const res = await fetch(
    `${API}/runs?label=${encodeURIComponent('Code Review')}&name=${encodeURIComponent(name)}&limit=1`,
    { headers: headers() },
  );
  if (!res.ok) {
    throw new Error(`WarpMetrics API error: ${res.status} ${res.statusText}`);
  }
  const { data } = await res.json();

  if (!data || !data.length) return null;

  const detail = await fetch(`${API}/runs/${data[0].id}`, { headers: headers() });
  if (!detail.ok) {
    throw new Error(`WarpMetrics API error fetching run detail: ${detail.status}`);
  }
  const result = await detail.json();
  return result.data;
}

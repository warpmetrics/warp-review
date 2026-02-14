# warp-review

AI code reviewer that learns your codebase. Powered by [WarpMetrics](https://warpmetrics.com).

![warp-review](https://img.shields.io/badge/warp--review---%25%20accepted-purple)

## Quickstart

```
npx @warpmetrics/review init
```

That's it. Open a PR and warp-review will post its first review.

## What it does

- Reviews every PR with AI (Claude)
- Posts inline comments on specific lines with suggested fixes
- Tracks which comments get accepted or ignored
- Learns your team's preferences via a local skills file
- Sends telemetry to WarpMetrics so you can see review effectiveness over time

## How it works

```
PR opened/synchronize          PR closed
       |                           |
       v                           v
 Review Job                  Outcome Job
 1. Fetch diff + files       1. Find run via WM API
 2. Read skills.md           2. Log PR outcome (merged/closed)
 3. One LLM call             3. Check thread resolution
 4. Post inline comments     4. Log comment outcomes
 5. Log to WarpMetrics          (accepted/ignored)
```

Each review posts inline comments directly on the lines that need attention. When the PR closes, warp-review checks which comments were resolved (accepted) and which were ignored, logging everything to WarpMetrics.

## Configuration

### `.warp-review/config.json`

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `claude-sonnet-4-20250514` | Anthropic model to use |
| `maxFilesPerReview` | `15` | Maximum files to review per PR |
| `ignorePatterns` | `["*.lock", ...]` | Glob patterns for files to skip |

### `.warp-review/skills.md`

This file is the repo-local brain of warp-review. It ships with sensible defaults covering bugs, security issues, and common pitfalls. Edit it to teach warp-review your team's conventions.

See [`defaults/skills.md`](defaults/skills.md) for the full default file.

## Analytics

warp-review sends review telemetry to [WarpMetrics](https://warpmetrics.com). See which comments get accepted, how much each review costs, and how your acceptance rate changes over time.

Get your API key at [warpmetrics.com/app/api-keys](https://warpmetrics.com/app/api-keys).

## FAQ

**Does it review every PR?**
Yes, on every `opened` and `synchronize` (new commits pushed) event.

**What if I don't want it to review certain files?**
Add glob patterns to `ignorePatterns` in `.warp-review/config.json`.

**Can I use it without WarpMetrics?**
No — WarpMetrics is required for outcome tracking and the review lifecycle. It's free to sign up.

**Does it work on PRs from forks?**
No. GitHub doesn't expose repository secrets to fork PRs for security reasons, so the API keys aren't available. This is a GitHub limitation.

**Is my code sent to WarpMetrics?**
No. Your code goes to Anthropic's API. WarpMetrics only receives metadata: token counts, latency, cost, comment text, and outcomes.

## License

MIT

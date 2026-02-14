# warp-review skills

These rules guide how warp-review reviews your code. Edit this file to teach
warp-review your team's preferences. The more specific you are, the better
the reviews get.

Check your review analytics at https://app.warpmetrics.com to see which
comments lead to merged changes and which get ignored — then update these
rules accordingly.

---

## General

- Focus on bugs, logic errors, and security issues over style nitpicks
- Don't comment on formatting — assume the repo has a formatter
- If a pattern appears intentional and consistent, don't flag it
- Limit to 5 comments per file maximum — prioritize by severity

## What to flag

- Null/undefined access without guards
- Unhandled promise rejections or missing error handling
- SQL injection, XSS, or other injection vulnerabilities
- Race conditions in async code
- Resource leaks (unclosed connections, file handles, streams)
- Hardcoded secrets or credentials
- Off-by-one errors in loops and array access
- Missing input validation on public API boundaries

## What to ignore

- Import ordering
- Variable naming preferences (unless misleading)
- Comment style or missing comments
- Minor type annotation differences
- Whitespace or formatting

## Repo-specific rules

<!-- Add your own rules below. Examples: -->
<!-- - We use Result<T, E> pattern for error handling, don't suggest try/catch -->
<!-- - All database queries must go through the QueryBuilder, never raw SQL -->
<!-- - React components must use named exports, not default exports -->

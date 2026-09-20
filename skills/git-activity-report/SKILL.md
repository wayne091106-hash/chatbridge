---
name: Git activity report
description: Summarise recent commits and uncommitted work across the owner's local repositories (daily/weekly report)
tags: [git, report, projects, daily]
version: 1
created: 2026-09-18T00:00:00.000Z
updated: 2026-09-18T00:00:00.000Z
uses: 0
successes: 0
origin: bundled
---

## When to use
"What did I work on", daily stand-up notes, scheduled morning summaries of project changes.

## Steps
1. Find repositories (limit depth; common roots are Desktop, Documents, source folders):
   `Get-ChildItem $env:USERPROFILE\Desktop, $env:USERPROFILE\Documents -Directory -Recurse -Depth 3 -Filter .git -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Parent.FullName }`
   Remember discovered roots with memory_save so later runs skip the scan.
2. For each repo (since = "yesterday" or "7 days ago"):
   - `git -C REPO log --since="yesterday" --pretty=format:"%h %an %ar %s" --no-merges`
   - `git -C REPO status --short --branch`
   - `git -C REPO diff --stat` for uncommitted size.
3. Skip repos with no activity. Group the rest: shipped (commits), in progress (uncommitted), stale branches ahead/behind.

## Report format
- One heading per active repo: 1–3 bullets of what changed (summarise commit messages, don't list every hash).
- "Uncommitted work" section with file counts.
- End with suggested next actions only if obvious (e.g. push unpushed commits).

## Pitfalls
- Chinese commit messages print correctly only with UTF-8 output (the shell prelude sets it).
- `git log --since` uses committer date; rebased commits may look new.
- Never run fetch/pull/push in a report job unless asked.

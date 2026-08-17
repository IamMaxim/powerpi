---
description: Draft an MR/PR title and description for the current branch
argument-hint: "[target-branch]"
---
Draft a merge-request title and description for the current branch, diffed
against the target branch (argument, default: the repo's default branch).
Review the full diff and the branch's commits first.

Doctrine — written for a human who has not seen the diff and was not in this
conversation:

- Title: the purpose of the change as one plain imperative sentence — what it
  accomplishes or which problem it removes, never which files it touches.
- Description: prose, not bullet inventories. Cover, in order: why the change
  exists (problem or motivation); the approach and any decision a reviewer
  might question (what you chose, briefly what you rejected); how it was
  verified. End with at least one sentence on verification — or an honest
  "not verified beyond compilation/CI".
- Skip anything the diff already says plainly. Never enumerate changed files.
- Short lists only for genuinely enumerable facts a reader must not miss:
  breaking changes, migration steps, a test matrix.
- Length scales with risk and novelty, not line count: a mechanical rename
  gets one sentence; a design-heavy change gets a few paragraphs.
- Never: "This MR introduces…", "Changes include:", "## Summary" scaffolding,
  emoji.
- If the repository defines its own MR template, that wins.

Output the title and description as plain text ready to paste.

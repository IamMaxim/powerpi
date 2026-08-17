---
description: Write a commit message for staged changes and commit
---
Review the staged changes (`git diff --cached`; if nothing is staged, say so
and stop). Then write a commit message and commit.

Message doctrine — written for a human who has not seen the diff:

- Subject: the change's intent as one plain imperative sentence — what it
  accomplishes or which problem it removes, never which files or functions it
  touches. "Stop leaking sessions when a user is deleted", not "Add cascade
  delete to session table".
- Body: the why, in prose, only when it isn't obvious from the subject.
- Never: "This commit introduces…", bullet lists that are really a diff
  summary, scaffolding headers, emoji.
- If the repository defines its own commit convention, that wins.

Show the message, then run `git commit`.

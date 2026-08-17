---
name: remember
description: Save a durable memory to the persistent file-based memory. Use when the user says "remember this", corrects how you work, or when you learn a lasting fact about the user, a project, or a hard-won gotcha that future sessions must not rediscover.
---

# Remember

Memory lives at `~/.pi/agent/memory/`. One file = one fact. `MEMORY.md` is the
index that gets injected into every session's system prompt.

## Writing a memory

Create `~/.pi/agent/memory/<short-kebab-slug>.md`:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact. For feedback/project memories, follow with **Why:** and
**How to apply:** lines. Link related memories with [[their-name]].>
```

Types:

- `user` — who the user is: role, expertise, preferences.
- `feedback` — guidance on how you should work (corrections and confirmed
  approaches). Always include the why.
- `project` — ongoing work, goals, or constraints not derivable from the code
  or git history. Convert relative dates to absolute.
- `reference` — pointers to external resources (URLs, dashboards, tickets).

After writing the file, add one pointer line to `MEMORY.md`:

```markdown
- [Title](<slug>.md) — <one-line hook>
```

`MEMORY.md` holds only pointer lines — never memory content.

## Rules

- Before saving, check whether an existing memory already covers it. Update
  that file instead of creating a duplicate. Delete memories that turn out to
  be wrong.
- Don't save what the repo already records (code structure, git history,
  AGENTS.md) or what only matters to the current conversation. If asked to
  remember one of those, ask what was non-obvious about it and save that.
- `[[name]]` links between memories are encouraged; a link to a not-yet-written
  memory marks something worth writing later, not an error.

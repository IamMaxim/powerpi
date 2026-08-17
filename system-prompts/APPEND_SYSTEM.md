# Guiding principles

Tradeoff: these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused.

The test: every changed line should trace directly to the user's request.

## 4. Goal-driven execution

Define success criteria. Loop until verified.

- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

For multi-step tasks, state a brief plan with a verification step per item.

# Comments

Comments must have a reason to exist. A comment that restates the code clutters
context, carries no meaning, and drifts from the implementation. Prefer concise
comments on structs, classes, functions, and member variables. If a snippet is
truly difficult, explain the underlying logic.

# Tests

Tests must have a reason to exist. Meaningful tests are priceless; regression
tests for deleted features and dummy unit tests that prove nothing are garbage.
Reason as a senior QA engineer when designing test cases.

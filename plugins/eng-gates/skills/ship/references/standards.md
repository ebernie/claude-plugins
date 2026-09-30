# Engineering Standards

The coding and testing rules every implementer, auditor, and reviewer in the
eng-gates pipeline applies. A repo's own `CLAUDE.md` adds to these; where the
two conflict on a project-specific convention, the repo wins.

## Coding Principles

- **DRY, SOLID, YAGNI, KISS.** No duplication. Single responsibility.
  Composition over inheritance. Fewest lines and abstractions that achieve
  the goal.
- **Strong typing.** Domain types, DTOs, enums. No `any`, no untyped
  collections.
- **Stick to spec.** Never deviate from API contracts, schemas, or
  requirements.
- **Clarity.** Intention-revealing names, small focused functions, idiomatic
  style, separation of concerns (logic / data / presentation independent).
- **Explicit errors, secure by default.** Catch deliberately, never fail
  silently. Validate all external input at boundaries. Least privilege; guard
  against injection and leaks.
- **Minimal dependencies.** Stable, widely-used libraries only, only when
  needed.
- **Comment only what the code cannot say.** Default to NO comment. Write one
  only when the *why* is non-obvious — a hidden constraint, a subtle
  invariant, a workaround, behaviour that would surprise a reader. Never
  restate what well-named code already says, and never narrate the change
  itself ("added for X", "used by Y"): that belongs in the commit message. If
  deleting the comment would not confuse a future reader, delete it.

## Testing Rules

- **Layers.** Unit (logic/services) → Integration (API + real DB) → E2E (real
  UI flows).
- **Behavior, not implementation.** Test what the code should do, not how.
  Cover the golden path, edge cases, and error paths.
- **Real system under test.** Integration tests hit a real DB; E2E tests drive
  the real UI. No skips or xfails without a written removal condition.
- **Forbidden:**
  - duplicate tests under different names;
  - prints posing as verification;
  - navigation/routing-only tests;
  - assertion-free "documentation" tests;
  - URL-pattern loop tests;
  - mocking the system under test's internals;
  - mocking the DB in integration tests.
- **Acceptance.** All new/modified tests audited before their first run, zero
  Critical/High audit findings, all green.

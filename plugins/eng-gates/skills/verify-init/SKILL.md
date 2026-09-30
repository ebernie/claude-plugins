---
name: verify-init
description: Generates this repo's project verify skill (.claude/skills/verify/SKILL.md, invoked as /verify) — discovers how to launch and drive the app, asks only what discovery cannot settle, writes the skill with the fixed contract /eng-gates:ship depends on, and smoke-validates it. Run once per repo before /eng-gates:ship; re-run to update. Usage - /eng-gates:verify-init
---

# /eng-gates:verify-init — generate the project /verify skill

/eng-gates:ship ends with a user-level walk of the change through its real
interface. How to launch, drive, and capture evidence is project-specific, so
it lives in the repo at `.claude/skills/verify/SKILL.md`. This skill writes
it. The generated skill must follow the contract below exactly — /ship
depends on its sections and its output.

## Phase 1 — Preflight (main loop)

1. `git rev-parse --show-toplevel` must succeed; that is `<repoRoot>`. Not a
   git repo → stop and say so.
2. If `<repoRoot>/.claude/skills/verify/SKILL.md` exists, read it and ask the
   user (AskUserQuestion): **update** (keep what is there, fill gaps and fix
   drift from discovery), **overwrite** (regenerate from scratch), or
   **abort**.

## Phase 2 — Discover (sub-agent, read-only)

Delegate to ONE `Agent` call, `subagent_type` `Explore` (else
`general-purpose`), `model: sonnet` passed explicitly. Read-only: it never
edits, installs, or launches anything. Brief it to report, with file paths
as evidence:

- **Surfaces** — web, mobile, CLI, library/backend; possibly several. Infer
  from manifests and configs (`package.json` scripts/bin, `pyproject.toml`
  scripts, `Cargo.toml` `[[bin]]`, `go.mod` + `cmd/`, Gradle/Xcode projects,
  Dockerfiles, compose files, framework configs).
- **Launch & teardown** — dev/start commands, compose services, ports and
  URLs, how to stop cleanly.
- **Readiness signal** — health endpoint, log line, or port to poll.
- **Data** — seed/fixture/migration scripts, how to reset state.
- **Test accounts** — how a test user is created or where credentials come
  from (env var names only; never values).
- **Env** — `.env.example` / sample config files, required variables.
- **Existing tooling** — Playwright config, emulator/simulator config, E2E
  helpers.
- **CLI entry points** — binary names, build step, a realistic invocation.

State anything it could not determine as unknown, not guessed.

## Phase 3 — Ask (main loop, AskUserQuestion)

Few questions, only what discovery did not settle. Pre-fill options from
discovery.

1. **Surfaces** to verify (multi-select from those discovered).
2. **Launch command** — confirm or correct the discovered one per surface.
3. **Test credentials** — the ENV VAR NAMES that hold them. Never accept or
   write credential values into the skill; if the user pastes a value, refuse
   to record it and ask for the variable name.
4. **Evidence storage:**
   - (a) **Committed on the PR branch** under
     `.claude/verify/evidence/<slug>/`, embedded in the PR via
     `https://github.com/<owner>/<repo>/blob/<branch>/<path>?raw=true`
     (Recommended — the PR is reviewable on its own). The caller commits
     the files; /verify only writes them.
   - (b) **Local only** — same path, gitignored; the PR gets a text summary.

## Phase 4 — Generate `<repoRoot>/.claude/skills/verify/SKILL.md`

Frontmatter: `name: verify`, and a description naming the surfaces and that
it is the user-level exercise gate for /eng-gates:ship. Then these sections,
in this order, with these headings — no others. Fill every placeholder with
the discovered/confirmed concrete commands, URLs, ports, and paths; leave no
`<TODO>`.

1. **Prerequisites** — tools, env vars (names only), services, one-time
   setup (install deps, run migrations, seed).
2. **Launch & teardown** — exact commands per surface, run in the background
   where long-lived; teardown commands that always run, even after a failure.
3. **Readiness check** — the exact probe (curl health URL, wait for log line,
   poll port) with a timeout; not ready in time → BLOCKED.
4. **Walkthrough recipes** — ONLY for chosen surfaces:
   - **Web** — Playwright MCP: navigate the real flow at `<base URL>`, sign in
     via `<ENV VAR>` credentials if needed, interact with the change,
     screenshot the end state, confirm persistence (reload, or query the DB
     with `<command>`).
   - **Mobile** — build and install on the emulator/simulator
     (`<build/install commands>`), walk the affected screens, screenshot each.
   - **CLI** — run the real binary (`<invocation>`) on realistic input; check
     stdout, stderr, exit code, and side effects (files, DB rows).
   - **Library/backend** — call the public entry point from a scratch script
     outside the source tree, or curl the running server (`<base URL>`);
     confirm observable behavior.
5. **Evidence contract** — location (`.claude/verify/evidence/<slug>/`, slug
   from the branch or requirement), a run id (`<UTC timestamp>-<short sha>`)
   in every file name or a `run.txt`, descriptive names
   (`after-checkout-flow.png`, `cli-run.txt`), and the storage choice:
   (a) the files must be committed on the PR branch — by the caller
   (/eng-gates:ship Phase 5); /verify never commits; or (b) the path is
   gitignored and files stay local.
6. **Output contract** — end every run by printing:
   - a fenced markdown block titled `PR evidence`: run id, surface, flow
     walked, per-step result, and evidence — for (a) images embedded via
     `https://github.com/<owner>/<repo>/blob/<branch>/<path>?raw=true`
     (owner/repo from `gh repo view`, branch from `git branch
     --show-current`), captured output inline; for (b) a text
     summary of what each artifact showed;
   - a proposed verdict: `PASS` or `FAIL` with reasons, or `BLOCKED` with the
     reason.
7. **Rules** —
   - Walk the real interface. Tests passing is not evidence.
   - The verifier never fixes; it reports findings.
   - If the environment cannot run the walk (no browser, emulator, service,
     or credentials), report `BLOCKED` with the reason — never self-pass.
   - Never print or store credential values.
   - Always tear down.

For option (b), add `.claude/verify/evidence/` to `<repoRoot>/.gitignore`.

## Phase 5 — Smoke-validate (sub-agent)

Launch ONE `Agent` (`general-purpose`, `model: sonnet`, high effort): read the
generated skill, run Prerequisites (non-destructive steps only), Launch, and
the Readiness check for each chosen surface, then Teardown. It reports each
command, its outcome, and any error output. It does not walk flows and does
not edit the skill.

On failure: fix the skill in the main loop from the report (or ask the user
when the fix needs information only they have), then re-validate. Max 2
retries. Still failing → say plainly that the skill is NOT validated, what
failed, and what the user must fix; do not present it as ready.

## Phase 6 — Hand-off

Tell the user:

- the generated path and a one-line summary per section;
- the smoke-validation result;
- to commit `.claude/skills/verify/` (and the `.gitignore` change for option
  b) so /eng-gates:ship finds it on every branch;
- then run `/eng-gates:ship <requirement>`.

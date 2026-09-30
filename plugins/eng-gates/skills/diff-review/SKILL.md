---
name: diff-review
description: Local adversarial code review of the working diff — parallel dimension finders, refutation verifiers, findings ranked and reported via ReportFindings. Runs entirely on this machine; nothing is uploaded and nothing is separately billed. Satisfies Step 8 of the mandatory workflow. Usage - /diff-review [light|quick|standard|deep] [<git range or path>]
---

# /diff-review — local, adversarial, working-diff review

This is **not** the native `/code-review`, which bundles the branch, ships it
to a separately billed cloud service, and must stay user-triggered. This is
the local derivative: same find → verify → rank → report shape, run by
sub-agents on this machine, so an agent may run it freely. Never report that
`/code-review` ran — this gate is satisfied by a `/diff-review` run.

## Arguments

`/diff-review [effort] [scope]` — both optional, any order.

- **effort**: `light` | `quick` | `standard` | `deep`. Default: **auto** — pick
  the tier in Phase 1 step 5 from the diffstat; never silently default to
  `standard`.
- **scope**: a git range (`master..HEAD`), `--staged`, or a path. Default:
  everything uncommitted plus everything on this branch not on the default
  branch.

## Phase 1 — Resolve scope (main loop, before anything else)

1. Confirm you are in a git repo. If not, stop and say so.
2. Default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (strip
   `origin/`), falling back to `master` then `main`.
3. Build the range:
   - explicit range → use it verbatim
   - `--staged` → `git diff --staged`
   - otherwise → `git merge-base --fork-point <default> HEAD` (falling back to
     plain `git merge-base`) as base; review `<base>..HEAD` **plus** the dirty
     working tree (`git status --porcelain`), including non-ignored untracked
     files.
4. Print the resolved scope and the diffstat. Empty diff → stop and report
   `N/A — empty diff`. Never review a clean tree and call it a pass.
5. **Pick the tier** when the user did not pass one. Ordered — first match
   wins:
   - `deep` — explicitly requested, **or** the diff exceeds ~2000 changed
     lines, **or** it touches auth, tenancy, or DB migrations. Nothing else
     reaches `deep`; a merely multi-package or multi-thousand-line-adjacent
     diff is `standard`.
   - `light` — under ~30 changed lines AND no product source: tests, goldens,
     docs, comments, config, CI. Anything that changes runtime behaviour is at
     least `quick`, however small.
   - `quick` — only scripts/tooling, docs, tests, or config; **or** under ~400
     changed lines. For pure scripts/docs diffs also narrow the finders by
     passing `"dims": ["correctness", "security"]`.
   - `standard` — everything else.

   State the chosen tier and the rule that picked it before launching.
6. Note the repo's root `CLAUDE.md` and any `CLAUDE.md` in a touched
   directory. Their rules are review criteria.

## Light tier — one reviewer, no workflow

`light` skips the Workflow tool entirely: one reviewer reads the diff against
the guidance files, scores each candidate 0–100 for confidence, and reports
only what it is ≥ 80 sure of. No dimension fan-out, no refuters — the
confidence gate is the false-positive control. Launch ONE `Agent` call:

- `subagent_type`: `feature-dev:code-reviewer` when installed, else
  `general-purpose` carrying the same instructions in the prompt.
- `model`: `sonnet`, passed explicitly on either agent type.
- Prompt: the resolved range, whether the dirty tree is included, absolute
  guidance-file paths, the scope note, and these rules verbatim — review ONLY
  the diff; a pre-existing issue in untouched code is not a finding; every
  finding needs a concrete failure scenario, a real file and 1-indexed line,
  and a confidence score; report only confidence ≥ 80, grouped Critical /
  Important; say plainly when nothing clears the bar.
- Read-only: the reviewer never edits.

Then go straight to Phase 3 with `level: low` and every finding's `verdict` set
to `PLAUSIBLE` — nothing refuted it, but nothing tried to. If it reports a
Critical, fix and re-review at `quick`: a `light` run that finds a Critical
was the wrong tier.

## Phase 2 — Run the review (Workflow tool; `quick` and above)

Invoking this skill **is** the opt-in to multi-agent orchestration. Call the
Workflow tool with:

- `scriptPath`: absolute path of `diff-review-workflow.js` in this skill's
  directory (expand `~` yourself — the tool will not)
- `args`: `{ "range": "<resolved range>", "includeDirty": true|false,
  "effort": "quick|standard|deep", "repoRoot": "<abs path>",
  "guidanceFiles": ["<abs CLAUDE.md paths>"], "scopeNote": "<one line>" }`
  - optional `"dims"`: dimension keys to run instead of the tier's default set
  - optional `"priorFindings"`: one-line summaries of findings just fixed —
    switches finders into fix-verification mode (see re-review below)

Finders run in parallel across dimensions and each finding pipelines straight
into adversarial verification, so a finding verifies while other dimensions
are still searching.

Agent budget — finders: `quick` 3 (2 with the scripts/docs `dims` override),
`standard` 4, `deep` 6, with a second round only when round 1 produced ≥4 raw
findings. Refuters per **critical/high** finding: 1 / 2 / 2 by tier;
medium/low always get one. Every finder and refuter runs on Sonnet at high
effort; only scope resolution and reporting stay in the main loop. The
`test-coverage` finder is capped at 3 findings — its highest-impact gaps —
because untested-behaviour findings are the cheapest to generate and the most
numerous. A large diff at `deep` can still exceed a 15-agent guideline — that
is expected for this gate; say so rather than silently trimming.

**If the Workflow tool is unavailable**, fall back to launching the same
dimension finders as parallel `Agent` calls and verifying survivors the same
way. That fallback is legitimate; a single agent skimming the diff is not.

## Phase 3 — Report

Report **only** through `ReportFindings`, called once:

- `level`: `low` for light and quick, `high` for standard, `max` for deep
- `findings`: survivors only, ranked most-severe first, `verdict` on each
  (`CONFIRMED` = no verifier refuted it; `PLAUSIBLE` = a minority did, or the
  tier was `light` and no verifier ran)
- empty array when nothing survived — a real, good outcome

Do not also print the findings as prose. Alongside the call state only: the
resolved scope, the effort, agent counts, a severity tally
(`2 critical / 1 high / 3 medium`), and anything deliberately **not** covered
(files skipped, caps hit). Never let a truncation read as full coverage.

## Re-review after fixes

Fixing this run's findings does NOT trigger a fresh full run. Re-review at
`quick`, scoped to only the fixed files — or at `light` when the fix itself
meets the `light` rule — passing the fixed findings as `priorFindings` (one
line each) so finders verify resolution instead of re-discovering the diff; at
`light`, list them in the reviewer's prompt and ask it to confirm each. At
most once by default; escalate to a full-tier re-run only when the fixes were
themselves feature-sized.

## Review dimensions

The script owns the exact prompts; this is each finder's remit.

1. **Correctness** — logic errors, off-by-one, wrong operators, unhandled
   error paths, async/ordering bugs, stale state, boundary values,
   null/undefined, silently swallowed failures.
2. **Contracts & security** — external input validated at the boundary, authz
   and tenancy checks, injection, secrets or PII in logs/responses, least
   privilege, API/schema contract drift.
3. **Convention adherence** — the repo's own `CLAUDE.md` rules, verified
   against the file rather than assumed. Only flag a rule the file states;
   quote it.
4. **Test quality** — does a new behavior have a test that would fail without
   the change; forbidden patterns (duplicate tests renamed, assertion-free
   tests, mocking the system under test, mocked DB in an integration test).
   Capped at 3 findings.
5. **Simplification & efficiency** (deep only) — duplication, needless
   abstraction, dead code, N+1 queries, avoidable work in a hot path. Omitted
   from `standard`; `/simplify` covers this ground on demand.
6. **Integration & blast-radius** (deep only) — callers not updated for a
   changed signature or return shape, backward-incompatible migrations,
   changed defaults silently altering behavior, config/env not wired
   everywhere it must be.

## Rules that don't bend

- **Every finding needs a concrete failure scenario** — specific inputs or
  state producing a specific wrong result. "This could be fragile" is not a
  finding and must be dropped, not downgraded.
- **Verification is adversarial.** Verifiers are told to *refute* and to
  default to refuted when uncertain. Majority-refuted findings are discarded
  silently, not reported as low confidence.
- **Only the diff is in scope.** A pre-existing issue in untouched code is not
  a finding — unless the change newly makes it reachable, in which case say so.
- **No fabricated line numbers.** Every finding cites a real file and a real
  1-indexed line in the reviewed diff. Verify before reporting.
- **Never conclude from a clean run that the code is correct** — only that
  this review found nothing that survived refutation.

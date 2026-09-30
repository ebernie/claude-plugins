---
name: ship
description: Full delivery pipeline for one requirement — plan in the main loop, implement with Sonnet, tests audited before first run, workflow pre-review then a formal /diff-review gate capped at 3 runs, user-level exercise, then a draft PR. Usage - /ship <requirement>
---

# /ship — one requirement, gated, to a draft PR

You are the orchestrator. Run the phases in order. Never skip a gate: if one
cannot pass within its bounds, stop, report it as FAILED, and do not open a PR.
The requirement is the text passed to /ship; if empty, ask for it.

## Phase 1 — Understand & plan (main loop)

1. Restate the requirement in one paragraph. If it is ambiguous in a way that
   changes what gets built, ask the user — in a background session this parks
   the session as "needs input", which is correct. Otherwise state your
   assumptions and proceed.
2. Explore the repo enough to plan: entry points, conventions, how tests are
   organized, and the exact command that runs the test suite.
3. Write the plan to `.claude/ship/plan.md` in the repo (create the directory;
   gitignore `.claude/ship/*`, with a negation for the committed evidence dir
   — `!.claude/ship/evidence/` — only if the repo has no `/verify` skill of
   its own, since with one the evidence is not committed). The plan covers: files to touch,
   approach, edge cases, test strategy, and how the change will be exercised
   as a user in Phase 3 (browser flow, emulator screen, CLI invocation, or
   entry-point script).

## Phase 2 — Build loop (Workflow tool)

Invoke the Workflow tool with:

- `scriptPath`: the absolute path of `ship-workflow.js` in this skill's
  directory (expand `~`)
- `args`: `{ "requirement": "...", "planPath": "<absolute path to plan.md>",
  "repoRoot": "<absolute repo root>", "testCommand": "<exact command>",
  "maxReviewRounds": 3 }`

The script enforces gate order deterministically, every agent on Sonnet at
high effort (medium only for running the suite): Sonnet implements code + tests
(without running them) → `test-quality-auditor` audits, Critical/High fixed and
re-audited (max 3 audits) → the suite runs, failures fixed and re-run (max 3
runs) → an internal PRE-review with Sonnet fixes (max 3 rounds; the formal
Step 8 gate is Phase 2b, not this loop). Each capped loop that exhausts its
bound returns `ok: false` with `failedGate` set.

Read the returned summary. If `ok` is false, either stop and report that gate
as FAILED, or re-invoke the workflow — note it has no resume: a re-invocation
starts over with a fresh Sonnet implement pass. Never hand-patch around a failed
gate in the main loop without re-running that gate's checker. Do not proceed
to Phase 3 on a failing build.

### Phase 2b — Formal code review gate (main loop)

The workflow's internal review is a pre-review. The Step 8 gate is the
`/diff-review` skill, which only the main loop can invoke:

1. Run `/diff-review` (default effort `standard`; `deep` for a large or risky
   diff) over the working diff.
2. Dismiss false positives with a one-line justification each. For real
   Critical/High findings: dispatch a fix sub-agent (Sonnet, high effort),
   re-run the test suite, then run `/diff-review` again. If that test re-run fails, treat it
   as a Step 6 regression: fix and re-run the suite (max 2 attempts) before
   any further review; if it cannot be made green, Step 6 is FAILED — stop.
3. Cap: 3 `/diff-review` runs total. Still dirty after the third → the gate
   is FAILED; stop.

Note: `/diff-review` is the LOCAL review skill. Never substitute the native
`/code-review` — it is billed and uploads the branch, so only the user may
launch it.

Fallback rules — read carefully:

- "Unavailable" means an actual `/diff-review` invocation was ATTEMPTED and
  failed with a skill-not-found/tool error. Quote that error in the Phase 6
  report. Deciding it is unavailable without attempting it is a gate
  violation, not a fallback. Only then does the workflow's internal review
  loop (sub-agent with categorized findings) stand as the gate.
- If the workflow returned `failedGate: 'review'` (pre-review exhausted), the
  formal gate was never reached. Report Step 8 as
  `FAILED — pre-review exhausted 3 rounds; /diff-review not reached`. Never
  present pre-review rounds as `/diff-review` runs.
- If the workflow returned `failedGate: 'tests-after-review-fix'`, a
  pre-review fix regressed the suite: report Step 6 as
  `FAILED — regression during pre-review fixes` and Step 8 as not reached.

## Phase 3 — Static verification

Run the project's lint, type-check, and any repo-specific checks. All green.

## Phase 4 — Exercise as a user (the final /verify gate)

This gate runs last, after review and static verification, so it exercises
the final state of the code. Delegate the walk to a dedicated verify
sub-agent (Sonnet, high effort; never a fork — put any in-session state it
needs in the brief). It captures evidence and proposes a verdict; the main
loop spot-checks that evidence and owns the PASS. The verifier never fixes:
route its findings to a separate fix sub-agent, then re-walk. Automated tests passing is not enough. Drive the
change through its real interface, chosen by what the diff touches:

- **Web UI:** Playwright MCP — navigate the real flow, interact with the
  change, confirm persistence (reload, or check the DB). Screenshot the end
  state.
- **Mobile:** build, install on the emulator/simulator, walk the affected
  screens.
- **CLI:** run the real binary on realistic input; check stdout, stderr, exit
  code, and side effects.
- **Library / backend:** invoke the public entry point from a scratch script,
  or curl a running server; confirm observable behavior.

**Evidence — check for a project `/verify` skill first.** If the repo defines
one, invoke it and follow its artifact contract; it owns what gets captured
and where it is stored, and it prints the block to paste into the PR body.
Capture whatever run id or links it emits and carry them to Phase 5.

Only when the repo has no `/verify` skill: save the evidence under
`.claude/ship/evidence/` with descriptive names (`after-checkout-flow.png`,
`cli-run.txt`) — that directory is COMMITTED so the evidence ships inside
the PR.
If the environment cannot support this (no browser, no emulator), STOP and
ask the user for a waiver — never self-skip. If the user grants it, record
WAIVED-BY-USER for this step in the Phase 6 report and continue to Phase 5.

## Phase 5 — Deliver

- In a background session with worktree isolation, commit/push/draft-PR is
  automatic — let it happen, then confirm the PR exists.
- Otherwise: branch `ship/<short-slug>`, commit with a clear message, push,
  and `gh pr create --draft`. Never push to main/master; never force-push.
- The PR is NOT complete unless the reviewer can verify it from the PR alone.
  The body must contain: the Phase 6 gate report, the captured CLI/test
  output inline in fenced blocks, and the Phase 4 evidence.
  - With a project `/verify` skill: paste the markdown block it printed
    verbatim. Do not also commit the artifact files — the skill decides
    where they live.
  - Without one: embed the screenshot(s) via their committed
    `.claude/ship/evidence/` blob URLs
    (`https://github.com/<owner>/<repo>/blob/<branch>/<path>?raw=true`). The
    evidence directory is committed on the branch, so it is reviewable in
    Files changed even if embedding fails.

## Phase 6 — Report

End with exactly this block (values from the workflow summary and Phases 3–5):

```
Step 5 (test audit):     PASS / FAILED / WAIVED-BY-USER / N/A — <audit rounds, findings fixed>
Step 6 (run tests):      PASS / FAILED — <test command>
Step 7 (user exercise):  PASS / FAILED / WAIVED-BY-USER / N/A — <how driven, evidence path>
Step 8 (code review):    PASS / FAILED / WAIVED-BY-USER — </diff-review runs used of 3 + effort, or "workflow sub-agent fallback"; residual findings>
Step 9 (verify):         <lint/type-check commands + results>
PR:                      <URL, or "not opened — <reason>">
```

WAIVED-BY-USER appears only when the user explicitly granted a waiver this
turn. Any FAILED means the work is not done — say so plainly.

# claude-eng-kit

A Claude Code plugin marketplace (`ebernie-tools`) with one plugin,
**eng-gates**: a gated delivery pipeline that takes one requirement from plan
to a draft PR, refusing to open the PR unless every gate passes.

| Component | Invoked as | Purpose |
|---|---|---|
| `ship` skill | `/eng-gates:ship <requirement>` | The full pipeline |
| `diff-review` skill | `/eng-gates:diff-review` | Local adversarial code review (the review gate) |
| `verify-init` skill | `/eng-gates:verify-init` | Generates the repo's `/verify` skill |
| `test-quality-auditor` agent | `eng-gates:test-quality-auditor` | Audits tests before their first run |

Coding and testing standards the pipeline enforces:
[`plugins/eng-gates/skills/ship/references/standards.md`](plugins/eng-gates/skills/ship/references/standards.md).

## Install

```
/plugin marketplace add <github-user>/claude-eng-kit
/plugin install eng-gates@ebernie-tools
```

## First run in each repo

```
/eng-gates:verify-init
```

Discovers how to launch and drive the app (web, mobile, CLI, library/backend),
asks a few questions (surfaces, launch command, credential env var names,
evidence storage), writes `.claude/skills/verify/SKILL.md`, and smoke-tests
it. Commit `.claude/skills/verify/`. `/eng-gates:ship` refuses to start
without it.

## Usage

```
/eng-gates:ship Add CSV export to the reports page
/eng-gates:diff-review [light|quick|standard|deep] [--guidance <file>]... [<git range or path>]
```

`/eng-gates:ship` plans in the main loop, delegates implementation to
Sonnet, runs the gates below, and ends by opening a **draft** PR on a
`ship/<slug>` branch whose body carries the gate report, test output, and the
`/verify` evidence block. Any failed gate → no PR, reported as FAILED.

`/eng-gates:diff-review` runs standalone on any working diff; nothing is
uploaded.

## Gates

Execution order, top to bottom. Step numbers are report labels.

| Order | Gate | How | Bound |
|---|---|---|---|
| Step 5 | Test audit | `test-quality-auditor` sub-agent, before any test run | 3 audits |
| Step 6 | Run tests | Real suite, real DB/UI | 3 runs |
| Step 8 | Code review | Workflow pre-review, then `/eng-gates:diff-review` | 3 rounds / 3 runs |
| Step 9 | Static checks | Lint, type-check, repo checks | all green |
| Step 7 | User exercise | Project `/verify` walk via a Sonnet sub-agent; main loop owns the verdict | final gate |

Only the user can waive a gate, explicitly, for the current turn.

**Caveat:** only work done through `/eng-gates:ship` is gated. To make every
code change go through it automatically, adopt
[`examples/CLAUDE.md`](examples/CLAUDE.md) as your global or project
`CLAUDE.md`.

## Requirements

- git, and the `gh` CLI authenticated (for the draft PR)
- Claude Code with the Workflow tool available
- Playwright MCP, for web verification
- Optional: the `feature-dev` plugin (its `code-reviewer` agent backs the
  `light` diff-review tier; falls back to `general-purpose`)

## Local development

```
claude --plugin-dir ./plugins/eng-gates
claude plugin validate .
node --test plugins/eng-gates/skills/*/tests/*.test.mjs
```

# claude-plugins

A Claude Code plugin marketplace (`ebernie`) with one plugin,
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
/plugin marketplace add ebernie/claude-plugins
/plugin install eng-gates@ebernie
```

## First run in each repo

```
/eng-gates:verify-init
```

Discovers how to launch and drive the app (web, mobile, CLI, library/backend),
asks a few questions (surfaces, launch command, credential env var names,
evidence storage), writes `.claude/skills/verify/` (`SKILL.md`, the
`verify-artifacts.mjs` evidence publisher, `evidence.json`), and smoke-tests
it. Commit `.claude/skills/verify/`. `/eng-gates:ship` refuses to start
without it.

## Evidence storage

Evidence (screenshots, CLI output, API calls) is never committed. `/verify`
stages it under `.verify-artifacts/<runId>/` (gitignored), and the publisher
uploads it and writes the `pr-evidence.md` block that `/ship` appends to the
PR body.

- **Cloud (recommended).** Set up outside Claude:
  - a bucket dedicated to evidence;
  - a lifecycle expiry rule (e.g. 90 days);
  - public read — run ids are unguessable, so the links are public but not
    discoverable;
  - an upload CLI authenticated via its own profile/env. `evidence.json`
    names the profile and never holds credentials.

  Presets `verify-init` offers (the upload runs without a shell):

  | Backend | Upload argv | Per |
  |---|---|---|
  | AWS S3 | `aws s3 cp --recursive {dir} s3://<bucket>/<prefix>/{runId}/` | run |
  | Cloudflare R2 (aws CLI) | same, plus `--endpoint-url https://<account>.r2.cloudflarestorage.com --profile <name>` | run |
  | Cloudflare R2 (wrangler) | `wrangler r2 object put <bucket>/<prefix>/{runId}/{key} --file {file} --remote` | file |
  | GCS | `gcloud storage cp --recursive {dir} gs://<bucket>/<prefix>/{runId}/` | run |

  A private bucket with presigned (short-lived) URLs works if you supply the
  command; the publisher does not presign.
- **Local only.** Nothing is uploaded; the PR gets text excerpts.

**Provenance:** links are public, so the generated `/verify` captures only
against synthetic/seed data, never production or real user data. When it
cannot tell what data the stack holds, it treats it as real and does not
publish.

## Usage

```
/eng-gates:ship Add CSV export to the reports page
/eng-gates:diff-review [light|quick|standard|deep] [--guidance <file>]... [<git range or path>]
```

`/eng-gates:ship` plans in the main loop, delegates implementation to
Sonnet, runs the gates below, and ends by opening a **draft** PR on a
`ship/<slug>` branch whose body carries the gate report, test output, and the
`/verify` evidence block (concatenated from `pr-evidence.md`, never
retyped). Any failed gate → no PR, reported as FAILED.

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
- Node.js >= 18 (for the evidence publisher)
- For cloud evidence: the upload CLI you chose (`aws`, `wrangler`, or
  `gcloud`), authenticated
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

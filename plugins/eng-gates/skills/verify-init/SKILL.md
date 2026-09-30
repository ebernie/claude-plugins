---
name: verify-init
description: Generates this repo's project verify skill (.claude/skills/verify/SKILL.md, invoked as /verify) plus its evidence publisher and config — discovers how to launch and drive the app, asks only what discovery cannot settle, writes the skill with the fixed contract /eng-gates:ship depends on, and smoke-validates it. Run once per repo before /eng-gates:ship; re-run to update. Usage - /eng-gates:verify-init
---

# /eng-gates:verify-init — generate the project /verify skill

/eng-gates:ship ends with a user-level walk of the change through its real
interface. How to launch, drive, and capture evidence is project-specific, so
it lives in the repo under `.claude/skills/verify/`. This skill writes it.
The generated skill must follow the contract below exactly — /ship depends
on its sections and its output.

Output, all under `<repoRoot>/.claude/skills/verify/`:

- `SKILL.md` — the /verify skill;
- `verify-artifacts.mjs` — the evidence publisher, copied verbatim from
  `templates/verify-artifacts.mjs` in this skill's directory;
- `evidence.json` — the publisher's config.

Evidence is NEVER committed to git. It is staged under
`<repoRoot>/.verify-artifacts/` (gitignored by the publisher) and either
uploaded to cloud storage or kept local.

## Rules that don't bend

- Discovery (Phase 2) is delegated to a sub-agent, and smoke validation
  (Phase 5) runs on the FINAL content. Skipping either means the skill is not
  done.
- Every sub-agent here runs in the foreground, never in the background —
  background agents cannot get permission prompts in headless or
  non-interactive sessions.
- No credential values anywhere: not in the skill, not in `evidence.json`.
  Env var or CLI profile NAMES only. If the user pastes a value, refuse to
  record it and ask for the name.

## Phase 1 — Preflight (main loop)

1. `git rev-parse --show-toplevel` must succeed; that is `<repoRoot>`. Not a
   git repo → stop and say so.
2. If `<repoRoot>/.claude/skills/verify/SKILL.md` exists, read it (and
   `evidence.json`) and ask the user (AskUserQuestion): **update** (keep what
   is there, fill gaps and fix drift from discovery), **overwrite**
   (regenerate from scratch), or **abort**.

## Phase 2 — Discover (sub-agent, read-only, MUST)

Delegate to ONE foreground `Agent` call, `subagent_type` `Explore` (else
`general-purpose`), `model: sonnet` passed explicitly. Read-only: it never
edits, installs, or launches anything. Brief it to report, with file paths
as evidence:

- **Surfaces** — web, mobile, CLI, library/backend (`api`); possibly several.
  Infer from manifests and configs (`package.json` scripts/bin,
  `pyproject.toml` scripts, `Cargo.toml` `[[bin]]`, `go.mod` + `cmd/`,
  Gradle/Xcode projects, Dockerfiles, compose files, framework configs).
- **Launch & teardown** — dev/start commands, compose services, ports and
  URLs, how to stop cleanly.
- **Readiness signal** — health endpoint, port to poll, or a known-good
  invocation that exits 0.
- **Data** — seed/fixture/migration scripts, how to reset state, and whether
  the local stack can hold anything but synthetic data.
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
3. **Test credentials** — the ENV VAR NAMES that hold them.
4. **Evidence storage:**
   - (a) **Cloud via upload command** (Recommended) — `backend: "command"`.
     Links in the PR are public: the default is a PUBLIC-read bucket with
     unguessable run ids and a lifecycle expiry rule (e.g. 90 days), set up
     by the user outside Claude. A private bucket with presigned
     (short-lived) URLs is a user-supplied alternative; the publisher does
     not presign.
   - (b) **Local only** — `backend: "local"`; nothing uploaded, text excerpts
     inlined in the PR.
5. For (a) only — fill in `upload`:
   - **Preset** (then ask for bucket, prefix, and profile names):
     - AWS S3, `per: "run"`:
       `["aws","s3","cp","--recursive","{dir}","s3://<bucket>/<prefix>/{runId}/"]`
     - Cloudflare R2 via aws CLI, `per: "run"`: the S3 argv plus
       `"--endpoint-url","https://<account>.r2.cloudflarestorage.com","--profile","<name>"`
     - R2 via wrangler, `per: "file"`:
       `["wrangler","r2","object","put","<bucket>/<prefix>/{runId}/{key}","--file","{file}","--remote"]`
     - GCS, `per: "run"`:
       `["gcloud","storage","cp","--recursive","{dir}","gs://<bucket>/<prefix>/{runId}/"]`
     - Custom argv. Placeholders: `per: "run"` → `{dir}`, `{runId}`;
       `per: "file"` → `{file}`, `{key}`, `{runId}`. It runs WITHOUT a shell
       — no pipes, globs, `~`, or `$VAR` expansion.
   - **Public base URL** → `urlTemplate`, e.g.
     `https://<public-host>/<prefix>/{runId}/{key}`.
   - Warn: the bucket must be dedicated to evidence and have lifecycle
     expiry. The upload CLI authenticates with its own profile/env; confirm
     it is already logged in.

Write `evidence.json`:

```json
{
  "backend": "command",
  "upload": { "per": "run", "argv": ["..."], "urlTemplate": "https://.../{runId}/{key}" },
  "required": { "web": ["console.txt", "*.png"] }
}
```

`backend: "local"` omits `upload`. `required` lists only chosen surfaces,
defaults: `web` → `console.txt`, `*.png`; `cli` → `cli-run.txt`,
`exit-code.txt`; `api` → `calls.txt`; `mobile` → `*.png`.

## Phase 4 — Generate `<repoRoot>/.claude/skills/verify/SKILL.md`

Copy `templates/verify-artifacts.mjs` to
`<repoRoot>/.claude/skills/verify/verify-artifacts.mjs` unchanged.

Frontmatter: `name: verify`, and a description naming the surfaces and that
it is the user-level exercise gate for /eng-gates:ship. Then these sections,
in this order, with these headings — no others. Fill every placeholder with
the discovered/confirmed concrete commands, URLs, ports, and paths; leave no
`<TODO>`.

1. **Prerequisites** — tools, env vars (names only), services, one-time
   setup (install deps, run migrations, seed with synthetic data).
2. **Launch & teardown** — exact commands per surface, long-lived ones in the
   background with their PID recorded at launch. Teardown always runs, even
   after a failure: stop by the recorded PID (`kill <pid>`), never
   `pkill -f <pattern>`. Never `rm -rf` a computed or substituted path;
   delete only exact paths a tool printed.
3. **Readiness check** — liveness and exit codes only: process up, port open
   or health URL returns 2xx, binary exits 0 on a known-good input. Never
   match exact output text (usage strings, banners). Timeout → BLOCKED.
4. **Walkthrough recipes** — ONLY for chosen surfaces; each saves its
   `required` files into `<staging>/<surface>/`:
   - **Web** — Playwright MCP: navigate the real flow at `<base URL>`, sign in
     via `<ENV VAR>` credentials if needed, interact with the change,
     screenshot the end state, confirm persistence (reload, or query the DB
     with `<command>`); save console messages to `console.txt`.
   - **Mobile** — build and install on the emulator/simulator
     (`<build/install commands>`), walk the affected screens, screenshot each.
   - **CLI** — run the real binary (`<invocation>`) on realistic input; check
     stdout, stderr, exit code, and side effects (files, DB rows); save
     output to `cli-run.txt` and the exit code to `exit-code.txt`.
   - **Library/backend (`api`)** — call the public entry point from a scratch
     script outside the source tree, or curl the running server
     (`<base URL>`); confirm observable behavior; save requests and
     responses to `calls.txt`.
5. **Evidence contract** — always through the publisher, from `<repoRoot>`:
   1. `node .claude/skills/verify/verify-artifacts.mjs new` → note the
      printed `runId=<id>` and `staging=<path>`.
   2. Drive the walkthrough, saving files to `<staging>/<surface>/` with
      safe descriptive names (`after-checkout-flow.png`). No symlinks; 25 MiB
      cap per file. Stage every surface the diff touches — the publisher
      checks `required` only for surfaces present, so an omitted surface is
      unchecked, not waived.
   3. `node .claude/skills/verify/verify-artifacts.mjs publish <runId>
      --summary "<one line>"` — add
      `--waive "<surface>:<pattern>=<reason>"` only for a required file that
      genuinely cannot exist. It validates layout, names, size, and required
      files, rejects binary non-image files (archives, traces — they cannot be
      scanned), refuses on a credential-pattern hit, writes `manifest.json`,
      uploads, and writes and prints `<staging>/pr-evidence.md`. A refusal is
      a finding to report, never something to work around.
   4. `node .claude/skills/verify/verify-artifacts.mjs links <runId>`
      re-prints the block.
   Never commit evidence.
6. **Output contract** — the verifier returns: the absolute path of
   `<staging>/pr-evidence.md`, and a proposed verdict — `PASS` or `FAIL` with
   reasons, or `BLOCKED` with the reason. It never retypes or edits the
   block.
7. **Rules** —
   - Walk the real interface. Tests passing is not evidence.
   - Provenance: capture only against synthetic/seed data — never production
     or real user data. Unsure what data the stack holds → treat it as real
     and do not publish; report BLOCKED.
   - The verifier never fixes; it reports findings. If this skill itself is
     stale (a command, flag, port, or check no longer matches the app), say
     so explicitly as a finding.
   - If the environment cannot run the walk (no browser, emulator, service,
     or credentials), report `BLOCKED` with the reason — never self-pass.
   - Never print or store credential values.
   - Always tear down.

## Phase 5 — Smoke-validate (sub-agent, MUST)

Launch ONE foreground `Agent` (`general-purpose`, `model: sonnet`, high
effort): read the generated skill, then:

1. run Prerequisites (non-destructive steps only), Launch, and the Readiness
   check for each chosen surface, then Teardown;
2. run `new`, place one trivial file per `required` pattern in
   `<staging>/<surface>/`, run `publish <runId> --summary "smoke"
   --dry-run`, then delete that run's staging dir by the exact `staging=`
   path `new` printed.

It reports each command, its outcome, and any error output. It does not walk
flows and does not edit the skill.

The skill is validated only when a smoke run on its FINAL content passes. Any
edit after a smoke run — a fix, or anything else — requires a new smoke run.
On failure: fix the skill in the main loop from the report (or ask the user
when the fix needs information only they have), then re-validate. Max 2
retries. Still failing → say plainly that the skill is NOT VALIDATED, what
failed, and what the user must fix; do not present it as ready.

## Phase 6 — Hand-off

Tell the user:

- the generated files and a one-line summary per section;
- the smoke-validation result;
- for (a): the bucket must be dedicated, public-read (or their presign
  alternative), with lifecycle expiry, and the upload CLI logged in;
- to commit `.claude/skills/verify/` (`SKILL.md`, `verify-artifacts.mjs`,
  `evidence.json`) and the `.gitignore` entry for `.verify-artifacts/`, so
  /eng-gates:ship finds them on every branch;
- then run `/eng-gates:ship <requirement>`.

export const meta = {
	name: "diff-review",
	description:
		"Local adversarial review of a working diff: parallel dimension finders, refutation verifiers, ranked survivors",
	whenToUse:
		"Step 8 code-review gate, run locally instead of the billed cloud /code-review",
	phases: [
		{ title: "Find", detail: "parallel dimension reviewers over the diff" },
		{ title: "Verify", detail: "adversarial refuters, majority rules" },
	],
};

// ---------------------------------------------------------------- args

const range = args?.range || "HEAD";
const repoRoot = args?.repoRoot || ".";
const effort = args?.effort || "standard";
const includeDirty = args?.includeDirty !== false;
const guidanceFiles = args?.guidanceFiles || [];
const scopeNote = args?.scopeNote || range;
// re-review mode: findings just fixed, to verify rather than re-discover
const priorFindings = args?.priorFindings || [];

// quick / standard / deep -> which dimensions, refuters per critical/high finding, rounds
const TIERS = {
	quick: {
		dims: ["correctness", "security", "convention"],
		refuters: 1,
		rounds: 1,
	},
	standard: {
		dims: ["correctness", "security", "convention", "test-coverage"],
		refuters: 2,
		rounds: 1,
	},
	deep: {
		dims: [
			"correctness",
			"security",
			"convention",
			"test-coverage",
			"simplification",
			"integration",
		],
		refuters: 2,
		rounds: 2,
	},
};
const tier = TIERS[effort] || TIERS.standard;
// callers may narrow the set further (scripts/docs-only -> correctness+security)
const dimKeys =
	Array.isArray(args?.dims) && args.dims.length ? args.dims : tier.dims;

// ---------------------------------------------------------------- schemas

const findingsSchema = (maxItems = 12) => ({
	type: "object",
	additionalProperties: false,
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			maxItems,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"file",
					"line",
					"severity",
					"category",
					"summary",
					"failure_scenario",
					"evidence",
				],
				properties: {
					file: { type: "string", description: "repo-relative path" },
					line: { type: "integer", description: "1-indexed line in that file" },
					severity: {
						type: "string",
						enum: ["critical", "high", "medium", "low"],
					},
					category: {
						type: "string",
						description:
							"kebab-case slug: correctness, security, convention, test-coverage, simplification, efficiency, integration",
					},
					summary: {
						type: "string",
						description: "one sentence stating the defect",
					},
					failure_scenario: {
						type: "string",
						description:
							"concrete inputs or state -> the specific wrong output, crash, or leak",
					},
					evidence: {
						type: "string",
						description:
							"the code line(s), or the quoted CLAUDE.md rule, that prove it",
					},
				},
			},
		},
	},
});

const VERDICT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["refuted", "reason"],
	properties: {
		refuted: {
			type: "boolean",
			description: "true if this is a false positive, out of scope, or unproven",
		},
		reason: { type: "string", description: "one sentence justifying the call" },
		corrected_line: {
			type: "integer",
			description: "the real 1-indexed line, if the finding cited the wrong one",
		},
	},
};

// ---------------------------------------------------------------- prompts

const scopeBlock = `
Repository root: ${repoRoot}
Review scope: ${scopeNote}
Read the diff with: git -C ${repoRoot} diff ${range}
${includeDirty ? `ALSO review uncommitted work: git -C ${repoRoot} status --porcelain, then git -C ${repoRoot} diff and git -C ${repoRoot} diff --staged. Read untracked (non-ignored) files in full.` : ""}
${guidanceFiles.length ? `Project guidance files (their rules are review criteria): ${guidanceFiles.join(", ")}` : ""}
${priorFindings.length ? `This is a FIX-VERIFICATION pass. These findings were just fixed:\n${priorFindings.map((s) => `  - ${s}`).join("\n")}\nConfirm each fix resolves its finding; report only a fix that does NOT resolve it, or a NEW defect introduced by the fix hunks.` : ""}

HARD RULES:
- ONLY code inside this diff is in scope. A pre-existing problem in untouched
  code is NOT a finding, unless this change newly makes it reachable — then say
  exactly how.
- Every finding needs a CONCRETE failure scenario: specific inputs or state
  producing a specific wrong result. If you cannot construct one, do not report
  it. "Could be fragile", "consider extracting", "might be confusing" are not
  findings.
- Cite a real repo-relative file and a real 1-indexed line. Open the file and
  confirm the line number before reporting. Never estimate.
- Report nothing rather than pad. An empty findings array is a valid, good result.`;

const DIMENSIONS = [
	{
		key: "correctness",
		prompt: `Review this diff for CORRECTNESS bugs.

Look for: logic errors, inverted or wrong operators, off-by-one, unhandled
error paths, async ordering and race conditions, state that can go stale,
boundary values (empty, zero, one, max), null/undefined reaching code that
assumes presence, exceptions swallowed silently, resources not released,
early returns that skip required cleanup.

For each candidate, trace the actual execution path and construct the input
that triggers it. If you cannot, drop it.`,
	},
	{
		key: "security",
		prompt: `Review this diff for SECURITY and CONTRACT defects.

Look for: external input reaching logic without validation at the boundary,
missing authentication/authorization or tenancy scoping on a data path,
injection (SQL, shell, template, path traversal), secrets or personal data in
logs, error messages, or responses, over-broad permissions, existence leaks
via differing error codes, and drift between an implementation and the API
schema or contract it claims to satisfy.

Name the untrusted input and trace it to the sink. No sink, no finding.`,
	},
	{
		key: "convention",
		prompt: `Review this diff for violations of THIS PROJECT'S OWN documented rules.

Read the guidance files listed above FIRST. Only flag a rule the file actually
states — quote the exact sentence you are enforcing in your evidence field. Do
not invent house style, and do not flag general best practices that the project
never committed to.

Note that guidance files are written to instruct an agent writing code, so not
every line is a review criterion. Judge which are.`,
	},
	{
		key: "test-coverage",
		maxFindings: 3,
		prompt: `Review the TEST QUALITY of this diff.

Ask, for each behavior the diff adds or changes: is there a test that would
FAIL if this change were reverted or subtly broken? Name the specific
uncovered behavior and the input that would expose it.

Also flag these forbidden patterns in any test the diff adds or edits:
duplicate tests under different names, assertion-free "documentation" tests,
tests that mock the system under test's own internals, a mocked database in
something labelled an integration test, and tests that only assert on
navigation or URL patterns.

Missing tests for a NEW behavior are a finding. Absent tests for untouched
pre-existing code are not.

Report AT MOST 3 findings — the three whose absence would let the most
damaging regression ship. Rank before you cut; do not pad to three.`,
	},
	{
		key: "simplification",
		prompt: `Review this diff for SIMPLIFICATION and EFFICIENCY.

Look for: logic duplicated from somewhere else in the repo (search for it —
name the existing helper), abstraction introduced for a single caller, dead or
unreachable code, redundant state derivable from existing state, a query
inside a loop (N+1), repeated work that could be hoisted, and data structures
forcing a linear scan where a lookup is available.

Quality only — do not report bugs here; another reviewer covers those. Each
finding must name the concrete cost: the duplicate's location, or the input
size at which the inefficiency bites.`,
	},
	{
		key: "integration",
		prompt: `Review this diff for INTEGRATION and BLAST-RADIUS defects.

Find every caller of each changed function, exported symbol, schema field, or
route — search the repo, do not guess. Look for: callers not updated for a
changed signature or return shape, a narrowed type or removed field that a
consumer still reads, a migration that is not backward compatible with code
still running, a changed default that silently alters existing behavior, and
config or env additions not wired everywhere they must be.

Name the specific caller file and line that breaks.`,
	},
];

// ---------------------------------------------------------------- helpers

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const fingerprint = (f) => `${f.file}:${f.line}:${f.category}`;

function refuterPrompt(finding, lens) {
	return `You are an adversarial verifier. Your default answer is REFUTED.

A reviewer claims this defect in ${repoRoot}:

  File: ${finding.file}:${finding.line}
  Severity: ${finding.severity}   Category: ${finding.category}
  Claim: ${finding.summary}
  Alleged failure: ${finding.failure_scenario}
  Cited evidence: ${finding.evidence}

Open the file. Read the surrounding code and any relevant caller. Try hard to
REFUTE the claim. Examine specifically, through the lens of ${lens}:

- Is the cited line real, and does it say what the reviewer claims?
- Is a guard, validation, type constraint, or caller precondition already
  preventing the failure scenario?
- Is the claimed input actually reachable in this codebase?
- Is this pre-existing code the diff did not touch? (If so: refuted.)
- Is it a matter of taste with no concrete failure? (If so: refuted.)

Set refuted=true unless you can positively confirm the failure scenario is
real and reachable. Uncertainty means refuted. If the defect is real but the
line number is wrong, set refuted=false and give corrected_line.`;
}

const LENSES = [
	"whether the failure input is actually reachable",
	"whether an existing guard or type already prevents it",
	"whether this is pre-existing rather than newly introduced",
];

// the full refuter panel is reserved for critical/high; medium/low get one
const refutersFor = (f) =>
	f.severity === "critical" || f.severity === "high" ? tier.refuters : 1;

// ---------------------------------------------------------------- run

const dims = dimKeys
	.map((k) => DIMENSIONS.find((d) => d.key === k))
	.filter(Boolean);

log(`diff-review [${effort}] over ${scopeNote}`);
log(
	`${dims.length} dimension(s) x up to ${tier.rounds} round(s), ${tier.refuters} refuter(s) per critical/high finding`,
);

const seen = new Set();
const survivors = [];
let totalRaw = 0;

for (let round = 0; round < tier.rounds; round++) {
	const roundLabel = tier.rounds > 1 ? ` (round ${round + 1})` : "";

	// pipeline: each dimension's findings verify as soon as THAT dimension
	// returns — no barrier waiting on the slowest finder.
	const results = await pipeline(
		dims,
		(d) =>
			agent(
				`${d.prompt}\n${scopeBlock}${round > 0 ? "\n\nThis is a second pass. Findings already reported and handled: " + [...seen].join("; ") + "\nReport only defects NOT in that list." : ""}`,
				{
					model: "sonnet",
					effort: "high",
					label: `find:${d.key}${roundLabel}`,
					phase: "Find",
					schema: findingsSchema(d.maxFindings),
				},
			),
		(res, dim) => {
			const found = (res?.findings || []).filter(
				(f) => f && !seen.has(fingerprint(f)),
			);
			for (const f of found) seen.add(fingerprint(f));
			totalRaw += found.length;
			if (!found.length) return [];

			return parallel(
				found.map((f) => () =>
					parallel(
						Array.from(
							{ length: refutersFor(f) },
							(_unused, i) => () =>
								agent(refuterPrompt(f, LENSES[i % LENSES.length]), {
									model: "sonnet",
									effort: "high",
									label: `verify:${dim.key}:${f.file.split("/").pop()}:${i + 1}`,
									phase: "Verify",
									schema: VERDICT_SCHEMA,
								}),
						),
					).then((votes) => {
						const cast = votes.filter(Boolean);
						// A dead verifier must not silently confirm a finding.
						if (!cast.length) return null;
						const refuted = cast.filter((v) => v.refuted).length;
						if (refuted * 2 > cast.length) return null; // majority refuted -> drop
						const corrected = cast.find((v) => v.corrected_line)?.corrected_line;
						return {
							...f,
							line: corrected || f.line,
							verdict: refuted === 0 ? "CONFIRMED" : "PLAUSIBLE",
							refuted_by: refuted,
							verifiers: cast.length,
						};
					}),
				),
			);
		},
	);

	const kept = results
		.filter(Boolean)
		.flat(2)
		.filter(Boolean);
	survivors.push(...kept);
	log(
		`round ${round + 1}: ${totalRaw} raw finding(s), ${survivors.length} survived refutation`,
	);

	// a second pass is for noisy diffs; a quiet round 1 means we're done
	if (round + 1 < tier.rounds && totalRaw < 4) {
		log(
			`round ${round + 1} yielded ${totalRaw} raw finding(s) — skipping round ${round + 2}`,
		);
		break;
	}
}

survivors.sort(
	(a, b) =>
		(SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
		(a.verdict === b.verdict ? 0 : a.verdict === "CONFIRMED" ? -1 : 1),
);

const tally = survivors.reduce((acc, f) => {
	acc[f.severity] = (acc[f.severity] || 0) + 1;
	return acc;
}, {});

return {
	scope: scopeNote,
	effort,
	level: effort === "quick" ? "low" : effort === "deep" ? "max" : "high",
	raw_findings: totalRaw,
	survived: survivors.length,
	tally,
	findings: survivors,
};

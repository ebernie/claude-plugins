import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The script runs inside the Workflow harness with agent/phase/log/args as
// injected globals, so it can't be import()ed. We execute its source in an
// AsyncFunction with stubbed globals and assert on observable behavior:
// gate ordering, loop bounds, and the returned summary. The evaluated source
// is exclusively the local file under test — no external or user-controlled
// input is ever interpolated into the function body.
const SCRIPT_URL = new URL('../../../workflows/ship-build-loop.js', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function loadSource() {
  return readFile(SCRIPT_URL, 'utf8')
}

async function runScript(args, agentImpl, phaseLog = []) {
  const src = (await loadSource()).replace('export const meta', 'const meta')
  const fn = new AsyncFunction('agent', 'phase', 'log', 'parallel', 'pipeline', 'args', 'budget', src)
  return fn(agentImpl, title => phaseLog.push(title), () => {}, null, null, args, { total: null })
}

const ARGS = {
  requirement: 'add truncate()',
  planPath: '/repo/.claude/ship/plan.md',
  repoRoot: '/repo',
  testCommand: 'node --test',
  standardsPath: '/plugin/skills/ship/references/standards.md',
}

const CRITICAL = { severity: 'Critical', file: 'test/x.test.mjs', summary: 'passes regardless of code' }
const MEDIUM = { severity: 'Medium', file: 'lib/x.js', summary: 'minor naming' }

// One scenario that exercises every agent kind: implement, audit + fix,
// failing run + fix, review + fix, and the post-fix recheck.
const allAgentKinds = () => makeAgent({ audits: [[CRITICAL], []], testRuns: [false, true], reviews: [[CRITICAL], []] })

// Scenario stub: sequences of results per gate; the last entry repeats forever.
// Calls are dispatched on opts.phase + presence of opts.schema (checker vs fixer).
function makeAgent({ audits = [[]], testRuns = [true], reviews = [[]], nullAt } = {}) {
  const calls = []
  const seen = { audit: 0, test: 0, review: 0 }
  const next = (arr, key) => arr[Math.min(seen[key]++, arr.length - 1)]
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    // Simulate a skipped/dead agent (the harness resolves those to null).
    if (opts.phase === nullAt && (nullAt === 'Implement' || opts.schema)) return null
    switch (opts.phase) {
      case 'Implement':
        return 'changed lib/x.js; added test/x.test.mjs'
      case 'Audit tests':
        return opts.schema ? { findings: next(audits, 'audit') } : 'fixed'
      case 'Run tests':
        return opts.schema ? { passed: next(testRuns, 'test'), summary: 'suite output' } : 'fixed'
      case 'Review':
        return opts.schema ? { findings: next(reviews, 'review') } : 'fixed'
      default:
        throw new Error(`unexpected phase: ${opts.phase}`)
    }
  }
  agent.calls = calls
  agent.checks = phase => calls.filter(c => c.opts.phase === phase && c.opts.schema)
  agent.fixes = phase => calls.filter(c => c.opts.phase === phase && !c.opts.schema && c.opts.phase !== 'Implement')
  return agent
}

const REQUIRED_KEYS = ['requirement', 'planPath', 'repoRoot', 'testCommand', 'standardsPath']

for (const key of REQUIRED_KEYS) {
  for (const [how, args] of [
    ['omitted', Object.fromEntries(Object.entries(ARGS).filter(([k]) => k !== key))],
    ['empty', { ...ARGS, [key]: '' }],
  ]) {
    test(`rejects args when ${key} is ${how}`, async () => {
      await assert.rejects(runScript(args, makeAgent()), new RegExp(`requires args:.*${key}`))
    })
  }
}

test('accepts args delivered as a JSON string (observed harness behavior)', async () => {
  const result = await runScript(JSON.stringify(ARGS), makeAgent())
  assert.equal(result.ok, true)
  assert.equal(result.gates.tests.command, ARGS.testCommand)
})

test('rejects a JSON-string args payload missing required fields', async () => {
  await assert.rejects(runScript(JSON.stringify({ requirement: 'x' }), makeAgent()), /requires args/)
})

test('rejects a malformed JSON-string args payload with a clear error', async () => {
  await assert.rejects(runScript('{not json', makeAgent()), /unparseable string args/)
})

test('honors maxReviewRounds override delivered via JSON-string args', async () => {
  const agent = makeAgent({ reviews: [[CRITICAL]] })
  const result = await runScript(JSON.stringify({ ...ARGS, maxReviewRounds: 2 }), agent)
  assert.equal(result.failedGate, 'review')
  assert.equal(agent.checks('Review').length, 2)
})

test('happy path: one round per gate, ok:true', async () => {
  const agent = makeAgent()
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, true)
  assert.equal(result.implementSummary, 'changed lib/x.js; added test/x.test.mjs')
  assert.equal(result.gates.testAudit.rounds, 1)
  assert.deepEqual(result.gates.testAudit.remainingFindings, [])
  assert.equal(result.gates.tests.runs, 1)
  assert.equal(result.gates.tests.command, ARGS.testCommand)
  assert.equal(result.gates.review.rounds, 1)
  assert.equal(agent.fixes('Audit tests').length + agent.fixes('Run tests').length + agent.fixes('Review').length, 0)
})

test('every agent runs on sonnet: suite runs at medium effort, all other work at high', async () => {
  const agent = allAgentKinds()
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, true)
  assert.deepEqual(agent.calls.map(c => c.opts.label), [
    'implement', 'audit 1', 'fix audit 1', 'audit 2', 'test run 1', 'fix tests 1', 'test run 2',
    'review 1', 'fix review 1', 'test recheck 1', 'review 2',
  ])
  const suiteRuns = agent.checks('Run tests')
  for (const { opts } of agent.calls) {
    const expectedEffort = suiteRuns.some(c => c.opts === opts) ? 'medium' : 'high'
    assert.deepEqual({ model: opts.model, effort: opts.effort }, { model: 'sonnet', effort: expectedEffort }, opts.label)
  }
})

test('only the audit checks run as the plugin-namespaced test-quality-auditor', async () => {
  const agent = allAgentKinds()
  await runScript(ARGS, agent)
  const auditChecks = agent.checks('Audit tests')
  assert.equal(auditChecks.length, 2)
  for (const { opts } of agent.calls) {
    const expected = auditChecks.some(c => c.opts === opts) ? 'eng-gates:test-quality-auditor' : undefined
    assert.equal(opts.agentType, expected, opts.label)
  }
})

test('every agent that writes or judges code is pointed at the standards file; suite runners are not', async () => {
  const agent = allAgentKinds()
  await runScript(ARGS, agent)
  const suiteRunLabels = agent.checks('Run tests').map(c => c.opts.label)
  assert.deepEqual(suiteRunLabels, ['test run 1', 'test run 2', 'test recheck 1'])
  for (const { prompt, opts } of agent.calls) {
    const mentionsStandards = prompt.includes(ARGS.standardsPath)
    assert.equal(mentionsStandards, !suiteRunLabels.includes(opts.label), opts.label)
  }
})

test('gate ordering: implement -> audit -> run -> review, strictly', async () => {
  const agent = makeAgent()
  const phases = []
  await runScript(ARGS, agent, phases)
  assert.deepEqual(phases, ['Implement', 'Audit tests', 'Run tests', 'Review'])
  const order = ['Implement', 'Audit tests', 'Run tests', 'Review']
  const observed = agent.calls.map(c => order.indexOf(c.opts.phase))
  const sorted = [...observed].sort((a, b) => a - b)
  assert.deepEqual(observed, sorted, 'gate phases ran out of order')
})

test('a null agent result at any gate throws that gate\'s guard error', async () => {
  await assert.rejects(runScript(ARGS, makeAgent({ nullAt: 'Implement' })), /implement agent failed/)
  await assert.rejects(runScript(ARGS, makeAgent({ nullAt: 'Audit tests' })), /test audit agent failed/)
  await assert.rejects(runScript(ARGS, makeAgent({ nullAt: 'Run tests' })), /test run agent failed/)
  await assert.rejects(runScript(ARGS, makeAgent({ nullAt: 'Review' })), /review agent failed/)
})

test('audit gate: persistent Critical findings stop after 3 audits, tests never run', async () => {
  const agent = makeAgent({ audits: [[CRITICAL]] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, false)
  assert.equal(result.failedGate, 'test-audit')
  assert.equal(agent.checks('Audit tests').length, 3)
  assert.equal(agent.fixes('Audit tests').length, 2)
  assert.equal(agent.checks('Run tests').length, 0, 'tests ran despite failed audit')
  assert.equal(agent.checks('Review').length, 0)
})

test('audit gate: Critical fixed on round 2 proceeds to tests', async () => {
  const agent = makeAgent({ audits: [[CRITICAL], []] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, true)
  assert.equal(result.gates.testAudit.rounds, 2)
  assert.equal(agent.fixes('Audit tests').length, 1)
})

test('test gate: persistent failures stop after 3 runs with 2 fix attempts', async () => {
  const agent = makeAgent({ testRuns: [false] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, false)
  assert.equal(result.failedGate, 'tests')
  assert.equal(agent.checks('Run tests').length, 3)
  assert.equal(agent.fixes('Run tests').length, 2)
  assert.equal(agent.checks('Review').length, 0)
})

test('review gate: persistent Critical findings stop after 3 reviews with 2 fix attempts', async () => {
  const agent = makeAgent({ reviews: [[CRITICAL]] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, false)
  assert.equal(result.failedGate, 'review')
  assert.equal(agent.checks('Review').length, 3)
  assert.equal(agent.fixes('Review').length, 2)
})

test('a review fix triggers a schema-verified test recheck before the next review round', async () => {
  const agent = makeAgent({ reviews: [[CRITICAL], []] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, true)
  assert.equal(result.gates.review.rounds, 2)
  // initial Run-tests gate + one post-review-fix recheck, both schema-validated
  assert.equal(agent.checks('Run tests').length, 2)
  assert.equal(result.gates.tests.runs, 2)
  // and the recheck sits between the round-1 fix and the round-2 review check
  const fixIdx = agent.calls.findIndex(c => c.opts.phase === 'Review' && !c.opts.schema)
  const recheckIdx = agent.calls.findLastIndex(c => c.opts.phase === 'Run tests' && c.opts.schema)
  const round2Idx = agent.calls.findLastIndex(c => c.opts.phase === 'Review' && c.opts.schema)
  assert.ok(fixIdx < recheckIdx && recheckIdx < round2Idx, 'recheck did not run between fix and next review round')
})

test('a failing test recheck after a review fix fails the pipeline', async () => {
  const agent = makeAgent({ reviews: [[CRITICAL]], testRuns: [true, false] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, false)
  assert.equal(result.failedGate, 'tests-after-review-fix')
  assert.equal(result.lastTestResult.passed, false)
})

// Intentional contract: 0 is not a valid "skip review" request — review is a
// mandatory gate, so falsy values fall back to the default bound of 3.
test('explicit maxReviewRounds: 0 falls back to the default of 3 by design', async () => {
  const agent = makeAgent({ reviews: [[CRITICAL]] })
  const result = await runScript({ ...ARGS, maxReviewRounds: 0 }, agent)
  assert.equal(result.failedGate, 'review')
  assert.equal(agent.checks('Review').length, 3)
})

test('review gate honors maxReviewRounds override', async () => {
  const agent = makeAgent({ reviews: [[CRITICAL]] })
  const result = await runScript({ ...ARGS, maxReviewRounds: 2 }, agent)
  assert.equal(result.ok, false)
  assert.equal(result.failedGate, 'review')
  assert.equal(agent.checks('Review').length, 2)
  assert.equal(agent.fixes('Review').length, 1)
})

test('Medium/Low findings do not trigger the fix loop but are reported', async () => {
  const agent = makeAgent({ audits: [[MEDIUM]], reviews: [[MEDIUM]] })
  const result = await runScript(ARGS, agent)
  assert.equal(result.ok, true)
  assert.equal(result.gates.testAudit.rounds, 1)
  assert.equal(result.gates.review.rounds, 1)
  assert.deepEqual(result.gates.review.remainingFindings, [MEDIUM])
  assert.equal(agent.fixes('Audit tests').length + agent.fixes('Review').length, 0)
})

test('meta declares name, description, and phases matching the phase() calls', async () => {
  const src = await loadSource()
  const metaText = src.match(/export const meta = (\{[\s\S]*?\n\})/)?.[1]
  assert.ok(metaText, 'meta block not found')
  assert.match(metaText, /name: 'ship-build-loop'/)
  assert.match(metaText, /description: '.+'/)
  const metaTitles = [...metaText.matchAll(/title: '([^']+)'/g)].map(m => m[1])
  const phaseCalls = [...src.matchAll(/^phase\('([^']+)'\)/gm)].map(m => m[1])
  assert.deepEqual(metaTitles, phaseCalls)
})

test('script avoids APIs banned in the Workflow sandbox', async () => {
  const src = await loadSource()
  assert.doesNotMatch(src, /Date\.now|Math\.random|new Date\(/)
})

test('SKILL.md invokes the workflow by its plugin name', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
  assert.ok(skill.includes('`name`: `"eng-gates:ship-build-loop"`'), 'SKILL.md does not invoke the workflow by name')
})

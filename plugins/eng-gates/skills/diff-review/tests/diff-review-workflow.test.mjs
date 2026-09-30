import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The script runs inside the Workflow harness with agent/pipeline/parallel/log/args
// as injected globals, so it can't be import()ed. We execute the local source in
// an AsyncFunction with stubbed globals; nothing external is interpolated into it.
const SCRIPT_URL = new URL('../diff-review-workflow.js', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const pipeline = (items, first, second) => Promise.all(items.map(async item => second(await first(item), item)))
const parallel = fns => Promise.all(fns.map(fn => fn()))

async function runScript(args, agentImpl) {
  const src = (await readFile(SCRIPT_URL, 'utf8')).replace('export const meta', 'const meta')
  const fn = new AsyncFunction('agent', 'phase', 'log', 'parallel', 'pipeline', 'args', src)
  return fn(agentImpl, () => {}, () => {}, parallel, pipeline, args)
}

// Each finder reports one critical finding unique to its dimension; every
// refuter upholds it, so the full refuter panel runs and every finding survives.
function makeAgent() {
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push(opts)
    if (opts.phase === 'Find') {
      const dim = opts.label.split(':')[1].split(' ')[0]
      return {
        findings: [{
          file: `src/${dim}.js`, line: 1, severity: 'critical', category: dim,
          summary: 's', failure_scenario: 'f', evidence: 'e',
        }],
      }
    }
    if (opts.phase === 'Verify') return { refuted: false, reason: 'confirmed' }
    throw new Error(`unexpected phase: ${opts.phase}`)
  }
  agent.calls = calls
  return agent
}

// Per the SKILL.md agent budget: finders = dims x rounds (deep's second round
// runs because round 1 yields >= 4 raw findings; its repeats are deduped, so it
// spawns no refuters), refuters = dims x panel size for a critical finding.
const EXPECTED = {
  quick: { finders: 3, refuters: 3 },
  standard: { finders: 4, refuters: 8 },
  deep: { finders: 12, refuters: 12 },
}

for (const [effort, expected] of Object.entries(EXPECTED)) {
  test(`${effort}: spawns the budgeted finders and refuters, all on sonnet at high effort`, async () => {
    const agent = makeAgent()
    await runScript({ range: 'main..HEAD', repoRoot: '/repo', effort }, agent)
    const count = phase => agent.calls.filter(o => o.phase === phase).length
    assert.deepEqual({ finders: count('Find'), refuters: count('Verify') }, expected)
    assert.equal(agent.calls.length, expected.finders + expected.refuters)
    for (const opts of agent.calls) {
      assert.deepEqual({ model: opts.model, effort: opts.effort }, { model: 'sonnet', effort: 'high' }, opts.label)
    }
  })
}

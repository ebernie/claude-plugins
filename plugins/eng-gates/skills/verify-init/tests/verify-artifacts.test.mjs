import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Black-box tests: every test drives the real script through child_process in a
// throwaway repo root. Uploads go through a real (tiny) command that copies into
// a temp "bucket" and records the argv it received, so the bucket contents and
// the recorded argv are the observable side effects.

const SCRIPT = fileURLToPath(new URL('../templates/verify-artifacts.mjs', import.meta.url))
const RUN_ID_REGEX = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/
const VALID_RUN_ID = '20260101T000000Z-0123456789abcdef'
const SUMMARY = 'Walked the checkout flow'
const URL_PREFIX = 'https://pub.example.test/evidence'
const MAX_FILE_BYTES = 25 * 1024 * 1024
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
// Assembled at runtime so this file never contains a scannable credential.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

const REQUIRED = { web: ['console.txt', '*.png'], cli: ['output.txt'] }

const HAPPY_FILES = {
  'web/console.txt': 'GET /health 200\npassword: short\n',
  'web/b-shot.png': PNG_BYTES,
  'web/a-shot.v2.png': Buffer.concat([PNG_BYTES, Buffer.from([9, 9])]),
  'cli/output.txt': 'ok\n',
}

const omit = (files, keys) => Object.fromEntries(Object.entries(files).filter(([key]) => !keys.includes(key)))

const UPLOADER_SOURCE = `
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const [bucket, mode, source, destination, failAtCall] = args
if (mode === 'fail') {
  process.stderr.write('boom: bucket unreachable\\n')
  process.exit(3)
}
if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
mkdirSync(bucket, { recursive: true })
appendFileSync(bucket + '.argv', JSON.stringify(args) + '\\n')
const callNumber = readFileSync(bucket + '.argv', 'utf8').trim().split('\\n').length
if (failAtCall && callNumber === Number(failAtCall)) {
  process.stderr.write('boom: call ' + callNumber + ' rejected\\n')
  process.exit(3)
}
const target = path.join(bucket, destination)
if (mode === 'dir') {
  cpSync(source, target, { recursive: true })
} else {
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(source, target)
}
`

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const urlFor = (runId, key) => `${URL_PREFIX}/${runId}/${key}`

function findNamed(dir, names) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (names.includes(entry.name)) found.push(full)
    if (entry.isDirectory()) found.push(...findNamed(full, names))
  }
  return found
}

function createFixture(t, { git = false, rootName = 'repo' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-artifacts-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, rootName)
  fs.mkdirSync(root)
  if (git) execFileSync('git', ['init', '-q'], { cwd: root })
  const helper = path.join(base, 'uploader.mjs')
  fs.writeFileSync(helper, UPLOADER_SOURCE)
  const bucket = path.join(base, 'bucket')
  const configFile = path.join(root, '.claude', 'skills', 'verify', 'evidence.json')

  const fx = {
    base,
    root,
    bucket,

    uploaderArgv: (...tail) => ['node', helper, bucket, ...tail],

    commandConfig(per) {
      const argv =
        per === 'run'
          ? fx.uploaderArgv('dir', '{dir}', '{runId}')
          : fx.uploaderArgv('file', '{file}', '{runId}/{key}')
      return { backend: 'command', upload: { per, argv, urlTemplate: `${URL_PREFIX}/{runId}/{key}` }, required: REQUIRED }
    },

    commandConfigWithArgv(argv, per = 'run') {
      const config = fx.commandConfig(per)
      config.upload.argv = argv
      return config
    },

    localConfig: () => ({ backend: 'local', required: REQUIRED }),

    writeRawConfig(text) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true })
      fs.writeFileSync(configFile, text)
    },

    writeConfig: (config) => fx.writeRawConfig(JSON.stringify(config)),

    cli(args, { cwd = root, envRoot = true, timeout } = {}) {
      const env = { ...process.env }
      delete env.VERIFY_ARTIFACTS_ROOT
      if (envRoot) env.VERIFY_ARTIFACTS_ROOT = root
      return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', timeout })
    },

    newRun() {
      const result = fx.cli(['new'])
      assert.equal(result.status, 0, result.stderr)
      return /^runId=(.+)$/m.exec(result.stdout)[1]
    },

    staging: (runId) => path.join(root, '.verify-artifacts', runId),

    stage(runId, files) {
      for (const [key, content] of Object.entries(files)) {
        const target = path.join(fx.staging(runId), key)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
    },

    publish(runId, extraArgs = [], summary = SUMMARY) {
      return fx.cli(['publish', runId, '--summary', summary, ...extraArgs])
    },

    uploadInvocations() {
      const file = `${bucket}.argv`
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    },

    manifest: (runId) => JSON.parse(fs.readFileSync(path.join(fx.staging(runId), 'manifest.json'), 'utf8')),

    evidenceExists: (runId) => fs.existsSync(path.join(fx.staging(runId), 'pr-evidence.md')),

    /** Config + a fresh run staged with the given files. */
    prepare(config, files) {
      fx.writeConfig(config)
      const runId = fx.newRun()
      fx.stage(runId, files)
      return runId
    },
  }
  return fx
}

/** A rejected publish (exit 1) must leave no upload and no manifest behind. */
function assertRejected(fx, runId, result, { problemCount, messages }) {
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, new RegExp(`rejected, ${problemCount} problem\\(s\\)`))
  for (const message of messages) assert.match(result.stderr, message)
  assert.equal(result.stdout, '')
  assert.equal(fs.existsSync(fx.bucket), false)
  assert.deepEqual(fx.uploadInvocations(), [])
  if (runId && fs.existsSync(fx.staging(runId))) {
    assert.equal(fs.existsSync(path.join(fx.staging(runId), 'manifest.json')), false)
    assert.equal(fx.evidenceExists(runId), false)
  }
}

/** A config error (exit 2) must leave no upload and no manifest behind. */
function assertConfigRejected(fx, runId, result, { expect, count }) {
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  for (const message of expect) assert.ok(result.stderr.includes(message), `stderr should include ${message}\n${result.stderr}`)
  if (count !== undefined) assert.match(result.stderr, new RegExp(`\\(${count} problem\\(s\\)\\)`))
  assert.equal(fs.existsSync(fx.bucket), false)
  assert.equal(fs.existsSync(path.join(fx.staging(runId), 'manifest.json')), false)
}

// ------------------------------------------------------------------ new

test('new prints exactly runId= and staging= lines, creates the staging dir, and resolves the root via git from a subdirectory', (t) => {
  const fx = createFixture(t, { git: true })
  const nested = path.join(fx.root, 'packages', 'app')
  fs.mkdirSync(nested, { recursive: true })

  const result = fx.cli(['new'], { cwd: nested, envRoot: false })

  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.split('\n')
  assert.equal(lines.pop(), '', 'output ends with a single newline')
  assert.equal(lines.length, 2)
  const [runIdLine, stagingLine] = lines
  assert.match(runIdLine, /^runId=\d{8}T\d{6}Z-[0-9a-f]{16}$/)
  const runId = runIdLine.slice('runId='.length)
  assert.match(runId, RUN_ID_REGEX)
  assert.equal(stagingLine.startsWith('staging='), true)
  const staging = stagingLine.slice('staging='.length)
  assert.equal(path.isAbsolute(staging), true)
  assert.equal(fs.realpathSync(staging), fs.realpathSync(path.join(fx.root, '.verify-artifacts', runId)))
  assert.equal(fs.statSync(staging).isDirectory(), true)
})

test('new appends .verify-artifacts/ to .gitignore exactly once across repeated runs and keeps existing content', (t) => {
  const fx = createFixture(t)
  fs.writeFileSync(path.join(fx.root, '.gitignore'), 'node_modules')

  const first = fx.newRun()
  const second = fx.newRun()

  assert.notEqual(first, second)
  assert.equal(fs.readFileSync(path.join(fx.root, '.gitignore'), 'utf8'), 'node_modules\n.verify-artifacts/\n')
})

test('new leaves a .gitignore untouched when the directory is already ignored in another spelling', (t) => {
  const fx = createFixture(t)
  const original = '/.verify-artifacts\ndist/\n'
  fs.writeFileSync(path.join(fx.root, '.gitignore'), original)

  fx.newRun()

  assert.equal(fs.readFileSync(path.join(fx.root, '.gitignore'), 'utf8'), original)
})

test('new creates a missing .gitignore whose entry makes git ignore the staged evidence', (t) => {
  const fx = createFixture(t, { git: true })

  const runId = fx.newRun()

  const ignored = spawnSync('git', ['check-ignore', '-q', `.verify-artifacts/${runId}/web/x.png`], { cwd: fx.root })
  assert.equal(ignored.status, 0)
})

test('new still appends its entry when .gitignore only lists a similarly named .verify-artifacts-old/', (t) => {
  const fx = createFixture(t, { git: true })
  fs.writeFileSync(path.join(fx.root, '.gitignore'), '.verify-artifacts-old/\n')

  const runId = fx.newRun()

  assert.equal(fs.readFileSync(path.join(fx.root, '.gitignore'), 'utf8'), '.verify-artifacts-old/\n.verify-artifacts/\n')
  const ignored = spawnSync('git', ['check-ignore', '-q', `.verify-artifacts/${runId}/web/x.png`], { cwd: fx.root })
  assert.equal(ignored.status, 0)
})

// ------------------------------------------------------------------ publish happy paths

test('publish per=run uploads the staging dir once, and the manifest records fields and sha256 values', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fx.uploadInvocations().length, 1)
  for (const key of Object.keys(HAPPY_FILES)) {
    assert.deepEqual(fs.readFileSync(path.join(fx.bucket, runId, key)), Buffer.from(HAPPY_FILES[key]))
  }
  assert.equal(fs.existsSync(path.join(fx.bucket, runId, 'pr-evidence.md')), false, 'pr-evidence.md is never uploaded')

  const manifestPath = path.join(fx.staging(runId), 'manifest.json')
  const manifest = fx.manifest(runId)
  assert.deepEqual(fs.readFileSync(path.join(fx.bucket, runId, 'manifest.json')), fs.readFileSync(manifestPath))
  assert.equal(manifest.runId, runId)
  assert.equal(manifest.summary, SUMMARY)
  assert.equal(manifest.backend, 'command')
  assert.equal(new Date(manifest.createdAt).toISOString(), manifest.createdAt)
  assert.deepEqual(manifest.waivers, [])
  assert.deepEqual(manifest.surfacesNotExercised, [])
  const expectedFiles = Object.keys(HAPPY_FILES)
    .sort()
    .map((key) => ({ key, bytes: Buffer.from(HAPPY_FILES[key]).length, sha256: sha256(HAPPY_FILES[key]) }))
  assert.deepEqual(manifest.files, expectedFiles)
})

test('publish per=run prints pr-evidence.md with sorted surfaces and files, image embeds, links, and the manifest hash', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  const manifestSha = sha256(fs.readFileSync(path.join(fx.staging(runId), 'manifest.json')))
  const expected =
    [
      `## User-exercise evidence\n**Summary:** ${SUMMARY}\n**Run:** \`${runId}\``,
      '### cli',
      `- [cli/output.txt](${urlFor(runId, 'cli/output.txt')})`,
      '### web',
      `![web/a-shot.v2.png](${urlFor(runId, 'web/a-shot.v2.png')})`,
      `![web/b-shot.png](${urlFor(runId, 'web/b-shot.png')})`,
      `- [web/console.txt](${urlFor(runId, 'web/console.txt')})`,
      `<!-- manifest sha256: ${manifestSha} -->`,
    ].join('\n\n') + '\n'
  assert.equal(result.stdout, expected)
  assert.equal(fs.readFileSync(path.join(fx.staging(runId), 'pr-evidence.md'), 'utf8'), expected)
})

test('publish per=file uploads every file plus manifest.json once each, using {file}, {key} and {runId}', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('file'), HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fx.uploadInvocations().length, Object.keys(HAPPY_FILES).length + 1)
  for (const key of Object.keys(HAPPY_FILES)) {
    assert.deepEqual(fs.readFileSync(path.join(fx.bucket, runId, key)), Buffer.from(HAPPY_FILES[key]))
  }
  assert.deepEqual(
    fs.readFileSync(path.join(fx.bucket, runId, 'manifest.json')),
    fs.readFileSync(path.join(fx.staging(runId), 'manifest.json')),
  )
  assert.ok(result.stdout.includes(`![web/b-shot.png](${urlFor(runId, 'web/b-shot.png')})`))
})

for (const per of ['run', 'file']) {
  test(`upload placeholders arrive as single verbatim argv elements even when the root path holds shell metacharacters (per=${per})`, (t) => {
    const fx = createFixture(t, { rootName: "repo dir; touch PWNED $(touch PWNED2) '&' $&" })
    const runId = fx.prepare(fx.commandConfig(per), HAPPY_FILES)

    const result = fx.publish(runId)

    assert.equal(result.status, 0, result.stderr)
    const staging = fx.staging(runId)
    if (per === 'run') {
      assert.deepEqual(fx.uploadInvocations(), [[fx.bucket, 'dir', staging, runId]])
    } else {
      const keys = [...Object.keys(HAPPY_FILES).sort(), 'manifest.json']
      assert.deepEqual(
        fx.uploadInvocations(),
        keys.map((key) => [fx.bucket, 'file', path.join(staging, key), `${runId}/${key}`]),
      )
    }
    assert.deepEqual(findNamed(fx.base, ['PWNED', 'PWNED2']), [])
  })
}

test('republishing the same run succeeds and never uploads the previous pr-evidence.md', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)
  assert.equal(fx.publish(runId).status, 0)
  fs.rmSync(fx.bucket, { recursive: true })

  const again = fx.publish(runId)

  assert.equal(again.status, 0, again.stderr)
  assert.equal(fs.existsSync(path.join(fx.bucket, runId, 'web', 'b-shot.png')), true)
  assert.equal(fs.existsSync(path.join(fx.bucket, runId, 'pr-evidence.md')), false)
})

test('surfaces are opt-in per run: configured surfaces absent from staging are not required and are recorded as not exercised', (t) => {
  const fx = createFixture(t)
  const config = fx.commandConfig('run')
  config.required = { web: REQUIRED.web, mobile: ['screen.png'], cli: REQUIRED.cli }
  const runId = fx.prepare(config, omit(HAPPY_FILES, ['cli/output.txt']))

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  const manifest = fx.manifest(runId)
  assert.deepEqual(
    manifest.files.map((file) => file.key),
    ['web/a-shot.v2.png', 'web/b-shot.png', 'web/console.txt'],
  )
  assert.deepEqual(manifest.surfacesNotExercised, ['cli', 'mobile'])
  assert.equal(result.stdout.includes('### cli'), false)
  const notExercised = result.stdout.indexOf('\n\n**Not exercised:** cli, mobile\n\n')
  assert.ok(notExercised > result.stdout.indexOf('### web'))
  assert.ok(notExercised < result.stdout.indexOf('<!-- manifest sha256:'))
})

test('a file of exactly 25 MiB is accepted', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.localConfig(), HAPPY_FILES)
  const exact = path.join(fx.staging(runId), 'web', 'exact.bin')
  fs.writeFileSync(exact, Buffer.alloc(MAX_FILE_BYTES, 0x61))

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  const entry = fx.manifest(runId).files.find((file) => file.key === 'web/exact.bin')
  assert.equal(entry.bytes, MAX_FILE_BYTES)
})

// ------------------------------------------------------------------ local backend and dry-run

test('local backend inlines text truncated at 40 lines, lists images as local only, and uploads nothing', (t) => {
  const fx = createFixture(t)
  const numbered = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const runId = fx.prepare(fx.localConfig(), {
    'web/console.txt': numbered(50),
    'web/shot.png': PNG_BYTES,
    'cli/output.txt': numbered(40),
  })

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(fx.bucket), false)
  assert.equal(result.stdout.includes('https://'), false)
  assert.ok(result.stdout.includes('**web/console.txt**\n```\nline 1\nline 2\n'))
  assert.ok(result.stdout.includes('line 40\n… (truncated)\n```'))
  assert.equal(result.stdout.includes('line 41'), false)
  assert.equal(result.stdout.split('… (truncated)').length - 1, 1, 'a file of exactly 40 lines is not truncated')
  assert.ok(result.stdout.includes('**cli/output.txt**\n```\nline 1\n'))
  assert.ok(result.stdout.includes(`- web/shot.png (local only)\n`))
  assert.equal(fx.manifest(runId).backend, 'local')
})

test('local rendering wraps content that contains code fences in a longer fence and renders an empty file as an empty block', (t) => {
  const fx = createFixture(t)
  const hostile = '```\n![x](https://evil.test/a.png)\n```'
  const runId = fx.prepare(fx.localConfig(), {
    ...omit(HAPPY_FILES, ['web/a-shot.v2.png', 'web/b-shot.png']),
    'web/shot.png': PNG_BYTES,
    'web/notes.txt': hostile,
    'web/empty.txt': '',
  })

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`**web/notes.txt**\n\`\`\`\`\n${hostile}\n\`\`\`\`\n`))
  assert.ok(result.stdout.includes('**web/empty.txt**\n```\n```\n'))
})

test('local rendering caps a text preview at 4,000 characters even within 40 lines', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.localConfig(), { ...HAPPY_FILES, 'web/console.txt': 'x'.repeat(200_000) + '\n' })

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`**web/console.txt**\n\`\`\`\n${'x'.repeat(4000)}\n… (truncated)\n\`\`\`\n`))
  assert.equal(result.stdout.includes('x'.repeat(4001)), false)
})

test('--dry-run with a command backend validates and writes the manifest but uploads nothing and renders local output', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const result = fx.publish(runId, ['--dry-run'])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(fx.bucket), false)
  assert.deepEqual(fx.uploadInvocations(), [])
  assert.equal(fs.existsSync(path.join(fx.staging(runId), 'manifest.json')), true)
  assert.equal(result.stdout.includes(URL_PREFIX), false)
  assert.ok(result.stdout.includes('(local only)'))
})

const DRY_RUN_REJECTIONS = [
  {
    name: 'a credential',
    files: { ...HAPPY_FILES, 'web/console.txt': AWS_KEY },
    message: /web\/console\.txt:1: possible credential \(aws-access-key-id\)/,
  },
  {
    name: 'a missing required file',
    files: omit(HAPPY_FILES, ['web/console.txt']),
    message: /web: no file matches required pattern "console\.txt"/,
  },
]
for (const { name, files, message } of DRY_RUN_REJECTIONS) {
  test(`--dry-run still rejects ${name} with exit 1`, (t) => {
    const fx = createFixture(t)
    const runId = fx.prepare(fx.commandConfig('run'), files)

    const result = fx.publish(runId, ['--dry-run'])

    assertRejected(fx, runId, result, { problemCount: 1, messages: [message] })
  })
}

// ------------------------------------------------------------------ validation: steps 1 and 2

const INVALID_RUN_IDS = [
  ['a traversal segment', '../x'],
  ['a valid id followed by two parent segments', `${VALID_RUN_ID}/../../x`],
  ['a valid id followed by a parent segment', `${VALID_RUN_ID}/..`],
  ['a trailing newline', `${VALID_RUN_ID}\n`],
  ['an absolute path', '/abs/path'],
  ['a trailing character', `${VALID_RUN_ID}x`],
  ['uppercase hex', '20260101T000000Z-0123456789ABCDEF'],
]
for (const [name, runId] of INVALID_RUN_IDS) {
  test(`publish and links both reject a runId with ${name}`, (t) => {
    const fx = createFixture(t)
    fx.writeConfig(fx.commandConfig('run'))
    // Plant what an accepted path would resolve to, so acceptance would be observable.
    const planted = path.join(fx.root, '.verify-artifacts', runId, 'pr-evidence.md')
    fs.mkdirSync(path.dirname(planted), { recursive: true })
    fs.writeFileSync(planted, 'PLANTED')

    const links = fx.cli(['links', runId])
    const publish = fx.publish(runId)

    assert.equal(links.status, 1)
    assert.match(links.stderr, /invalid runId/)
    assert.equal(links.stdout.includes('PLANTED'), false)
    assertRejected(fx, null, publish, { problemCount: 1, messages: [/invalid runId/] })
    assert.equal(fs.readFileSync(planted, 'utf8'), 'PLANTED', 'the planted file was not touched')
  })
}

test('publish rejects a valid runId whose staging directory does not exist', (t) => {
  const fx = createFixture(t)
  fx.writeConfig(fx.commandConfig('run'))

  const result = fx.publish(VALID_RUN_ID)

  assertRejected(fx, null, result, { problemCount: 1, messages: [/staging directory does not exist/] })
})

test('publish rejects a missing or blank --summary', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const blank = fx.publish(runId, [], '')
  const missing = fx.cli(['publish', runId])

  assertRejected(fx, runId, blank, { problemCount: 1, messages: [/--summary is required and must not be empty/] })
  assertRejected(fx, runId, missing, { problemCount: 1, messages: [/--summary is required and must not be empty/] })
})

test('publish rejects a --summary containing a credential without echoing it', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const result = fx.publish(runId, [], `deployed using ${AWS_KEY} from the shell`)

  assertRejected(fx, runId, result, {
    problemCount: 1,
    messages: [/--summary: possible credential \(aws-access-key-id\)/],
  })
  assert.equal((result.stdout + result.stderr).includes(AWS_KEY), false)
})

test('publish rejects unknown surface directories and stray top-level files', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'mobile/x.txt': 'hi', 'notes.txt': 'stray' })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: 2,
    messages: [/mobile\/: unknown surface \(configured: web, cli\)/, /notes\.txt: top-level entries must be surface directories/],
  })
})

// ------------------------------------------------------------------ validation: step 3

test('publish rejects a file name outside the allowed character set', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/bad name.png': PNG_BYTES })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, { problemCount: 1, messages: [/web\/bad name\.png: file name must match/] })
})

const SYMLINK_CASES = [
  {
    name: 'a file symlink (its target is neither followed nor scanned)',
    setup: ({ outside, staging }) => fs.symlinkSync(outside, path.join(staging, 'web', 'link.txt')),
    message: /web\/link\.txt: symlinks are not allowed/,
  },
  {
    name: 'a dangling file symlink',
    setup: ({ fx, staging }) => fs.symlinkSync(path.join(fx.base, 'missing.txt'), path.join(staging, 'web', 'dangling.txt')),
    message: /web\/dangling\.txt: symlinks are not allowed/,
  },
  {
    name: 'a symlinked surface directory',
    setup: ({ fx, staging }) => {
      const real = path.join(fx.base, 'real-web')
      fs.renameSync(path.join(staging, 'web'), real)
      fs.symlinkSync(real, path.join(staging, 'web'))
    },
    message: /web: top-level entries must be surface directories/,
  },
  {
    name: 'a top-level manifest.json symlink',
    setup: ({ outside, staging }) => fs.symlinkSync(outside, path.join(staging, 'manifest.json')),
    message: /manifest\.json: top-level entries must be surface directories/,
  },
]
for (const { name, setup, message } of SYMLINK_CASES) {
  test(`publish rejects ${name} and modifies nothing outside staging`, (t) => {
    const fx = createFixture(t)
    const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)
    const outside = path.join(fx.base, 'outside.txt')
    const outsideContent = `ORIGINAL ${AWS_KEY}`
    fs.writeFileSync(outside, outsideContent)
    setup({ fx, staging: fx.staging(runId), outside })

    const result = fx.publish(runId)

    assertRejected(fx, null, result, { problemCount: 1, messages: [message] })
    assert.equal(fs.readFileSync(outside, 'utf8'), outsideContent)
  })
}

test('publish rejects files nested deeper than <surface>/<file>', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/sub/deep.txt': 'x' })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, { problemCount: 1, messages: [/web\/sub\/: nested directories are not allowed/] })
})

test('publish rejects a file larger than 25 MiB', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)
  const big = path.join(fx.staging(runId), 'web', 'big.bin')
  fs.writeFileSync(big, '')
  fs.truncateSync(big, MAX_FILE_BYTES + 1)

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: 1,
    messages: [new RegExp(`web/big\\.bin: ${MAX_FILE_BYTES + 1} bytes exceeds the 25 MiB limit`)],
  })
})

// ------------------------------------------------------------------ validation: step 4 (required and waivers)

test('publish rejects a surface that lacks a required file and names the missing pattern', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), omit(HAPPY_FILES, ['web/b-shot.png', 'web/a-shot.v2.png']))

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, { problemCount: 1, messages: [/web: no file matches required pattern "\*\.png"/] })
  assert.doesNotMatch(result.stderr, /console\.txt/)
})

test('a waive covers only the pattern it names, leaving other missing patterns reported', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), {
    'web/other.txt': 'x',
    'cli/output.txt': 'ok',
  })

  const result = fx.publish(runId, ['--waive', 'web:*.png=no visuals in this run'])

  assertRejected(fx, runId, result, { problemCount: 1, messages: [/web: no file matches required pattern "console\.txt"/] })
  assert.doesNotMatch(result.stderr, /\*\.png/)
})

test('a valid --waive lets the run pass and is recorded in the manifest and pr-evidence.md', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), omit(HAPPY_FILES, ['web/b-shot.png', 'web/a-shot.v2.png']))
  const reason = 'headless run = with no visual output'

  const result = fx.publish(runId, ['--waive', `web:*.png=${reason}`])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(fx.manifest(runId).waivers, [{ surface: 'web', pattern: '*.png', reason }])
  assert.ok(result.stdout.includes(`**Waived:**\n- \`web:*.png\`: ${reason}`))
  const waivedIndex = result.stdout.indexOf('**Waived:**')
  assert.ok(waivedIndex > result.stdout.indexOf('### web'))
  assert.ok(waivedIndex < result.stdout.indexOf('<!-- manifest sha256:'))
})

test('publish reports every invalid --waive: malformed, unknown surface, unknown pattern, empty reason', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const result = fx.publish(runId, [
    '--waive', 'nonsense',
    '--waive', 'mobile:*.png=some reason',
    '--waive', 'web:*.gif=some reason',
    '--waive', 'web:*.png=   ',
  ])

  assertRejected(fx, runId, result, {
    problemCount: 4,
    messages: [
      /--waive #1: expected "<surface>:<pattern>=<reason>"/,
      /--waive mobile:\*\.png: surface "mobile" is not in the config/,
      /--waive web:\*\.gif: pattern "\*\.gif" is not required for surface "web"/,
      /--waive web:\*\.png: a non-empty reason is required/,
    ],
  })
})

test('a --waive for a configured surface that is absent from staging is rejected', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), omit(HAPPY_FILES, ['cli/output.txt']))

  const result = fx.publish(runId, ['--waive', 'cli:output.txt=not touched by this change'])

  assertRejected(fx, runId, result, {
    problemCount: 1,
    messages: [/--waive cli:output\.txt: surface "cli" is not present in this run's staging/],
  })
})

test('publish rejects credentials inside waive reasons, valid or not, without echoing them', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), omit(HAPPY_FILES, ['web/b-shot.png', 'web/a-shot.v2.png']))

  const result = fx.publish(runId, [
    '--waive', `web:*.png=used ${AWS_KEY} to log in`,
    '--waive', `mobile:*.png=${AWS_KEY}`,
  ])

  assertRejected(fx, runId, result, {
    problemCount: 3,
    messages: [
      /--waive web:\*\.png: possible credential \(aws-access-key-id\)/,
      /--waive mobile:\*\.png: possible credential \(aws-access-key-id\)/,
      /--waive mobile:\*\.png: surface "mobile" is not in the config/,
    ],
  })
  assert.equal((result.stdout + result.stderr).includes(AWS_KEY), false)
})

// ------------------------------------------------------------------ validation: step 5 (credentials)

const CREDENTIAL_CASES = [
  { name: 'aws-access-key-id', before: 'aws id ', secret: AWS_KEY },
  { name: 'aws-access-key-id', before: 'session ', secret: 'ASIA' + 'IOSFODNN7EXAMPLE' },
  { name: 'generic-secret-assignment', before: 'SECRET_KEY=', secret: 'abcdEFGH12345678' },
  { name: 'generic-secret-assignment', before: 'AWS_SECRET_ACCESS_KEY=', secret: 'wJalrXUtnFEMI/K7MDENG' },
  { name: 'generic-secret-assignment', before: 'DB_PASSWORD_PROD: ', secret: 'pg-s3cr3t-value' },
  { name: 'aws-access-key-id', before: 'MY_', secret: 'AKIA' + 'JSAMPLEKEY0123456' },
  { name: 'aws-access-key-id', before: '', secret: 'AKIA' + 'KLINESTARTKEY01234', lineStart: true },
  { name: 'github-token', before: 'key="', secret: 'ghp_' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8', after: '"' },
  { name: 'sk-key', before: '(', secret: 'sk-' + 'live_zxcvbnmasdfghjkl1234', after: ')' },
  { name: 'slack-token', before: '/', secret: 'xoxb-' + '555555555555-qwertyQWERTY' },
  { name: 'private-key', before: '-----', secret: 'BEGIN RSA ' + 'PRIVATE KEY-----' },
  { name: 'github-token', before: '', secret: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' },
  { name: 'github-token', before: '', secret: 'gho_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' },
  { name: 'github-token', before: '', secret: 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop' },
  { name: 'slack-token', before: '', secret: 'xoxb-' + '123456789012-abcdefABCDEF' },
  { name: 'slack-token', before: '', secret: 'xoxp-' + '987654321098-zyxwvuZYXWVU' },
  { name: 'sk-key', before: '', secret: 'sk-' + 'proj_abcdefghij0123456789XYZ' },
  { name: 'bearer-token', before: 'Authorization: Bearer ', secret: 'abcdefghij0123456789ABCDEF' },
  { name: 'generic-secret-assignment', before: '"password": "', secret: 'correcthorsebattery', after: '"' },
  { name: 'generic-secret-assignment', before: 'password=', secret: 'hunter2hunter2' },
  { name: 'generic-secret-assignment', before: 'passwd: ', secret: 'letmeinletmein' },
  { name: 'generic-secret-assignment', before: 'api_key = "', secret: 'abcd1234efgh5678', after: '"' },
  { name: 'generic-secret-assignment', before: 'API-KEY: ', secret: 'qwertyuiop123456' },
  { name: 'generic-secret-assignment', before: 'SECRET=', secret: 'zyxwvutsrqponm' },
  { name: 'generic-secret-assignment', before: 'token: ', secret: 'mnbvcxz987654321' },
]

test('credential scan reports file:line and pattern name for every secret shape and never prints the secret value', (t) => {
  const fx = createFixture(t)
  const lines = CREDENTIAL_CASES.map(({ before, secret, after = '', lineStart = false }) => `${lineStart ? '' : 'note '}${before}${secret}${after}`)
  const consoleText = ['clean line', ...lines, 'clean line'].join('\n')
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/console.txt': consoleText })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: CREDENTIAL_CASES.length,
    messages: CREDENTIAL_CASES.map(
      ({ name }, index) => new RegExp(`web/console\\.txt:${index + 2}: possible credential \\(${name}\\)`),
    ),
  })
  const output = result.stdout + result.stderr
  for (const { secret } of CREDENTIAL_CASES) {
    assert.equal(output.includes(secret), false, `the secret value ${secret.slice(0, 4)}... must not be echoed`)
  }
})

test('credential scan covers every non-image file whatever its extension', (t) => {
  const fx = createFixture(t)
  const extras = ['web/x.pem', 'web/id_rsa', 'web/notes.conf', 'web/x.dat']
  const runId = fx.prepare(fx.commandConfig('run'), {
    ...HAPPY_FILES,
    ...Object.fromEntries(extras.map((key) => [key, `key ${AWS_KEY}\n`])),
  })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: extras.length,
    messages: extras.map((key) => new RegExp(`${key.replace('.', '\\.')}:1: possible credential \\(aws-access-key-id\\)`)),
  })
})

test('credential scan skips files whose leading bytes are a real image signature, whatever the extension case', (t) => {
  const fx = createFixture(t)
  const secretTail = Buffer.from(AWS_KEY)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), secretTail])
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0]), secretTail])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([0x20]), secretTail])
  const runId = fx.prepare(fx.commandConfig('run'), {
    ...HAPPY_FILES,
    'web/b-shot.png': Buffer.concat([PNG_BYTES, secretTail]),
    'web/photo.JPG': jpeg,
    'web/anim.gif': gif,
    'web/pic.webp': webp,
  })

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
})

for (const { name, content } of [
  { name: 'x.png', content: `key ${AWS_KEY}\n` },
  { name: 'x.webp', content: Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 1, 1, 1]), Buffer.from('WAVE'), Buffer.from(` ${AWS_KEY}\n`)]) },
]) {
  test(`credential scan still scans ${name} when its bytes are not that image format`, (t) => {
    const fx = createFixture(t)
    const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, [`web/${name}`]: content })

    const result = fx.publish(runId)

    assertRejected(fx, runId, result, {
      problemCount: 1,
      messages: [new RegExp(`web/${name.replace('.', '\\.')}:1: possible credential \\(aws-access-key-id\\)`)],
    })
    assert.equal((result.stdout + result.stderr).includes(AWS_KEY), false)
  })
}

test('credential scan does not flag realistic hyphenated words or short values', (t) => {
  const fx = createFixture(t)
  const benign = [
    'task-runner-configuration-values',
    'disk-usage-report-2026-monthly',
    'risk-management-dashboard',
    'tokens: 12',
    'api_key=short',
    'password: short',
    'Bearer x',
  ]
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/console.txt': benign.join('\n') })

  const result = fx.publish(runId)

  assert.equal(result.status, 0, result.stderr)
})

test('the generic assignment pattern is deliberately strict: ordinary-looking 8+ character values are rejected', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), {
    ...HAPPY_FILES,
    'web/console.txt': 'password: required\ntoken: expired-in-5min\n',
  })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: 2,
    messages: [
      /web\/console\.txt:1: possible credential \(generic-secret-assignment\)/,
      /web\/console\.txt:2: possible credential \(generic-secret-assignment\)/,
    ],
  })
})

test('credential scan rejects a non-image binary file (NUL byte in the first 8 KiB)', (t) => {
  const fx = createFixture(t)
  const zipLike = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), Buffer.from(`payload ${AWS_KEY}`)])
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/trace.zip': zipLike })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: 1,
    messages: [/web\/trace\.zip: binary file cannot be credential-scanned; save text evidence as text, screenshots as images/],
  })
})

test('credential scan finishes quickly on a 100,000-repetition "BEGIN " line that is not a private key', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/console.txt': 'BEGIN '.repeat(100_000) })

  // An unbounded `BEGIN.*PRIVATE KEY` is quadratic here and blows this budget.
  const result = fx.cli(['publish', runId, '--summary', SUMMARY], { timeout: 5000 })

  assert.equal(result.status, 0, result.stderr)
})

test('publish rejects an empty staging directory', (t) => {
  const fx = createFixture(t)
  fx.writeConfig(fx.commandConfig('run'))
  const runId = fx.newRun()

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, { problemCount: 1, messages: [/no surface directories found/] })
})

test('publish rejects a staging directory holding only a top-level manifest.json', (t) => {
  const fx = createFixture(t)
  fx.writeConfig(fx.commandConfig('run'))
  const runId = fx.newRun()
  fx.stage(runId, { 'manifest.json': '{}' })

  const result = fx.publish(runId)

  assertRejected(fx, null, result, { problemCount: 1, messages: [/no surface directories found/] })
})

test('credential length thresholds: sk- needs 20 characters and a generic value needs 8', (t) => {
  const fx = createFixture(t)
  const consoleText = [
    'note sk-' + 'a'.repeat(19),
    'note sk-' + 'a'.repeat(20),
    'note password=' + 'a'.repeat(7),
    'note password=' + 'a'.repeat(8),
  ].join('\n')
  const runId = fx.prepare(fx.commandConfig('run'), { ...HAPPY_FILES, 'web/console.txt': consoleText })

  const result = fx.publish(runId)

  assertRejected(fx, runId, result, {
    problemCount: 2,
    messages: [
      /web\/console\.txt:2: possible credential \(sk-key\)/,
      /web\/console\.txt:4: possible credential \(generic-secret-assignment\)/,
    ],
  })
})

// ------------------------------------------------------------------ validation: everything at once

test('publish lists every problem from all validation steps in a single rejection', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), {
    'mobile/x.txt': 'hi',
    'notes.txt': 'stray',
    'web/bad name.png': PNG_BYTES,
    'web/console.txt': AWS_KEY,
    'cli/output.txt': 'ok',
  })

  const result = fx.publish(runId, ['--waive', 'web:*.gif=nope'])

  assertRejected(fx, runId, result, {
    problemCount: 6,
    messages: [
      /mobile\/: unknown surface/,
      /notes\.txt: top-level entries/,
      /web\/bad name\.png: file name must match/,
      /--waive web:\*\.gif: pattern "\*\.gif" is not required/,
      /web: no file matches required pattern "\*\.png"/,
      /web\/console\.txt:1: possible credential \(aws-access-key-id\)/,
    ],
  })
})

// ------------------------------------------------------------------ config errors

const withUpload = (per, mutate) => (fx) => {
  const config = fx.commandConfig(per)
  mutate(config.upload)
  return config
}

const CONFIG_CASES = [
  {
    name: 'a non-https urlTemplate',
    build: withUpload('run', (upload) => { upload.urlTemplate = 'http://pub.example.test/{runId}/{key}' }),
    expect: ['upload.urlTemplate must be a string starting with "https://"'],
  },
  {
    name: 'an unknown placeholder in argv',
    build: withUpload('run', (upload) => { upload.argv.push('{bucket}') }),
    expect: ['upload.argv[6]: unknown placeholder {bucket}'],
  },
  {
    name: '{file} used with per=run',
    build: withUpload('run', (upload) => { upload.argv.push('{file}') }),
    expect: ['upload.argv[6]: placeholder {file} is not valid for per=run'],
  },
  {
    name: '{key} used with per=run',
    build: withUpload('run', (upload) => { upload.argv.push('{key}') }),
    expect: ['upload.argv[6]: placeholder {key} is not valid for per=run'],
  },
  {
    name: '{dir} used with per=file',
    build: withUpload('file', (upload) => { upload.argv.push('{dir}') }),
    expect: ['upload.argv[6]: placeholder {dir} is not valid for per=file'],
  },
  {
    name: '{file} used in urlTemplate',
    build: withUpload('run', (upload) => { upload.urlTemplate = 'https://pub.example.test/{file}' }),
    expect: ['upload.urlTemplate: placeholder {file} is not valid for urlTemplate'],
  },
  {
    name: 'an empty argv',
    build: withUpload('run', (upload) => { upload.argv = [] }),
    expect: ['upload.argv must be a non-empty array of strings'],
  },
  {
    name: 'a non-string argv element',
    build: withUpload('run', (upload) => { upload.argv = ['node', 7] }),
    expect: ['upload.argv must be a non-empty array of strings'],
  },
  {
    name: 'an empty executable in argv[0]',
    build: withUpload('run', (upload) => { upload.argv = ['', '{dir}'] }),
    expect: ['upload.argv[0] (the executable) must not be empty'],
  },
  {
    name: 'an invalid upload.per',
    build: withUpload('run', (upload) => { upload.per = 'batch' }),
    expect: ['upload.per must be "run" or "file"'],
  },
  {
    name: 'an unknown upload key',
    build: withUpload('run', (upload) => { upload.credentials = 'x' }),
    expect: ['upload.credentials: unknown key'],
  },
  {
    name: 'an unknown top-level key',
    build: (fx) => ({ ...fx.commandConfig('run'), extra: true }),
    expect: ['extra: unknown key'],
  },
  {
    name: 'an invalid backend',
    build: (fx) => ({ ...fx.commandConfig('run'), backend: 's3' }),
    expect: ['backend must be "command" or "local"'],
  },
  {
    name: 'upload together with backend=local',
    build: (fx) => ({ ...fx.localConfig(), upload: fx.commandConfig('run').upload }),
    expect: ['upload must be omitted when backend is "local"'],
  },
  {
    name: 'backend=command without upload',
    build: (fx) => ({ backend: 'command', required: fx.localConfig().required }),
    expect: ['upload is required when backend is "command"'],
  },
  {
    name: 'an empty required object',
    build: () => ({ backend: 'local', required: {} }),
    expect: ['required must be an object with at least one surface'],
  },
  {
    name: 'invalid JSON',
    raw: '{"backend": ',
    expect: ['is not valid JSON'],
  },
  {
    name: 'a top-level array',
    raw: '[]',
    expect: ['top level must be a JSON object'],
  },
  {
    name: 'a missing evidence.json',
    noConfig: true,
    expect: ['cannot read config'],
  },
  {
    name: 'bad surface names and patterns, all reported together',
    build: () => ({ backend: 'local', required: { Web: ['a.txt'], web: ['*.tar.gz', 'sub/x.txt'] } }),
    expect: [
      'surface name "Web" must match',
      'pattern "*.tar.gz" must be an exact file name or "*.<ext>"',
      'pattern "sub/x.txt" must be an exact file name or "*.<ext>"',
    ],
    count: 3,
  },
]
for (const { name, build, raw, noConfig, expect, count } of CONFIG_CASES) {
  test(`config error (exit 2): ${name}`, (t) => {
    const fx = createFixture(t)
    const runId = fx.newRun()
    fx.stage(runId, HAPPY_FILES)
    if (raw !== undefined) fx.writeRawConfig(raw)
    else if (!noConfig) fx.writeConfig(build(fx))

    const result = fx.publish(runId)

    assertConfigRejected(fx, runId, result, { expect, count })
  })
}

// ------------------------------------------------------------------ upload failures

test('a failing upload command exits 1 naming the command and its stderr, and writes no pr-evidence.md', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfigWithArgv(fx.uploaderArgv('fail')), HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(`upload command failed (exit code 3): ${fx.uploaderArgv('fail').join(' ')}`))
  assert.match(result.stderr, /boom: bucket unreachable/)
  assert.equal(result.stdout, '')
  assert.equal(fx.evidenceExists(runId), false)
})

test('an upload command killed by a signal exits 1 naming the command and the signal', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfigWithArgv(fx.uploaderArgv('kill')), HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(`upload command failed (killed by SIGKILL): ${fx.uploaderArgv('kill').join(' ')}`))
  assert.equal(fx.evidenceExists(runId), false)
})

test('an upload executable that cannot be spawned exits 1 naming the command and writes no pr-evidence.md', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfigWithArgv(['definitely-not-a-real-binary-xyz', '{dir}']), HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /upload command could not be run: definitely-not-a-real-binary-xyz /)
  assert.equal(fx.evidenceExists(runId), false)
})

test('per=file stops at the first failing upload, names that command, and writes no pr-evidence.md', (t) => {
  const fx = createFixture(t)
  const config = fx.commandConfig('file')
  config.upload.argv.push('2')
  const runId = fx.prepare(config, HAPPY_FILES)

  const result = fx.publish(runId)

  assert.equal(result.status, 1)
  assert.equal(fx.uploadInvocations().length, 2, 'the third upload never starts')
  const failingFile = path.join(fx.staging(runId), 'web', 'a-shot.v2.png')
  assert.ok(result.stderr.includes('upload command failed (exit code 3): node'))
  assert.ok(result.stderr.includes(failingFile))
  assert.match(result.stderr, /boom: call 2 rejected/)
  assert.equal(fs.existsSync(path.join(fx.bucket, runId, 'cli', 'output.txt')), true)
  assert.equal(fs.existsSync(path.join(fx.bucket, runId, 'web', 'a-shot.v2.png')), false)
  assert.equal(fx.evidenceExists(runId), false)
})

test('a failed re-publish removes the earlier pr-evidence.md so links cannot serve stale evidence (upload failure)', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)
  assert.equal(fx.publish(runId).status, 0)
  assert.equal(fx.cli(['links', runId]).status, 0)
  fx.writeConfig(fx.commandConfigWithArgv(fx.uploaderArgv('fail')))

  const failed = fx.publish(runId)
  const links = fx.cli(['links', runId])

  assert.equal(failed.status, 1)
  assert.equal(fx.evidenceExists(runId), false)
  assert.equal(links.status, 1)
  assert.equal(links.stdout, '')
})

test('a failed re-publish removes the earlier pr-evidence.md so links cannot serve stale evidence (validation failure)', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)
  assert.equal(fx.publish(runId).status, 0)
  fx.stage(runId, { 'web/bad name.png': PNG_BYTES })

  const failed = fx.publish(runId)
  const links = fx.cli(['links', runId])

  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /web\/bad name\.png: file name must match/)
  assert.equal(fx.evidenceExists(runId), false)
  assert.equal(links.status, 1)
  assert.equal(links.stdout, '')
})

// ------------------------------------------------------------------ links and usage

test('links prints the stored pr-evidence.md after publish and exits 1 before it exists', (t) => {
  const fx = createFixture(t)
  const runId = fx.prepare(fx.commandConfig('run'), HAPPY_FILES)

  const before = fx.cli(['links', runId])
  const published = fx.publish(runId)
  const after = fx.cli(['links', runId])

  assert.equal(before.status, 1)
  assert.match(before.stderr, /no pr-evidence\.md for run/)
  assert.equal(after.status, 0, after.stderr)
  assert.equal(after.stdout, published.stdout)
})

test('an unknown command, a missing command, and a publish without a runId print usage and exit 2', (t) => {
  const fx = createFixture(t)

  const unknown = fx.cli(['frobnicate'])
  const none = fx.cli([])
  const noRunId = fx.cli(['publish', '--summary', 'x'])

  for (const result of [unknown, none, noRunId]) {
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Usage:/)
  }
  assert.match(unknown.stderr, /unknown command "frobnicate"/)
  assert.match(noRunId.stderr, /publish takes exactly one <runId>/)
})

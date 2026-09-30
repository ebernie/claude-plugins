#!/usr/bin/env node
// Stages /verify evidence under <repo>/.verify-artifacts/<runId>/, validates it,
// uploads it through the user-configured command, and renders pr-evidence.md.
// Evidence is never committed. Config: .claude/skills/verify/evidence.json.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

/**
 * @typedef {'command' | 'local'} Backend
 * @typedef {{ per: 'run' | 'file', argv: string[], urlTemplate: string }} UploadConfig
 * @typedef {{ backend: Backend, upload?: UploadConfig, required: Record<string, string[]> }} Config
 * @typedef {{ surface: string, name: string, key: string, absPath: string, bytes: number }} StagedFile
 * @typedef {{ surface: string, pattern: string, reason: string }} Waiver
 * @typedef {{ key: string, bytes: number, sha256: string }} ManifestFile
 * @typedef {{ runId: string, summary: string, createdAt: string, backend: Backend, files: ManifestFile[], waivers: Waiver[], surfacesNotExercised: string[] }} Manifest
 * @typedef {{ runId: string, summary: string | undefined, waiveSpecs: string[], dryRun: boolean }} PublishOptions
 */

const CONFIG_RELATIVE_PATH = '.claude/skills/verify/evidence.json'
const STAGING_DIR_NAME = '.verify-artifacts'
const MANIFEST_NAME = 'manifest.json'
const EVIDENCE_NAME = 'pr-evidence.md'
const RESERVED_FILES = new Set([MANIFEST_NAME, EVIDENCE_NAME])
const MAX_FILE_BYTES = 25 * 1024 * 1024
const TEXT_PREVIEW_LINES = 40
const STDERR_TAIL_LINES = 20
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/
const SURFACE_PATTERN = /^[a-z][a-z0-9-]*$/
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EXTENSION_GLOB_PATTERN = /^\*\.[A-Za-z0-9]+$/
const WAIVE_PATTERN = /^([^:=]+):([^=]+)=([\s\S]*)$/
const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'json', 'md', 'csv', 'html', 'xml', 'yaml', 'yml', 'har', 'js', 'ts'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGE_SIGNATURES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from('GIF87a', 'latin1'),
  Buffer.from('GIF89a', 'latin1'),
]
const SIGNATURE_READ_BYTES = 12
const BINARY_SNIFF_BYTES = 8 * 1024
const TEXT_PREVIEW_CHARS = 4000

const ARGV_PLACEHOLDERS = { run: ['dir', 'runId'], file: ['file', 'key', 'runId'] }
const URL_PLACEHOLDERS = ['runId', 'key']
const KNOWN_PLACEHOLDERS = new Set(['dir', 'file', 'key', 'runId'])

const GITIGNORE_ENTRIES = new Set([STAGING_DIR_NAME, `${STAGING_DIR_NAME}/`, `/${STAGING_DIR_NAME}`, `/${STAGING_DIR_NAME}/`])

// Prefix patterns must not follow a letter or digit, so ordinary hyphenated
// words such as "task-runner-configuration-values" (which contains "sk-...")
// are not flagged, while a secret after _ = " ( / or at line start still is.
// The generic assignment pattern tolerates a closing quote before the
// separator so that JSON ("password": "...") is caught too, and a bounded name
// suffix so SECRET_KEY= and AWS_SECRET_ACCESS_KEY= are caught (bounded to keep
// scanning linear on pathological lines). Its strictness is
// intentional: a false positive is a blocked publish that is reported, not
// worked around; a false negative publishes a secret to a public bucket.
const CREDENTIAL_PATTERNS = [
  { name: 'aws-access-key-id', regex: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  { name: 'private-key', regex: /BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/ },
  { name: 'github-token', regex: /(?<![A-Za-z0-9])(?:ghp_|gho_|github_pat_)/ },
  { name: 'slack-token', regex: /(?<![A-Za-z0-9])xox[abprs]-/ },
  { name: 'sk-key', regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'bearer-token', regex: /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: 'generic-secret-assignment', regex: /(?:password|passwd|secret|api[_-]?key|token)[A-Za-z0-9_-]{0,40}["']?\s*[:=]\s*["']?[^\s"']{8,}/i },
]

const USAGE = `Usage:
  node verify-artifacts.mjs new
  node verify-artifacts.mjs publish <runId> --summary "<text>" [--waive "<surface>:<pattern>=<reason>"]... [--dry-run]
  node verify-artifacts.mjs links <runId>`

class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   * @param {string[]} [problems]
   */
  constructor(message, exitCode, problems = []) {
    super(message)
    this.exitCode = exitCode
    this.problems = problems
  }

  format() {
    return [this.message, ...this.problems.map((problem) => `  - ${problem}`)].join('\n')
  }
}

/** @param {string} detail */
const usageError = (detail) => new CliError(`${detail}\n${USAGE}`, 2)

/** @param {string[]} problems */
const rejection = (problems) =>
  new CliError(`publish rejected, ${problems.length} problem(s); nothing was uploaded:`, 1, problems)

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {string} name */
const extensionOf = (name) => path.extname(name).slice(1).toLowerCase()

/** @param {string} a @param {string} b */
const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// ---------------------------------------------------------------- config

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} allowed
 * @param {string} prefix
 */
function unknownKeyProblems(obj, allowed, prefix) {
  return Object.keys(obj)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${prefix}${key}: unknown key`)
}

/**
 * @param {string} template
 * @param {string[]} allowed
 * @param {string} where
 * @param {string} context
 */
function placeholderProblems(template, allowed, where, context) {
  const problems = []
  for (const [, name] of template.matchAll(PLACEHOLDER_PATTERN)) {
    if (allowed.includes(name)) continue
    const allowedList = allowed.map((entry) => `{${entry}}`).join(', ')
    problems.push(
      KNOWN_PLACEHOLDERS.has(name)
        ? `${where}: placeholder {${name}} is not valid for ${context} (allowed: ${allowedList})`
        : `${where}: unknown placeholder {${name}} (allowed for ${context}: ${allowedList})`,
    )
  }
  return problems
}

/** @param {unknown} upload */
function validateUpload(upload) {
  if (!isPlainObject(upload)) return ['upload is required when backend is "command" and must be an object']
  const problems = unknownKeyProblems(upload, ['per', 'argv', 'urlTemplate'], 'upload.')
  const { per, argv, urlTemplate } = upload
  const perIsValid = per === 'run' || per === 'file'
  if (!perIsValid) problems.push('upload.per must be "run" or "file"')

  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((element) => typeof element === 'string')) {
    problems.push('upload.argv must be a non-empty array of strings')
  } else if (argv[0] === '') {
    problems.push('upload.argv[0] (the executable) must not be empty')
  } else if (perIsValid) {
    argv.forEach((element, index) =>
      problems.push(...placeholderProblems(element, ARGV_PLACEHOLDERS[per], `upload.argv[${index}]`, `per=${per}`)),
    )
  }

  if (typeof urlTemplate !== 'string' || !urlTemplate.startsWith('https://')) {
    problems.push('upload.urlTemplate must be a string starting with "https://"')
  } else {
    problems.push(...placeholderProblems(urlTemplate, URL_PLACEHOLDERS, 'upload.urlTemplate', 'urlTemplate'))
  }
  return problems
}

/** @param {unknown} required */
function validateRequired(required) {
  if (!isPlainObject(required) || Object.keys(required).length === 0) {
    return ['required must be an object with at least one surface']
  }
  const problems = []
  for (const [surface, patterns] of Object.entries(required)) {
    if (!SURFACE_PATTERN.test(surface)) problems.push(`required: surface name "${surface}" must match ${SURFACE_PATTERN}`)
    if (!Array.isArray(patterns) || patterns.length === 0) {
      problems.push(`required.${surface} must be a non-empty array of patterns`)
      continue
    }
    for (const pattern of patterns) {
      const valid = typeof pattern === 'string' && (FILE_NAME_PATTERN.test(pattern) || EXTENSION_GLOB_PATTERN.test(pattern))
      if (!valid) problems.push(`required.${surface}: pattern ${JSON.stringify(pattern)} must be an exact file name or "*.<ext>"`)
    }
  }
  return problems
}

/** @param {unknown} config */
function validateConfig(config) {
  if (!isPlainObject(config)) return ['top level must be a JSON object']
  const problems = unknownKeyProblems(config, ['backend', 'upload', 'required'], '')
  if (config.backend !== 'command' && config.backend !== 'local') {
    problems.push('backend must be "command" or "local"')
  } else if (config.backend === 'command') {
    problems.push(...validateUpload(config.upload))
  } else if (config.upload !== undefined) {
    problems.push('upload must be omitted when backend is "local"')
  }
  problems.push(...validateRequired(config.required))
  return problems
}

/** @param {string} root @returns {Config} */
function loadConfig(root) {
  const configPath = path.join(root, CONFIG_RELATIVE_PATH)
  let text
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    throw new CliError(`cannot read config ${configPath}: ${err.message}`, 2)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(`config ${configPath} is not valid JSON: ${err.message}`, 2)
  }
  const problems = validateConfig(parsed)
  if (problems.length > 0) throw new CliError(`invalid config ${configPath} (${problems.length} problem(s)):`, 2, problems)
  return parsed
}

/** @param {string} template @param {Record<string, string>} values */
const fillTemplate = (template, values) => template.replace(PLACEHOLDER_PATTERN, (_, name) => values[name])

// ---------------------------------------------------------------- root, runId, staging

function resolveRoot() {
  const override = process.env.VERIFY_ARTIFACTS_ROOT
  if (override) return path.resolve(override)
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new CliError('cannot determine the repo root: run inside a git repository or set VERIFY_ARTIFACTS_ROOT', 2)
  }
  return result.stdout.trim()
}

/** @param {Date} [now] */
function generateRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${randomBytes(8).toString('hex')}`
}

/** @param {string} root @param {string} runId */
const stagingPath = (root, runId) => path.join(root, STAGING_DIR_NAME, runId)

/** @param {string} dir */
const isDirectory = (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory()

/** @param {string} runId */
function assertValidRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId)) throw new CliError(`invalid runId ${JSON.stringify(runId)}: must match ${RUN_ID_PATTERN}`, 1)
}

/** @param {string} root */
function ensureGitignored(root) {
  const gitignore = path.join(root, '.gitignore')
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : ''
  if (existing.split(/\r?\n/).some((line) => GITIGNORE_ENTRIES.has(line.trim()))) return
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(gitignore, `${separator}${STAGING_DIR_NAME}/\n`)
}

// ---------------------------------------------------------------- new

/** @param {string} root */
function commandNew(root) {
  const runId = generateRunId()
  const staging = stagingPath(root, runId)
  fs.mkdirSync(staging, { recursive: true })
  ensureGitignored(root)
  process.stdout.write(`runId=${runId}\nstaging=${staging}\n`)
}

// ---------------------------------------------------------------- publish: validation

/** @param {string} pattern @param {string} name */
function matchesPattern(pattern, name) {
  return pattern.startsWith('*.') ? extensionOf(name) === pattern.slice(2).toLowerCase() : name === pattern
}

/**
 * @param {string} staging
 * @param {string} surface
 * @param {StagedFile[]} files
 * @param {string[]} problems
 */
function collectSurfaceFiles(staging, surface, files, problems) {
  const surfaceDir = path.join(staging, surface)
  const entries = fs.readdirSync(surfaceDir, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))
  for (const entry of entries) {
    const key = `${surface}/${entry.name}`
    const absPath = path.join(surfaceDir, entry.name)
    if (entry.isSymbolicLink()) {
      problems.push(`${key}: symlinks are not allowed`)
    } else if (entry.isDirectory()) {
      problems.push(`${key}/: nested directories are not allowed (files must sit directly in <surface>/)`)
    } else if (!entry.isFile()) {
      problems.push(`${key}: not a regular file`)
    } else {
      const bytes = fs.lstatSync(absPath).size
      const fileProblems = []
      if (!FILE_NAME_PATTERN.test(entry.name)) fileProblems.push(`${key}: file name must match ${FILE_NAME_PATTERN}`)
      if (bytes > MAX_FILE_BYTES) fileProblems.push(`${key}: ${bytes} bytes exceeds the 25 MiB limit`)
      if (fileProblems.length > 0) problems.push(...fileProblems)
      else files.push({ surface, name: entry.name, key, absPath, bytes })
    }
  }
}

/**
 * @param {string} staging
 * @param {Config} config
 */
function scanStaging(staging, config) {
  /** @type {StagedFile[]} */
  const files = []
  /** @type {string[]} */
  const surfaces = []
  /** @type {string[]} */
  const problems = []
  const entries = fs.readdirSync(staging, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))
  for (const entry of entries) {
    if (RESERVED_FILES.has(entry.name) && entry.isFile()) continue
    if (!entry.isDirectory()) {
      problems.push(`${entry.name}: top-level entries must be surface directories (no files or symlinks)`)
    } else if (!Object.hasOwn(config.required, entry.name)) {
      const configured = Object.keys(config.required).join(', ')
      problems.push(`${entry.name}/: unknown surface (configured: ${configured})`)
    } else {
      surfaces.push(entry.name)
      collectSurfaceFiles(staging, entry.name, files, problems)
    }
  }
  if (surfaces.length === 0) problems.push('no surface directories found in the staging directory')
  return { files, surfaces, problems }
}

/**
 * Waive specs are never echoed back verbatim: the reason is free text and may
 * hold a credential, so problems are labelled by surface:pattern only.
 * @param {string[]} specs
 * @param {Config} config
 * @param {string[]} presentSurfaces surfaces that exist in this run's staging
 */
function parseWaivers(specs, config, presentSurfaces) {
  /** @type {Waiver[]} */
  const waivers = []
  /** @type {string[]} */
  const problems = []
  specs.forEach((spec, index) => {
    const match = WAIVE_PATTERN.exec(spec)
    if (!match) {
      problems.push(`--waive #${index + 1}: expected "<surface>:<pattern>=<reason>"`)
      return
    }
    const [, surface, pattern, rawReason] = match
    const reason = rawReason.trim()
    const label = `--waive ${surface}:${pattern}`
    problems.push(...credentialHitProblems(reason, label))
    if (!Object.hasOwn(config.required, surface)) {
      problems.push(`${label}: surface "${surface}" is not in the config`)
    } else if (!config.required[surface].includes(pattern)) {
      problems.push(`${label}: pattern "${pattern}" is not required for surface "${surface}"`)
    } else if (!presentSurfaces.includes(surface)) {
      problems.push(`${label}: surface "${surface}" is not present in this run's staging`)
    } else if (reason === '') {
      problems.push(`${label}: a non-empty reason is required`)
    } else {
      waivers.push({ surface, pattern, reason })
    }
  })
  return { waivers, problems }
}

/**
 * @param {StagedFile[]} files
 * @param {string[]} surfaces
 * @param {Config} config
 * @param {Waiver[]} waivers
 */
function missingRequiredProblems(files, surfaces, config, waivers) {
  // Surfaces are opt-in per run: a change may touch only some of them, so only
  // surfaces present in staging are checked against `required`.
  const waived = new Set(waivers.map((waiver) => `${waiver.surface}:${waiver.pattern}`))
  const problems = []
  for (const surface of surfaces) {
    for (const pattern of config.required[surface]) {
      const satisfied = files.some((file) => file.surface === surface && matchesPattern(pattern, file.name))
      if (!satisfied && !waived.has(`${surface}:${pattern}`)) {
        problems.push(`${surface}: no file matches required pattern "${pattern}" (add one, or pass --waive "${surface}:${pattern}=<reason>")`)
      }
    }
  }
  return problems
}

/** @param {string} text */
function credentialPatternNames(text) {
  return CREDENTIAL_PATTERNS.filter(({ regex }) => regex.test(text)).map(({ name }) => name)
}

/**
 * Free-text inputs (summary, waiver reasons): one problem per pattern hit, never the value.
 * @param {string} text
 * @param {string} label
 */
function credentialHitProblems(text, label) {
  const names = new Set(text.split(/\r?\n/).flatMap(credentialPatternNames))
  return [...names].map((name) => `${label}: possible credential (${name})`)
}

/** @param {string} filePath */
function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(SIGNATURE_READ_BYTES)
    return head.subarray(0, fs.readSync(fd, head, 0, SIGNATURE_READ_BYTES, 0))
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * An image extension alone proves nothing (a text file can be named x.png), so
 * only files whose leading bytes are a real image signature skip the scan.
 * @param {StagedFile} file
 */
function isRealImage(file) {
  if (!IMAGE_EXTENSIONS.has(extensionOf(file.name))) return false
  const head = readHead(file.absPath)
  const isWebp = head.length === SIGNATURE_READ_BYTES && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
  return isWebp || IMAGE_SIGNATURES.some((signature) => head.subarray(0, signature.length).equals(signature))
}

/**
 * Every file except genuine images is scanned; the extension of a
 * secret-bearing file (.pem, .conf, no extension at all) cannot be trusted to
 * mark it as text.
 * @param {StagedFile[]} files
 */
function credentialProblems(files) {
  const problems = []
  for (const file of files.filter((candidate) => !isRealImage(candidate))) {
    const content = fs.readFileSync(file.absPath)
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      problems.push(`${file.key}: binary file cannot be credential-scanned; save text evidence as text, screenshots as images`)
      continue
    }
    content.toString('utf8').split(/\r?\n/).forEach((line, index) => {
      for (const name of credentialPatternNames(line)) problems.push(`${file.key}:${index + 1}: possible credential (${name})`)
    })
  }
  return problems
}

/**
 * Runs every publish validation; throws one rejection listing all problems.
 * @param {string} root
 * @param {Config} config
 * @param {PublishOptions} options
 */
function validatePublish(root, config, options) {
  const { runId, summary, waiveSpecs } = options
  const problems = []
  const runIdValid = RUN_ID_PATTERN.test(runId)
  if (!runIdValid) problems.push(`invalid runId ${JSON.stringify(runId)}: must match ${RUN_ID_PATTERN}`)
  if (summary === undefined || summary.trim() === '') problems.push('--summary is required and must not be empty')
  else problems.push(...credentialHitProblems(summary, '--summary'))
  const staging = runIdValid ? stagingPath(root, runId) : null
  if (staging && !isDirectory(staging)) problems.push(`staging directory does not exist: ${staging} (run "new" first)`)
  if (!staging || !isDirectory(staging)) throw rejection(problems)

  const scan = scanStaging(staging, config)
  const { waivers, problems: waiveProblems } = parseWaivers(waiveSpecs, config, scan.surfaces)
  problems.push(
    ...scan.problems,
    ...waiveProblems,
    ...missingRequiredProblems(scan.files, scan.surfaces, config, waivers),
    ...credentialProblems(scan.files),
  )
  if (problems.length > 0) throw rejection(problems)
  return { staging, files: scan.files, waivers, surfaces: scan.surfaces }
}

// ---------------------------------------------------------------- publish: manifest, upload

/** @param {string} filePath */
const sha256OfFile = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

/**
 * @param {string} staging
 * @param {Manifest} manifest
 * @returns {string} sha256 of the written manifest
 */
function writeManifest(staging, manifest) {
  const manifestPath = path.join(staging, MANIFEST_NAME)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return sha256OfFile(manifestPath)
}

/** @param {string[]} argv */
function runUploadCommand(argv) {
  // No shell is involved: argv is passed straight to the executable, so
  // substituted values (paths, runId, keys) can never be interpreted as shell
  // syntax and injection is impossible.
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: UPLOAD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const command = argv.join(' ')
  if (result.error?.code === 'ETIMEDOUT') {
    throw new CliError(`upload command timed out after ${UPLOAD_TIMEOUT_MS / 60000} minutes: ${command}`, 1)
  }
  if (result.error) throw new CliError(`upload command could not be run: ${command}\n${result.error.message}`, 1)
  if (result.status !== 0) {
    const outcome = result.status === null ? `killed by ${result.signal}` : `exit code ${result.status}`
    const tail = (result.stderr ?? '').trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n')
    throw new CliError(`upload command failed (${outcome}): ${command}\nstderr tail:\n${tail}`, 1)
  }
}

/**
 * @param {UploadConfig} upload
 * @param {string} runId
 * @param {string} staging
 * @param {{ key: string, absPath: string }[]} uploadables files for per=file mode, manifest last
 */
function uploadEvidence(upload, runId, staging, uploadables) {
  if (upload.per === 'run') {
    runUploadCommand(upload.argv.map((element) => fillTemplate(element, { dir: staging, runId })))
    return
  }
  for (const { key, absPath } of uploadables) {
    runUploadCommand(upload.argv.map((element) => fillTemplate(element, { file: absPath, key, runId })))
  }
}

// ---------------------------------------------------------------- publish: pr-evidence.md

/** @param {string} key */
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/')

/** @param {string} text */
const longestBacktickRun = (text) => Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))

/** @param {StagedFile} file */
function renderTextPreview(file) {
  const lines = fs.readFileSync(file.absPath, 'utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const keptLines = lines.slice(0, TEXT_PREVIEW_LINES).join('\n')
  const preview = keptLines.slice(0, TEXT_PREVIEW_CHARS)
  const truncated = lines.length > TEXT_PREVIEW_LINES || preview.length < keptLines.length
  const body = truncated ? `${preview}\n… (truncated)` : preview
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
  return [`**${file.key}**`, fence, ...(body === '' ? [] : [body]), fence].join('\n')
}

/**
 * @param {StagedFile} file
 * @param {string} runId
 * @param {string | null} urlTemplate null renders local-only entries
 */
function renderFileEntry(file, runId, urlTemplate) {
  if (urlTemplate) {
    const url = fillTemplate(urlTemplate, { runId, key: encodeKey(file.key) })
    return IMAGE_EXTENSIONS.has(extensionOf(file.name)) ? `![${file.key}](${url})` : `- [${file.key}](${url})`
  }
  if (TEXT_EXTENSIONS.has(extensionOf(file.name))) return renderTextPreview(file)
  return `- ${file.key} (local only)`
}

/**
 * @param {{ runId: string, summary: string, files: StagedFile[], waivers: Waiver[], surfacesNotExercised: string[], manifestSha256: string, urlTemplate: string | null }} input
 */
function renderEvidence({ runId, summary, files, waivers, surfacesNotExercised, manifestSha256, urlTemplate }) {
  const blocks = [`## User-exercise evidence\n**Summary:** ${summary}\n**Run:** \`${runId}\``]
  const surfaces = [...new Set(files.map((file) => file.surface))].sort(compareStrings)
  for (const surface of surfaces) {
    blocks.push(`### ${surface}`)
    for (const file of files.filter((candidate) => candidate.surface === surface)) {
      blocks.push(renderFileEntry(file, runId, urlTemplate))
    }
  }
  if (surfacesNotExercised.length > 0) blocks.push(`**Not exercised:** ${surfacesNotExercised.join(', ')}`)
  if (waivers.length > 0) {
    blocks.push(['**Waived:**', ...waivers.map((w) => `- \`${w.surface}:${w.pattern}\`: ${w.reason}`)].join('\n'))
  }
  blocks.push(`<!-- manifest sha256: ${manifestSha256} -->`)
  return `${blocks.join('\n\n')}\n`
}

// ---------------------------------------------------------------- publish: orchestration

/** @param {string[]} args @returns {PublishOptions} */
function parsePublishArgs(args) {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        summary: { type: 'string' },
        waive: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
      },
    })
  } catch (err) {
    throw usageError(err.message)
  }
  if (parsed.positionals.length !== 1) throw usageError('publish takes exactly one <runId>')
  return {
    runId: parsed.positionals[0],
    summary: parsed.values.summary,
    waiveSpecs: parsed.values.waive ?? [],
    dryRun: parsed.values['dry-run'] === true,
  }
}

/**
 * @param {string} root
 * @param {PublishOptions} options
 */
function commandPublish(root, options) {
  const { runId } = options
  // Evidence from an earlier publish of this run must not survive a failed
  // re-publish (`links` would serve it) nor ride along in a per=run upload of
  // the whole staging directory, so it goes before anything can fail.
  if (RUN_ID_PATTERN.test(runId)) fs.rmSync(path.join(stagingPath(root, runId), EVIDENCE_NAME), { force: true })

  const config = loadConfig(root)
  const { staging, files, waivers, surfaces } = validatePublish(root, config, options)
  const surfacesNotExercised = Object.keys(config.required).filter((surface) => !surfaces.includes(surface)).sort(compareStrings)
  const summary = options.summary.trim()
  const uploading = config.backend === 'command' && !options.dryRun

  const manifestFiles = files.map(({ key, bytes, absPath }) => ({ key, bytes, sha256: sha256OfFile(absPath) }))
  const manifestSha256 = writeManifest(staging, {
    runId,
    summary,
    createdAt: new Date().toISOString(),
    backend: config.backend,
    files: manifestFiles,
    waivers,
    surfacesNotExercised,
  })

  if (uploading) {
    const manifestEntry = { key: MANIFEST_NAME, absPath: path.join(staging, MANIFEST_NAME) }
    uploadEvidence(config.upload, runId, staging, [...files, manifestEntry])
  }

  const evidence = renderEvidence({
    runId,
    summary,
    files,
    waivers,
    surfacesNotExercised,
    manifestSha256,
    urlTemplate: uploading ? config.upload.urlTemplate : null,
  })
  fs.writeFileSync(path.join(staging, EVIDENCE_NAME), evidence)
  process.stdout.write(evidence)
}

// ---------------------------------------------------------------- links, dispatch

/**
 * @param {string} root
 * @param {string} runId
 */
function commandLinks(root, runId) {
  assertValidRunId(runId)
  const evidencePath = path.join(stagingPath(root, runId), EVIDENCE_NAME)
  if (!fs.existsSync(evidencePath)) {
    throw new CliError(`no ${EVIDENCE_NAME} for run ${runId}; run "publish" first`, 1)
  }
  process.stdout.write(fs.readFileSync(evidencePath, 'utf8'))
}

/** @param {string[]} argv */
function dispatch(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'new':
      if (args.length > 0) throw usageError('"new" takes no arguments')
      return commandNew(resolveRoot())
    case 'publish': {
      const options = parsePublishArgs(args)
      return commandPublish(resolveRoot(), options)
    }
    case 'links':
      if (args.length !== 1) throw usageError('"links" takes exactly one <runId>')
      return commandLinks(resolveRoot(), args[0])
    default:
      throw usageError(command ? `unknown command "${command}"` : 'missing command')
  }
}

/** @param {string[]} argv @returns {number} exit code */
function main(argv) {
  try {
    dispatch(argv)
    return 0
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${err.format()}\n`)
      return err.exitCode
    }
    process.stderr.write(`verify-artifacts: unexpected error: ${err.stack ?? err}\n`)
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))

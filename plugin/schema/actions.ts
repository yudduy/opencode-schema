import { constants } from "node:fs"
import { open, readFile } from "node:fs/promises"
import path from "node:path"
import {
  ensureSessionDirectory,
  ledgerFile,
  type ReviewTrigger,
} from "./state.ts"

export type ActionOutcome = "ok" | "error"

export type ActionRow = {
  ts: number
  step: number
  ref: number
  tool: string
  digest: string
  outcome: ActionOutcome
  risky?: string
}

export type ReviewRow = {
  ts: number
  step: number
  trigger: ReviewTrigger
  key: string
  verdict: "ok" | "redirect"
  message: string
  model?: string
}

type ActionRowInput = Omit<ActionRow, "step">
type ReviewRowInput = Omit<ReviewRow, "step">

const readOnlyActionTools = [
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "lsp",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
  "repo_overview",
]

class ExcludedActionToolSet extends Set<string> {
  override has(tool: string): boolean {
    return tool.startsWith("schema_") || super.has(tool)
  }
}

const SECRET_PATTERN =
  /(token|key|secret|password|authorization)(\s*[=:]\s*)\S+/gi
const AUTHORIZATION_BEARER_PATTERN =
  /(authorization\s*[=:]\s*)bearer\s+\S+/gi
const STRUCTURED_SECRET_KEY_PATTERN =
  /(token|key|secret|password|authorization)/i

export const EXCLUDED_ACTION_TOOLS = new ExcludedActionToolSet(readOnlyActionTools)

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function record(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function commandFrom(args: unknown): string {
  if (typeof args === "string") return args
  const values = record(args)
  return stringValue(values.command) || stringValue(values.cmd)
}

function filePathFrom(args: unknown): string {
  const values = record(args)
  return (
    stringValue(values.filePath) ||
    stringValue(values.file_path) ||
    stringValue(values.path) ||
    "<unknown>"
  )
}

function contentBytes(args: unknown): number {
  const values = record(args)
  const content =
    stringValue(values.content) ||
    stringValue(values.contents) ||
    stringValue(values.text) ||
    stringValue(values.patch) ||
    stringValue(values.patchText) ||
    stringValue(values.newString) ||
    stringValue(values.new_string)
  return Buffer.byteLength(content)
}

function fileMutationDigest(args: unknown): string {
  const suffix = ` (${contentBytes(args)} bytes)`
  return `${filePathFrom(args).slice(0, 200 - suffix.length)}${suffix}`
}

function scrubSecrets(value: string): string {
  return value
    .replace(AUTHORIZATION_BEARER_PATTERN, "$1…")
    .replace(SECRET_PATTERN, "$1$2…")
}

function jsonDigest(args: unknown): string {
  try {
    return (
      JSON.stringify(args, (key, value) =>
        key && STRUCTURED_SECRET_KEY_PATTERN.test(key) ? "…" : value,
      ) ?? String(args)
    ).slice(0, 160)
  } catch {
    return String(args).slice(0, 160)
  }
}

export function actionsFile(worktree: string, sessionID: string): string {
  return path.join(path.dirname(ledgerFile(worktree, sessionID)), "actions.jsonl")
}

export function reviewsFile(worktree: string, sessionID: string): string {
  return path.join(path.dirname(ledgerFile(worktree, sessionID)), "reviews.jsonl")
}

export function digestArgs(tool: string, args: unknown): string {
  const normalizedTool = tool.toLowerCase()
  let digest: string

  if (normalizedTool === "bash" || normalizedTool === "shell") {
    digest = commandFrom(args).slice(0, 160)
  } else if (
    normalizedTool === "edit" ||
    normalizedTool === "write" ||
    normalizedTool === "patch" ||
    normalizedTool === "apply_patch"
  ) {
    digest = fileMutationDigest(args)
  } else if (normalizedTool === "task" || normalizedTool === "spawn_agent") {
    const values = record(args)
    const agent =
      stringValue(values.agent) ||
      stringValue(values.subagent_type) ||
      stringValue(values.agentType) ||
      "<unknown>"
    const description =
      stringValue(values.description) ||
      stringValue(values.prompt) ||
      stringValue(values.task)
    digest = `${agent}: ${description.slice(0, 160)}`
  } else {
    digest = jsonDigest(args)
  }

  return scrubSecrets(digest).slice(0, 200)
}

export function classifyRisky(tool: string, args: unknown): string | null {
  const normalizedTool = tool.toLowerCase()
  const isShell = normalizedTool === "bash" || normalizedTool === "shell"

  if (isShell) {
    const command = commandFrom(args)
    const shellSegment = String.raw`[^;&|\n]*`
    const recursiveFlag = String.raw`\s-(?:-[a-z-]*recursive|[a-z]*r[a-z]*)`
    const forceFlag = String.raw`\s-(?:-[a-z-]*force|[a-z]*f[a-z]*)`
    const recursiveForce = new RegExp(
      String.raw`\brm\b(?=${shellSegment}${recursiveFlag})(?=${shellSegment}${forceFlag})`,
      "i",
    )

    if (recursiveForce.test(command)) return "rm-recursive-force"
    if (/\bgit\s+reset\b[^;&|\n]*--hard\b/i.test(command)) return "git-reset-hard"
    if (/\bgit\s+clean\b[^;&|\n]*\s-(?:-[a-z-]*force|[a-z]*f[a-z]*)/i.test(command)) {
      return "git-clean-force"
    }
    if (
      /\bgit\s+push\b[^;&|\n]*(?:--force(?:-with-lease)?\b|\s-f(?=$|[\s;&|<>()]))/i.test(
        command,
      )
    ) {
      return "git-push-force"
    }
    if (/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?=$|[\s;&|<>()])/i.test(command)) {
      return "git-discard-worktree"
    }
    if (/\bdd\b|\bmkfs\b|\bchmod\s+-R\b|\bchown\s+-R\b|:\(\)\s*\{/i.test(command)) {
      return "destructive-fs"
    }
    if (/\bsudo\b/i.test(command)) return "privilege-escalation"
    if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash)\b/i.test(command)) return "remote-exec"
  }

  if (
    (normalizedTool === "edit" ||
      normalizedTool === "write" ||
      normalizedTool === "patch") &&
    /(test|spec|bench|scor)/i.test(filePathFrom(args))
  ) {
    return "grader-edit"
  }

  return null
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  let contents: string
  try {
    contents = await readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }

  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

async function appendJsonLine<T extends { step: number }>(
  worktree: string,
  sessionID: string,
  filename: string,
  input: Omit<T, "step">,
  existing: T[],
): Promise<T> {
  const directory = await ensureSessionDirectory(worktree, sessionID)
  const row = { ...input, step: existing.length + 1 } as T
  const file = await open(
    path.join(directory, filename),
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(`${JSON.stringify(row)}\n`, "utf8")
  } finally {
    await file.close()
  }
  return row
}

export async function readActions(worktree: string, sessionID: string): Promise<ActionRow[]> {
  return readJsonLines(actionsFile(worktree, sessionID))
}

export async function readActionTail(
  worktree: string,
  sessionID: string,
  count: number,
): Promise<ActionRow[]> {
  if (count <= 0) return []
  return (await readActions(worktree, sessionID)).slice(-count)
}

export async function appendAction(
  worktree: string,
  sessionID: string,
  input: ActionRowInput,
): Promise<ActionRow> {
  return appendJsonLine(
    worktree,
    sessionID,
    "actions.jsonl",
    input,
    await readActions(worktree, sessionID),
  )
}

export async function readReviews(worktree: string, sessionID: string): Promise<ReviewRow[]> {
  return readJsonLines(reviewsFile(worktree, sessionID))
}

export async function appendReview(
  worktree: string,
  sessionID: string,
  input: ReviewRowInput,
): Promise<ReviewRow> {
  return appendJsonLine(
    worktree,
    sessionID,
    "reviews.jsonl",
    input,
    await readReviews(worktree, sessionID),
  )
}

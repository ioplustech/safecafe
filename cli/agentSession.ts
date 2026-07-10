import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Address } from "viem"

export type AgentSessionRecord = {
  id: string
  account: Address | null
  subjectKind: "safe" | "self" | null
  pendingInput: string
  latestInstruction: string
  history: string[]
  updatedAt: string
}

const maxHistoryEntries = 24

export function loadAgentSession(sessionId: string, env: Record<string, string | undefined>): AgentSessionRecord {
  const path = sessionFilePath(sessionId, env)
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentSessionRecord>
    return {
      account: isAddressOrNull(raw.account) ? raw.account : null,
      history: Array.isArray(raw.history) ? raw.history.filter((item): item is string => typeof item === "string") : [],
      id: sessionId,
      latestInstruction: typeof raw.latestInstruction === "string" ? raw.latestInstruction : "",
      pendingInput: typeof raw.pendingInput === "string" ? raw.pendingInput : "",
      subjectKind: raw.subjectKind === "safe" || raw.subjectKind === "self" ? raw.subjectKind : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    }
  } catch {
    return emptyAgentSession(sessionId)
  }
}

export function saveAgentSession(session: AgentSessionRecord, env: Record<string, string | undefined>) {
  const path = sessionFilePath(session.id, env)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...session,
        history: session.history.slice(-maxHistoryEntries),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
}

export function clearAgentSession(sessionId: string, env: Record<string, string | undefined>) {
  rmSync(sessionFilePath(sessionId, env), { force: true })
}

export function emptyAgentSession(sessionId: string): AgentSessionRecord {
  return {
    account: null,
    history: [],
    id: sessionId,
    latestInstruction: "",
    pendingInput: "",
    subjectKind: null,
    updatedAt: new Date(0).toISOString(),
  }
}

function sessionFilePath(sessionId: string, env: Record<string, string | undefined>) {
  const root = env.SAFECAFE_CLI_SESSION_DIR || join(homedir(), ".safecafe", "cli-agent-sessions")
  return join(root, `${sanitizeSessionId(sessionId)}.json`)
}

function sanitizeSessionId(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default"
}

function isAddressOrNull(value: unknown): value is Address | null {
  return value === null || typeof value === "string"
}

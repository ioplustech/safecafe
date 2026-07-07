import type { TxPlan } from "../protocol"
import type { AgentPlan } from "./types"

export type StoredAgentChatMessage = {
  id: string
  role: "assistant" | "tool" | "user"
  content: string
  isLoading?: boolean
  thinking?: string
  thinkingPinned?: boolean
  thinkingOpen?: boolean
  contentExpanded?: boolean
}

export type StoredAgentSession = {
  draft: AgentPlan | null
  draftKey: string
  executablePlan: TxPlan | null
  id: string
  title: string
  messages: StoredAgentChatMessage[]
  pendingIntentText: string
  warningsAccepted: boolean
}

const maxStoredSessions = 5
const maxStoredMessages = 80
const maxStoredTextLength = 6000

export function serializeAgentSessions(sessions: StoredAgentSession[]): StoredAgentSession[] {
  return sessions.slice(0, maxStoredSessions).map((session) => ({
    draft: null,
    draftKey: "",
    executablePlan: null,
    id: cleanText(session.id, 120) || createFallbackId(),
    title: cleanText(session.title, 80) || "New session",
    messages: session.messages.slice(-maxStoredMessages).map(sanitizeMessage),
    pendingIntentText: "",
    warningsAccepted: false,
  }))
}

export function readStoredAgentSessions(raw: string | null, fallbackTitle: string): StoredAgentSession[] {
  try {
    const parsed = JSON.parse(raw ?? "null") as unknown
    if (!Array.isArray(parsed)) return [createStoredSession(fallbackTitle)]
    const sessions = parsed.map(readStoredSession).filter((session): session is StoredAgentSession => Boolean(session))
    return sessions.length ? sessions.slice(0, maxStoredSessions) : [createStoredSession(fallbackTitle)]
  } catch {
    return [createStoredSession(fallbackTitle)]
  }
}

export function createStoredSession(title: string): StoredAgentSession {
  return {
    draft: null,
    draftKey: "",
    executablePlan: null,
    id: createFallbackId(),
    messages: [],
    pendingIntentText: "",
    title,
    warningsAccepted: false,
  }
}

function readStoredSession(input: unknown): StoredAgentSession | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const id = cleanText(record.id, 120)
  if (!id) return null
  return {
    draft: null,
    draftKey: "",
    executablePlan: null,
    id,
    messages: Array.isArray(record.messages)
      ? record.messages.map(readStoredMessage).filter((message): message is StoredAgentChatMessage => Boolean(message))
      : [],
    pendingIntentText: "",
    title: cleanText(record.title, 80) || "New session",
    warningsAccepted: false,
  }
}

function readStoredMessage(input: unknown): StoredAgentChatMessage | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const role = record.role
  if (role !== "assistant" && role !== "tool" && role !== "user") return null
  const id = cleanText(record.id, 120)
  if (!id) return null
  return sanitizeMessage({
    content: cleanText(record.content, maxStoredTextLength),
    ...(typeof record.contentExpanded === "boolean" ? { contentExpanded: record.contentExpanded } : {}),
    id,
    isLoading: false,
    role,
    thinking: cleanText(record.thinking, maxStoredTextLength),
    thinkingOpen: record.thinkingOpen === true,
    thinkingPinned: record.thinkingPinned === true,
  })
}

function sanitizeMessage(message: StoredAgentChatMessage): StoredAgentChatMessage {
  return {
    content: cleanText(message.content, maxStoredTextLength),
    ...(typeof message.contentExpanded === "boolean" ? { contentExpanded: message.contentExpanded } : {}),
    id: cleanText(message.id, 120) || createFallbackId(),
    ...(message.thinking ? { thinking: cleanText(message.thinking, maxStoredTextLength) } : {}),
    ...(message.thinkingOpen ? { thinkingOpen: true } : {}),
    ...(message.thinkingPinned ? { thinkingPinned: true } : {}),
    isLoading: false,
    role: message.role,
  }
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, maxLength) : ""
}

function createFallbackId() {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

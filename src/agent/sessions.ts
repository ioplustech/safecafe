import { type Address, getAddress, type Hex, isAddress } from "viem"
import type { TxPlan, TxPlanAction, TxSimulation } from "../protocol"
import type { AgentAmount, AgentIntent, AgentPlan, AgentPlanPhase, AgentRisk, AgentValidatorRef } from "./types"

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
  composerText: string
  draft: AgentPlan | null
  draftKey: string
  executablePlan: TxPlan | null
  id: string
  title: string
  messages: StoredAgentChatMessage[]
  pendingIntentText: string
  warningsAccepted: boolean
}

export type SerializedAgentSession = Omit<StoredAgentSession, "draft" | "executablePlan"> & {
  draft: unknown
  executablePlan: unknown
}

const maxStoredSessions = 5
const maxStoredMessages = 80
const maxStoredTextLength = 6000

export function serializeAgentSessions(sessions: StoredAgentSession[]): SerializedAgentSession[] {
  return sessions.slice(0, maxStoredSessions).map((session) => ({
    composerText: cleanText(session.composerText, maxStoredTextLength),
    draft: serializeAgentPlan(session.draft),
    draftKey: cleanText(session.draftKey, maxStoredTextLength),
    executablePlan: serializeTxPlan(session.executablePlan),
    id: cleanText(session.id, 120) || createFallbackId(),
    title: cleanText(session.title, 80) || "New session",
    messages: session.messages.slice(-maxStoredMessages).map(sanitizeMessage),
    pendingIntentText: cleanText(session.pendingIntentText, maxStoredTextLength),
    warningsAccepted: session.warningsAccepted,
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
    composerText: "",
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
    composerText: cleanText(record.composerText, maxStoredTextLength),
    draft: readAgentPlan(record.draft),
    draftKey: cleanText(record.draftKey, maxStoredTextLength),
    executablePlan: readTxPlan(record.executablePlan),
    id,
    messages: Array.isArray(record.messages)
      ? record.messages.map(readStoredMessage).filter((message): message is StoredAgentChatMessage => Boolean(message))
      : [],
    pendingIntentText: cleanText(record.pendingIntentText, maxStoredTextLength),
    title: cleanText(record.title, 80) || "New session",
    warningsAccepted: record.warningsAccepted === true,
  }
}

function serializeAgentPlan(plan: AgentPlan | null) {
  if (!plan) return null
  return {
    ...plan,
    createdAtBlock: bigintToText(plan.createdAtBlock),
    phases: plan.phases.map(serializeAgentPlanPhase),
  }
}

function serializeAgentPlanPhase(phase: AgentPlanPhase) {
  return {
    ...phase,
    plans: phase.plans.map(serializeTxPlan),
  }
}

function serializeTxPlan(plan: TxPlan | null) {
  if (!plan) return null
  return {
    ...plan,
    txs: plan.txs.map((tx) => ({
      ...tx,
      value: bigintToText(tx.value),
    })),
  }
}

function readAgentPlan(input: unknown): AgentPlan | null {
  const record = readRecord(input)
  if (!record) return null
  const id = cleanText(record.id, 120)
  const instruction = cleanText(record.instruction, maxStoredTextLength)
  const intent = readAgentIntent(record.intent)
  if (!id || !instruction || !intent) return null
  return {
    account: readOptionalAddress(record.account),
    createdAtBlock: readNullableBigint(record.createdAtBlock),
    id,
    instruction,
    intent,
    phases: Array.isArray(record.phases)
      ? record.phases.map(readAgentPlanPhase).filter((phase): phase is AgentPlanPhase => Boolean(phase))
      : [],
    risks: readRisks(record.risks),
    signerAccount: readOptionalAddress(record.signerAccount),
    subjectKind: record.subjectKind === "safe" ? "safe" : "self",
  }
}

function readAgentPlanPhase(input: unknown): AgentPlanPhase | null {
  const record = readRecord(input)
  if (!record) return null
  const id = cleanText(record.id, 120)
  const title = cleanText(record.title, 240)
  if (!id || !title) return null
  return {
    executableNow: record.executableNow === true,
    id,
    plans: Array.isArray(record.plans)
      ? record.plans.map(readTxPlan).filter((plan): plan is TxPlan => Boolean(plan))
      : [],
    risks: readRisks(record.risks),
    title,
  }
}

function readTxPlan(input: unknown): TxPlan | null {
  const record = readRecord(input)
  if (!record) return null
  const action = readTxPlanAction(record.action)
  const title = cleanText(record.title, 240)
  if (!action || !title) return null
  return {
    account: readOptionalAddress(record.account) ?? undefined,
    action,
    simulation: readSimulation(record.simulation),
    title,
    txs: Array.isArray(record.txs)
      ? record.txs.map(readTx).filter((tx): tx is TxPlan["txs"][number] => Boolean(tx))
      : [],
    warnings: readStringList(record.warnings, 1000),
  }
}

function readTx(input: unknown): TxPlan["txs"][number] | null {
  const record = readRecord(input)
  if (!record) return null
  const label = cleanText(record.label, 240)
  const to = readRequiredAddress(record.to)
  const data = readHex(record.data)
  const value = readBigint(record.value)
  if (!label || !to || !data || value === null) return null
  return { data, label, to, value }
}

function readAgentIntent(input: unknown): AgentIntent | null {
  const record = readRecord(input)
  const kind = typeof record?.kind === "string" ? record.kind : ""
  if (kind === "claim-rewards" || kind === "claim-withdrawal") return { kind }
  if (kind === "stake" || kind === "unstake" || kind === "compound-liquid") {
    const amount = readAgentAmount(record?.amount)
    const validator = readAgentValidator(record?.validator)
    return amount && validator ? { amount, kind, validator } : null
  }
  if (kind === "restake-rewards") {
    const amount = readAgentAmount(record?.amount)
    const validator = readAgentValidator(record?.validator)
    return amount && validator ? { amount, kind, validator } : null
  }
  if (kind === "rebalance") {
    const amount = readAgentAmount(record?.amount)
    const from = readAgentValidator(record?.from)
    const to = readAgentValidator(record?.to)
    return amount && from && to ? { amount, from, kind, to } : null
  }
  return null
}

function readAgentAmount(input: unknown): AgentAmount | null {
  const record = readRecord(input)
  const type = typeof record?.type === "string" ? record.type : ""
  if (type === "all-wallet" || type === "all-validator-stake" || type === "all-claimable-rewards") return { type }
  if (type === "safe") {
    const value = cleanText(record?.value, 120)
    return value ? { type, value } : null
  }
  if (type === "percent-wallet" || type === "percent-validator-stake") {
    return typeof record?.value === "number" && Number.isFinite(record.value) ? { type, value: record.value } : null
  }
  return null
}

function readAgentValidator(input: unknown): AgentValidatorRef | null {
  const record = readRecord(input)
  const type = typeof record?.type === "string" ? record.type : ""
  if (type === "best-active") return { type }
  if (type === "label") {
    const value = cleanText(record?.value, 240)
    return value ? { type, value } : null
  }
  if (type === "address") {
    const value = readRequiredAddress(record?.value)
    return value ? { type, value } : null
  }
  return null
}

function readRisks(input: unknown): AgentRisk[] {
  if (!Array.isArray(input)) return []
  return input.map(readRisk).filter((risk): risk is AgentRisk => Boolean(risk))
}

function readRisk(input: unknown): AgentRisk | null {
  const record = readRecord(input)
  if (!record) return null
  const severity = record.severity
  if (severity !== "info" && severity !== "warning" && severity !== "blocked") return null
  const code = cleanText(record.code, 120)
  const message = cleanText(record.message, 1000)
  return code && message ? { code, message, severity } : null
}

function readSimulation(input: unknown): TxSimulation | undefined {
  const record = readRecord(input)
  if (!record) return undefined
  const status = record.status
  if (status !== "passed" && status !== "partial" && status !== "failed") return undefined
  const simulatedTxs =
    typeof record.simulatedTxs === "number" && Number.isSafeInteger(record.simulatedTxs) ? record.simulatedTxs : 0
  return {
    message: cleanText(record.message, 1000),
    simulatedTxs,
    status,
  }
}

function readTxPlanAction(input: unknown): TxPlanAction | null {
  return input === "stake" ||
    input === "unstake" ||
    input === "claim-withdrawal" ||
    input === "claim-rewards" ||
    input === "agent-plan"
    ? input
    : null
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

function readRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null
}

function readStringList(input: unknown, maxLength: number) {
  if (!Array.isArray(input)) return []
  return input.map((item) => cleanText(item, maxLength)).filter(Boolean)
}

function readRequiredAddress(input: unknown): Address | null {
  const value = cleanText(input, 80)
  return isAddress(value) ? (getAddress(value) as Address) : null
}

function readOptionalAddress(input: unknown): Address | null {
  if (input === null || input === undefined || input === "") return null
  return readRequiredAddress(input)
}

function readHex(input: unknown): Hex | null {
  const value = cleanText(input, maxStoredTextLength)
  return /^0x[0-9a-fA-F]*$/.test(value) ? (value as Hex) : null
}

function readBigint(input: unknown): bigint | null {
  if (typeof input === "bigint") return input
  if (typeof input === "number" && Number.isSafeInteger(input)) return BigInt(input)
  if (typeof input === "string" && /^-?\d+$/.test(input)) return BigInt(input)
  return null
}

function readNullableBigint(input: unknown): bigint | null {
  if (input === null || input === undefined || input === "") return null
  return readBigint(input)
}

function bigintToText(value: bigint | null) {
  return typeof value === "bigint" ? value.toString() : null
}

function createFallbackId() {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

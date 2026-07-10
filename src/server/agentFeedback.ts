import { type Address, getAddress, isAddress } from "viem"
import { readRpcSession } from "./authSession"
import { consumeIpRateLimit, ipRateLimitResponse } from "./ipRateLimit"
import { createRequestContext, logServerEvent, type RequestContext, withRequestHeaders } from "./serverDiagnostics"
import type { AgentFeedbackKv, RpcGatewayEnv } from "./serverEnv"

export type AgentFeedbackEnv = RpcGatewayEnv & {
  SAFECAFE_AGENT_FEEDBACK_KV?: AgentFeedbackKv
  SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT?: string
}

export type AgentFeedbackCategory = "bug" | "complaint" | "feature_request" | "other" | "ux"
export type AgentFeedbackSeverity = "high" | "low" | "medium"

export type AgentFeedbackInput = {
  area?: unknown
  category?: unknown
  context?: unknown
  originalText?: unknown
  severity?: unknown
  summary?: unknown
}

export type AgentFeedbackActor = {
  signer?: string | null
  subject?: string | null
  subjectKind?: "safe" | "self" | null
}

const maxBodyBytes = 8_000
const maxOriginalTextChars = 2_000
const maxSummaryChars = 240
const maxAreaChars = 80
const defaultFeedbackDailyLimit = 20
const feedbackLimitBuckets = new Map<string, { count: number; resetAt: number }>()

export async function handleAgentFeedbackRequest(request: Request, env: AgentFeedbackEnv): Promise<Response> {
  const requestContext = createRequestContext(request, "agent.feedback")
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, requestContext)
  const ipLimited = consumeIpRateLimit(request, env, requestContext, {
    bucket: "agent.feedback",
    defaultLimit: 20,
    limitEnvKey: "SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE",
  })
  if (ipLimited) return ipRateLimitResponse(requestContext, ipLimited)
  const parsed = await readFeedbackRequest(request)
  if (parsed.status !== "ok") {
    logServerEvent(requestContext, "warn", "agent.feedback.invalid", { reason: parsed.error, status: parsed.status })
    return json({ error: parsed.error }, parsed.status, requestContext)
  }
  const actor = await readOptionalFeedbackActor(request, env, parsed.value.context)
  const limited = enforceFeedbackDailyLimit(request, actor, env, requestContext)
  if (limited) return limited
  const result = await collectAgentFeedback(parsed.value, env, requestContext, actor)
  return json(result, result.recorded ? 200 : 202, requestContext)
}

export async function collectAgentFeedback(
  input: AgentFeedbackInput,
  env: AgentFeedbackEnv,
  requestContext: RequestContext,
  actor: AgentFeedbackActor = {},
) {
  const feedback = sanitizeFeedbackInput(input)
  if (!feedback.originalText && !feedback.summary) {
    return { recorded: false, error: "Feedback text is required.", storage: "none" as const }
  }
  const record = {
    ...feedback,
    createdAt: new Date().toISOString(),
    requestId: requestContext.requestId,
    route: requestContext.route,
    signer: actor.signer ?? null,
    subject: actor.subject ?? null,
    subjectKind: actor.subjectKind ?? null,
  }
  if (env.SAFECAFE_AGENT_FEEDBACK_KV) {
    const key = `feedback:${record.createdAt.slice(0, 10)}:${crypto.randomUUID()}`
    try {
      await env.SAFECAFE_AGENT_FEEDBACK_KV.put(key, JSON.stringify(record))
      logServerEvent(requestContext, "info", "agent.feedback.recorded", {
        area: record.area,
        category: record.category,
        severity: record.severity,
        storage: "kv",
        subjectKind: record.subjectKind,
      })
      return { recorded: true, key, storage: "kv" as const }
    } catch (error) {
      logServerEvent(requestContext, "warn", "agent.feedback.kv_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  logServerEvent(requestContext, "info", "agent.feedback.recorded", {
    area: record.area,
    category: record.category,
    originalText: record.originalText,
    severity: record.severity,
    storage: "log",
    subjectKind: record.subjectKind,
    summary: record.summary,
  })
  return { recorded: true, storage: "log" as const }
}

function sanitizeFeedbackInput(input: AgentFeedbackInput) {
  return {
    area: cleanText(input.area, maxAreaChars) || "agent",
    category: readFeedbackCategory(input.category),
    originalText: redactSensitiveText(cleanText(input.originalText, maxOriginalTextChars)),
    severity: readFeedbackSeverity(input.severity),
    summary: redactSensitiveText(cleanText(input.summary, maxSummaryChars)),
  }
}

async function readFeedbackRequest(
  request: Request,
): Promise<{ status: "ok"; value: AgentFeedbackInput } | { status: number; error: string }> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > maxBodyBytes) return { status: 413, error: "Feedback request is too large." }
  const raw = await request.text()
  if (raw.length > maxBodyBytes) return { status: 413, error: "Feedback request is too large." }
  try {
    const value = raw ? JSON.parse(raw) : {}
    return typeof value === "object" && value !== null
      ? { status: "ok", value: value as AgentFeedbackInput }
      : { status: 400, error: "Invalid feedback body." }
  } catch {
    return { status: 400, error: "Invalid JSON body." }
  }
}

async function readOptionalFeedbackActor(
  request: Request,
  env: RpcGatewayEnv,
  context: unknown,
): Promise<AgentFeedbackActor> {
  try {
    const session = await readRpcSession(request, env)
    if (session) return { signer: session.signer, subject: session.subject, subjectKind: session.subjectKind }
  } catch {
    // Feedback must remain available even when auth is disabled or not configured.
  }
  const record = readRecord(context)
  const signer = readAddress(record?.account)
  const subject = readAddress(record?.subjectAccount)
  return {
    signer,
    subject,
    subjectKind: record?.subjectKind === "safe" ? "safe" : subject ? "self" : null,
  }
}

function enforceFeedbackDailyLimit(
  request: Request,
  actor: AgentFeedbackActor,
  env: AgentFeedbackEnv,
  context: RequestContext,
) {
  const limit = readBoundedInteger(env.SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT, defaultFeedbackDailyLimit, 0, 10_000)
  if (limit <= 0) return null
  const key = actor.signer?.toLowerCase() ?? readClientKey(request)
  const now = Date.now()
  for (const [bucketKey, bucket] of feedbackLimitBuckets) {
    if (bucket.resetAt <= now) feedbackLimitBuckets.delete(bucketKey)
  }
  const resetAt = nextUtcDayStartMs(now)
  const bucketKey = `feedback:${utcDateKey(now)}:${key}`
  const bucket = feedbackLimitBuckets.get(bucketKey)
  if (!bucket || bucket.resetAt <= now) {
    feedbackLimitBuckets.set(bucketKey, { count: 1, resetAt })
    return null
  }
  if (bucket.count >= limit) {
    logServerEvent(context, "warn", "agent.feedback.rate_limited", { limit, resetAt: new Date(resetAt).toISOString() })
    return json(
      {
        code: "agent_feedback_daily_limit_exceeded",
        error: "Daily feedback limit reached. Please try again later.",
        resetAt: new Date(resetAt).toISOString(),
      },
      429,
      context,
      { "retry-after": String(Math.max(1, Math.ceil((resetAt - now) / 1000))) },
    )
  }
  bucket.count += 1
  return null
}

function readFeedbackCategory(value: unknown): AgentFeedbackCategory {
  return value === "bug" || value === "complaint" || value === "feature_request" || value === "other" || value === "ux"
    ? value
    : "other"
}

function readFeedbackSeverity(value: unknown): AgentFeedbackSeverity {
  return value === "high" || value === "low" || value === "medium" ? value : "medium"
}

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function redactSensitiveText(value: string) {
  if (!value) return ""
  return value
    .replace(/\b(seed phrase|mnemonic|private key|私钥|助记词)\s*[:：]\s*\S+/gi, "$1: [redacted]")
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[redacted-private-key]")
}

function readAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function readClientKey(request: Request) {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "anonymous"
  return ip.slice(0, 120)
}

function readBoundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function utcDateKey(now: number) {
  return new Date(now).toISOString().slice(0, 10)
}

function nextUtcDayStartMs(now: number) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

function json(body: unknown, status: number, context: RequestContext, headers: Record<string, string> = {}) {
  return withRequestHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
    }),
    context,
  )
}

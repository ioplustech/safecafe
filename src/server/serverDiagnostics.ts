export type LogLevel = "info" | "warn" | "error"

export type RequestContext = {
  method: string
  requestId: string
  route: string
  startedAt: number
}

type LogDetails = Record<string, unknown>

export function createRequestContext(request: Request, route: string): RequestContext {
  return {
    method: request.method,
    requestId: readRequestId(request),
    route,
    startedAt: Date.now(),
  }
}

export function elapsedMs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt)
}

export function withRequestHeaders(response: Response, context: RequestContext, errorCode?: string) {
  const headers = new Headers(response.headers)
  headers.set("x-request-id", context.requestId)
  if (errorCode) headers.set("x-safecafe-error-code", errorCode)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export function logServerEvent(context: RequestContext, level: LogLevel, event: string, details: LogDetails = {}) {
  const payload = {
    elapsedMs: elapsedMs(context.startedAt),
    event,
    httpMethod: context.method,
    level,
    requestId: context.requestId,
    route: context.route,
    ...sanitizeLogDetails(details),
  }
  const line = JSON.stringify(payload)
  if (level === "error") {
    console.error(line)
  } else if (level === "warn") {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export function redactUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return "invalid-url"
  }
}

export function truncateMessage(value: unknown, maxLength = 180) {
  if (typeof value !== "string") return undefined
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function readRequestId(request: Request) {
  const explicit = cleanRequestId(request.headers.get("x-request-id"))
  if (explicit) return explicit
  const cfRay = cleanRequestId(request.headers.get("cf-ray"))
  if (cfRay) return cfRay
  return crypto.randomUUID()
}

function cleanRequestId(value: string | null) {
  if (!value) return null
  const trimmed = value.trim().slice(0, 128)
  return /^[a-zA-Z0-9._:-]+$/.test(trimmed) ? trimmed : null
}

function sanitizeLogDetails(details: LogDetails): LogDetails {
  const sanitized: LogDetails = {}
  for (const [key, value] of Object.entries(details)) {
    if (isSensitiveKey(key)) continue
    sanitized[key] = typeof value === "string" ? truncateMessage(value, 500) : value
  }
  return sanitized
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase()
  return (
    normalized.includes("authorization") ||
    normalized.includes("secret") ||
    normalized.includes("signature") ||
    normalized.includes("token")
  )
}

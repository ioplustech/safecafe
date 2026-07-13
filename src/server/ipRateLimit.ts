import { createFixedWindowRateLimiter } from "@safecafe/rate-limit"

import { logServerEvent, type RequestContext, withRequestHeaders } from "./serverDiagnostics"

export type IpRateLimitEnv = {
  SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_TRUST_PROXY_HEADERS?: string
}

type IpRateLimitOptions = {
  bucket: string
  defaultLimit: number
  limitEnvKey?: keyof IpRateLimitEnv
}

export type IpRateLimitHit = {
  code: "ip_rate_limited"
  limit: number
  remaining: number
  resetAt: number
  retryAfterSeconds: number
  headers: Record<string, string>
}

const ipRateLimitWindowMs = 60_000
const maxConfiguredLimit = 100_000
const maxIpRateLimitEntries = 10_000
const ipRateLimiter = createFixedWindowRateLimiter({
  maxEntries: maxIpRateLimitEntries,
  windowMs: ipRateLimitWindowMs,
})

export function consumeIpRateLimit(
  request: Request,
  env: IpRateLimitEnv,
  context: RequestContext,
  options: IpRateLimitOptions,
): IpRateLimitHit | null {
  const limit = readRouteLimit(env, options)
  if (limit <= 0) return null

  const result = ipRateLimiter.consume({
    bucket: options.bucket,
    key: readClientKey(request, env),
    limit,
  })
  if (result.allowed) return null

  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
  const hit: IpRateLimitHit = {
    code: "ip_rate_limited",
    limit,
    remaining: result.remaining,
    resetAt: result.resetAt,
    retryAfterSeconds,
    headers: {
      "retry-after": String(retryAfterSeconds),
      "x-safecafe-ip-rate-limit": String(limit),
      "x-safecafe-ip-rate-remaining": String(result.remaining),
      "x-safecafe-ip-rate-reset": new Date(result.resetAt).toISOString(),
    },
  }
  logServerEvent(context, "warn", "api.ip_rate_limited", {
    bucket: options.bucket,
    limit,
    resetAt: new Date(result.resetAt).toISOString(),
  })
  return hit
}

export function ipRateLimitResponse(context: RequestContext, hit: IpRateLimitHit) {
  return withRequestHeaders(
    new Response(
      JSON.stringify({
        code: hit.code,
        error: "Too many requests from this IP. Please slow down.",
        limit: hit.limit,
        requestId: context.requestId,
        resetAt: new Date(hit.resetAt).toISOString(),
      }),
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          ...hit.headers,
        },
      },
    ),
    context,
    hit.code,
  )
}

function readRouteLimit(env: IpRateLimitEnv, options: IpRateLimitOptions) {
  const routeValue = options.limitEnvKey ? env[options.limitEnvKey] : undefined
  return (
    readConfiguredLimit(routeValue) ??
    readConfiguredLimit(env.SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE) ??
    options.defaultLimit
  )
}

function readConfiguredLimit(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return null
  return Math.min(maxConfiguredLimit, Math.max(0, parsed))
}

function readClientKey(request: Request, env: IpRateLimitEnv) {
  const cloudflareIp = cleanClientKey(request.headers.get("cf-connecting-ip"))
  if (cloudflareIp) return cloudflareIp

  if (env.SAFECAFE_TRUST_PROXY_HEADERS === "true") {
    const forwardedIp = request.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((value) => cleanClientKey(value))
      .find((value): value is string => Boolean(value))
    if (forwardedIp) return forwardedIp

    const realIp = cleanClientKey(request.headers.get("x-real-ip"))
    if (realIp) return realIp
  }

  return "local"
}

function cleanClientKey(value: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 120) : null
}

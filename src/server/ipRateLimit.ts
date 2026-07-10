import { logServerEvent, type RequestContext, withRequestHeaders } from "./serverDiagnostics"

export type IpRateLimitEnv = {
  SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE?: string
}

type IpRateLimitOptions = {
  bucket: string
  defaultLimit: number
  limitEnvKey?: keyof IpRateLimitEnv
}

export type IpRateLimitHit = {
  code: "ip_rate_limited"
  limit: number
  resetAt: number
  retryAfterSeconds: number
  headers: Record<string, string>
}

const ipRateLimitWindowMs = 60_000
const maxConfiguredLimit = 100_000
const ipBuckets = new Map<string, { count: number; resetAt: number }>()

export function consumeIpRateLimit(
  request: Request,
  env: IpRateLimitEnv,
  context: RequestContext,
  options: IpRateLimitOptions,
): IpRateLimitHit | null {
  const limit = readRouteLimit(env, options)
  if (limit <= 0) return null

  const now = Date.now()
  const resetAt = now + ipRateLimitWindowMs
  const clientKey = readClientKey(request)
  const bucketKey = `${options.bucket}:${clientKey}`

  for (const [key, bucket] of ipBuckets) {
    if (bucket.resetAt <= now) ipBuckets.delete(key)
  }

  const bucket = ipBuckets.get(bucketKey)
  if (!bucket || bucket.resetAt <= now) {
    ipBuckets.set(bucketKey, { count: 1, resetAt })
    return null
  }

  bucket.count += 1
  if (bucket.count <= limit) return null

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  const hit: IpRateLimitHit = {
    code: "ip_rate_limited",
    limit,
    resetAt: bucket.resetAt,
    retryAfterSeconds,
    headers: {
      "retry-after": String(retryAfterSeconds),
      "x-safecafe-ip-rate-limit": String(limit),
      "x-safecafe-ip-rate-reset": new Date(bucket.resetAt).toISOString(),
    },
  }
  logServerEvent(context, "warn", "api.ip_rate_limited", {
    bucket: options.bucket,
    limit,
    resetAt: new Date(bucket.resetAt).toISOString(),
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
  return readBoundedInteger(routeValue ?? env.SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE, options.defaultLimit)
}

function readBoundedInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maxConfiguredLimit, Math.max(0, parsed))
}

function readClientKey(request: Request) {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local"
  return ip.slice(0, 120)
}

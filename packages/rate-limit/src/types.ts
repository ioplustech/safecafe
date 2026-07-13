export type FixedWindowRateLimiterOptions = {
  maxEntries: number
  now?: () => number
  windowMs: number
}

export type RateLimitConsumeInput = {
  bucket: string
  key: string
  limit: number
}

export type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfterMs: number
}

export type FixedWindowRateLimiter = {
  consume(input: RateLimitConsumeInput): RateLimitResult
}

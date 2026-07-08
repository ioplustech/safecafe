import { rpcUrls } from "./rpcPool"
import { elapsedMs, logServerEvent, type RequestContext, redactUrl, truncateMessage } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

export { rpcUrls } from "./rpcPool"

export type JsonRpcRequest = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export type RpcUpstreamFailure = {
  attempts: number
  elapsedMs: number
  error: string
  lastUpstream?: string
  reason: "upstream_unavailable"
  retryable: boolean
}

export async function forwardRpcRequest(
  request: JsonRpcRequest,
  env: RpcGatewayEnv,
  context?: RequestContext,
): Promise<{ ok: true; value: unknown } | { ok: false; failure: RpcUpstreamFailure }> {
  const startedAt = Date.now()
  const urls = await rpcUrls(env)
  if (urls.length === 0) {
    const failure: RpcUpstreamFailure = {
      attempts: 0,
      elapsedMs: elapsedMs(startedAt),
      error: "No RPC upstream is configured.",
      reason: "upstream_unavailable",
      retryable: false,
    }
    if (context) {
      logServerEvent(context, "error", "rpc.upstream.unavailable", {
        attempts: failure.attempts,
        elapsedMs: failure.elapsedMs,
        method: methodName(request),
        reason: failure.reason,
      })
    }
    return { ok: false, failure }
  }

  let lastError = "No RPC upstream is configured."
  let lastUpstream: string | undefined
  let retryable = false
  let attempts = 0
  for (const url of urls) {
    attempts += 1
    lastUpstream = redactUrl(url)
    const attemptStartedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        lastError = `RPC upstream returned HTTP ${response.status}.`
        retryable = shouldRetryHttpStatus(response.status)
        if (context) {
          logServerEvent(context, "warn", "rpc.upstream.http_error", {
            attempt: attempts,
            attemptElapsedMs: elapsedMs(attemptStartedAt),
            method: methodName(request),
            status: response.status,
            upstream: lastUpstream,
          })
        }
        if (retryable) continue
        break
      }
      const value = (await response.json()) as { error?: { code?: unknown; data?: unknown; message?: unknown } }
      if (value.error && shouldRetryJsonRpcError(request, value.error)) {
        lastError = typeof value.error.message === "string" ? value.error.message : "RPC upstream returned an error."
        retryable = true
        if (context) {
          logServerEvent(context, "warn", "rpc.upstream.json_rpc_retry", {
            attempt: attempts,
            attemptElapsedMs: elapsedMs(attemptStartedAt),
            jsonRpcErrorCode: value.error.code,
            jsonRpcErrorMessage: truncateMessage(value.error.message),
            method: methodName(request),
            upstream: lastUpstream,
          })
        }
        continue
      }
      if (value.error && context) {
        logServerEvent(context, "warn", "rpc.upstream.json_rpc_error", {
          attempt: attempts,
          attemptElapsedMs: elapsedMs(attemptStartedAt),
          jsonRpcErrorCode: value.error.code,
          jsonRpcErrorMessage: truncateMessage(value.error.message),
          method: methodName(request),
          upstream: lastUpstream,
        })
        value.error = {
          ...value.error,
          data: mergeJsonRpcErrorData(value.error.data, {
            method: methodName(request),
            requestId: context.requestId,
            upstream: lastUpstream,
          }),
        }
      }
      if (context) {
        logServerEvent(context, "info", "rpc.upstream.success", {
          attempt: attempts,
          attemptElapsedMs: elapsedMs(attemptStartedAt),
          method: methodName(request),
          upstream: lastUpstream,
        })
      }
      return { ok: true, value }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "RPC upstream failed."
      retryable = true
      if (context) {
        logServerEvent(context, "warn", "rpc.upstream.fetch_error", {
          attempt: attempts,
          attemptElapsedMs: elapsedMs(attemptStartedAt),
          error: truncateMessage(lastError),
          method: methodName(request),
          upstream: lastUpstream,
        })
      }
    } finally {
      clearTimeout(timer)
    }
  }
  const failure: RpcUpstreamFailure = {
    attempts,
    elapsedMs: elapsedMs(startedAt),
    error: lastError,
    lastUpstream,
    reason: "upstream_unavailable",
    retryable,
  }
  if (context) {
    logServerEvent(context, "error", "rpc.upstream.unavailable", {
      attempts: failure.attempts,
      elapsedMs: failure.elapsedMs,
      lastError: truncateMessage(failure.error),
      lastUpstream: failure.lastUpstream,
      method: methodName(request),
      reason: failure.reason,
      retryable: failure.retryable,
    })
  }
  return { ok: false, failure }
}

function shouldRetryJsonRpcError(
  request: JsonRpcRequest,
  error: { code?: unknown; data?: unknown; message?: unknown },
) {
  const message = typeof error.message === "string" ? error.message.toLowerCase() : ""
  const dataMessage = jsonRpcDataMessage(error.data)
  const combinedMessage = `${message} ${dataMessage}`.trim()
  if (isContractExecutionError(combinedMessage)) return false

  if (
    combinedMessage.includes("cannot fulfill request") ||
    combinedMessage.includes("rate limit") ||
    combinedMessage.includes("too many requests") ||
    combinedMessage.includes("temporarily unavailable") ||
    combinedMessage.includes("timeout") ||
    combinedMessage.includes("header not found") ||
    combinedMessage.includes("missing trie node") ||
    combinedMessage.includes("service unavailable") ||
    combinedMessage.includes("bad gateway")
  ) {
    return true
  }

  if (request.method === "eth_call") {
    return error.code === -32603 && combinedMessage.includes("internal error")
  }

  return false
}

function shouldRetryHttpStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}

function isContractExecutionError(message: string) {
  return message.includes("execution reverted") || message.includes("revert") || message.includes("invalid opcode")
}

function jsonRpcDataMessage(data: unknown) {
  if (typeof data === "string") return data.toLowerCase()
  if (typeof data !== "object" || data === null) return ""
  const message = (data as { message?: unknown }).message
  const reason = (data as { reason?: unknown }).reason
  return [message, reason]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase()
}

function methodName(request: JsonRpcRequest) {
  return typeof request.method === "string" ? request.method : "unknown"
}

function mergeJsonRpcErrorData(existing: unknown, extra: Record<string, unknown>) {
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return { ...existing, ...extra }
  }
  if (existing === undefined || existing === null) return extra
  return { original: existing, ...extra }
}

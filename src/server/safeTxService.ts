import { getAddress, isAddress, isHex } from "viem"
import { resolveEnvList } from "../shared/utils"
import { readRpcSession, type SessionPayload } from "./authSession"
import { consumeIpRateLimit } from "./ipRateLimit"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

type SafeTxAction = "about" | "confirm" | "confirmations" | "get" | "propose"

type SafeTxServiceRequest = {
  action?: unknown
  origin?: unknown
  safeAddress?: unknown
  safeTransactionData?: unknown
  safeTxHash?: unknown
  senderAddress?: unknown
  senderSignature?: unknown
  signature?: unknown
}

type SafeTxServiceErrorCode =
  | "invalid_request"
  | "method_not_allowed"
  | "safe_tx_rate_limited"
  | "safe_api_key_invalid"
  | "safe_api_key_missing"
  | "safe_tx_auth_mismatch"
  | "safe_tx_auth_required"
  | "safe_tx_service_failed"
  | "safe_tx_service_not_found"
  | "safe_tx_service_rate_limited"

const defaultSafeTxServiceBaseUrl = "https://api.safe.global/tx-service/eth/api"
const maxBodyBytes = 64_000

export async function handleSafeTxServiceRequest(request: Request, env: RpcGatewayEnv = {}): Promise<Response> {
  const context = createRequestContext(request, "safe.transaction")
  if (request.method !== "POST") {
    return safeTxError(context, "method_not_allowed", "Method not allowed.", 405)
  }
  const ipLimited = consumeIpRateLimit(request, env, context, {
    bucket: "safe.transaction",
    defaultLimit: 30,
    limitEnvKey: "SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE",
  })
  if (ipLimited) {
    return safeTxError(
      context,
      "safe_tx_rate_limited",
      "Too many Safe transaction requests from this IP. Please slow down.",
      429,
      ipLimited.headers,
    )
  }

  const body = await readJsonBody(request)
  if (body.status !== "ok") return safeTxError(context, "invalid_request", body.error, body.httpStatus)

  const parsed = parseSafeTxServiceRequest(body.value)
  if (parsed.status !== "ok") return safeTxError(context, "invalid_request", parsed.error, 400)

  const session = await readRpcSession(request, env)
  if (!session) {
    return safeTxError(
      context,
      "safe_tx_auth_required",
      "Signed wallet session is required for Safe Transaction Service access.",
      401,
    )
  }
  const sessionError = validateSafeTxSession(parsed.value, session)
  if (sessionError) return safeTxError(context, "safe_tx_auth_mismatch", sessionError, 403)

  const keys = resolveEnvList({ SAFECAFE_SAFE_API_KEYS: env.SAFECAFE_SAFE_API_KEYS }, ["SAFECAFE_SAFE_API_KEYS"])
  if (keys.length === 0) {
    return safeTxError(
      context,
      "safe_api_key_missing",
      "Safe Transaction Service API key is not configured on this deployment.",
      503,
    )
  }

  try {
    const result = await callSafeTxService(parsed.value, env, keys)
    logServerEvent(context, "info", "safe.transaction.success", { action: parsed.value.action })
    return withRequestHeaders(json({ result, requestId: context.requestId }, 200), context)
  } catch (error) {
    const mapped = mapSafeTxServiceError(error)
    logServerEvent(context, mapped.status >= 500 ? "error" : "warn", "safe.transaction.failed", {
      action: parsed.value.action,
      code: mapped.code,
      error: truncateMessage(error instanceof Error ? error.message : "Safe Transaction Service failed."),
    })
    return safeTxError(context, mapped.code, mapped.message, mapped.status)
  }
}

async function callSafeTxService(input: ParsedSafeTxServiceRequest, env: RpcGatewayEnv, apiKeys: readonly string[]) {
  const baseUrl = normalizeSafeTxServiceBaseUrl(env.SAFECAFE_SAFE_TX_SERVICE_URL)
  const request = toUpstreamRequest(input, baseUrl)
  let lastError: unknown = null
  for (const apiKey of apiKeys) {
    try {
      return await fetchSafeTxService(request, apiKey)
    } catch (error) {
      lastError = error
      if (!shouldTryNextKey(error)) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Safe Transaction Service request failed.")
}

function toUpstreamRequest(
  input: ParsedSafeTxServiceRequest,
  baseUrl: string,
): { body?: unknown; method: string; url: string } {
  if (input.action === "about") return { method: "GET", url: `${baseUrl}/v1/about` }
  if (input.action === "get") return { method: "GET", url: `${baseUrl}/v2/multisig-transactions/${input.safeTxHash}/` }
  if (input.action === "confirmations") {
    return { method: "GET", url: `${baseUrl}/v1/multisig-transactions/${input.safeTxHash}/confirmations/` }
  }
  if (input.action === "confirm") {
    return {
      body: { signature: input.signature },
      method: "POST",
      url: `${baseUrl}/v1/multisig-transactions/${input.safeTxHash}/confirmations/`,
    }
  }
  return {
    body: {
      ...input.safeTransactionData,
      contractTransactionHash: input.safeTxHash,
      origin: input.origin,
      sender: input.senderAddress,
      signature: input.senderSignature,
    },
    method: "POST",
    url: `${baseUrl}/v2/safes/${input.safeAddress}/multisig-transactions/`,
  }
}

async function fetchSafeTxService(request: { body?: unknown; method: string; url: string }, apiKey: string) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  })
  const text = await response.text()
  const payload = parseJson(text)
  if (!response.ok) {
    throw new SafeTxUpstreamError(response.status, readSafeTxErrorMessage(payload, response.statusText), payload)
  }
  return payload ?? null
}

function parseSafeTxServiceRequest(
  value: unknown,
): { status: "error"; error: string } | { status: "ok"; value: ParsedSafeTxServiceRequest } {
  if (!value || typeof value !== "object") return { status: "error", error: "Request body must be a JSON object." }
  const body = value as SafeTxServiceRequest
  const action = typeof body.action === "string" ? body.action : ""
  if (!isSafeTxAction(action)) return { status: "error", error: "Unsupported Safe transaction action." }
  if (action === "about") return { status: "ok", value: { action } }

  const safeTxHash = readHex(body.safeTxHash)
  if (!safeTxHash) return { status: "error", error: "A valid safeTxHash is required." }
  const safeAddress = readAddress(body.safeAddress)
  const senderAddress = readAddress(body.senderAddress)
  if (!safeAddress) return { status: "error", error: "A valid safeAddress is required." }
  if (!senderAddress) return { status: "error", error: "A valid senderAddress is required." }

  if (action === "get" || action === "confirmations") {
    return { status: "ok", value: { action, safeAddress, safeTxHash, senderAddress } }
  }

  if (action === "confirm") {
    const signature = readHex(body.signature)
    if (!signature) return { status: "error", error: "A valid signature is required." }
    return { status: "ok", value: { action, safeAddress, safeTxHash, senderAddress, signature } }
  }

  const senderSignature = readHex(body.senderSignature)
  if (!senderSignature) return { status: "error", error: "A valid senderSignature is required." }
  if (!body.safeTransactionData || typeof body.safeTransactionData !== "object") {
    return { status: "error", error: "safeTransactionData is required." }
  }
  const origin = typeof body.origin === "string" && body.origin.trim() ? body.origin.trim().slice(0, 200) : undefined
  return {
    status: "ok",
    value: {
      action,
      origin,
      safeAddress,
      safeTransactionData: body.safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
    },
  }
}

type ParsedSafeTxServiceRequest =
  | { action: "about" }
  | { action: "confirmations"; safeAddress: string; safeTxHash: string; senderAddress: string }
  | { action: "get"; safeAddress: string; safeTxHash: string; senderAddress: string }
  | { action: "confirm"; safeAddress: string; safeTxHash: string; senderAddress: string; signature: string }
  | {
      action: "propose"
      origin?: string
      safeAddress: string
      safeTransactionData: object
      safeTxHash: string
      senderAddress: string
      senderSignature: string
    }

function isSafeTxAction(value: string): value is SafeTxAction {
  return value === "about" || value === "confirm" || value === "confirmations" || value === "get" || value === "propose"
}

function readAddress(value: unknown) {
  return typeof value === "string" && isAddress(value) ? value : null
}

function readHex(value: unknown) {
  return typeof value === "string" && isHex(value) ? value : null
}

function validateSafeTxSession(input: ParsedSafeTxServiceRequest, session: SessionPayload) {
  if (input.action === "about") return null
  if (session.subjectKind !== "safe") return "Safe Transaction Service access requires a selected Safe staking account."
  if (getAddress(input.safeAddress).toLowerCase() !== session.subject.toLowerCase()) {
    return "Safe transaction account does not match the signed wallet session."
  }
  if (getAddress(input.senderAddress).toLowerCase() !== session.signer.toLowerCase()) {
    return "Safe transaction signer does not match the signed wallet session."
  }
  return null
}

function shouldTryNextKey(error: unknown) {
  return error instanceof SafeTxUpstreamError && (error.status === 401 || error.status === 403 || error.status === 429)
}

function mapSafeTxServiceError(error: unknown): { code: SafeTxServiceErrorCode; message: string; status: number } {
  if (!(error instanceof SafeTxUpstreamError)) {
    return { code: "safe_tx_service_failed", message: "Safe Transaction Service request failed.", status: 502 }
  }
  if (error.status === 401 || error.status === 403) {
    return {
      code: "safe_api_key_invalid",
      message: "Safe Transaction Service API key is invalid or not allowed.",
      status: 502,
    }
  }
  if (error.status === 404) {
    return { code: "safe_tx_service_not_found", message: "Safe transaction was not found.", status: 404 }
  }
  if (error.status === 429) {
    return {
      code: "safe_tx_service_rate_limited",
      message: "Safe Transaction Service rate limit was reached.",
      status: 429,
    }
  }
  return {
    code: "safe_tx_service_failed",
    message: error.message || "Safe Transaction Service request failed.",
    status: 502,
  }
}

function safeTxError(
  context: ReturnType<typeof createRequestContext>,
  code: SafeTxServiceErrorCode,
  message: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return withRequestHeaders(
    json({ error: { code, message }, requestId: context.requestId }, status, headers),
    context,
    code,
  )
}

async function readJsonBody(
  request: Request,
): Promise<{ status: "error"; error: string; httpStatus: number } | { status: "ok"; value: unknown }> {
  const text = await request.text()
  if (text.length > maxBodyBytes) {
    return { status: "error", error: "Request body is too large.", httpStatus: 413 }
  }
  if (!text.trim()) return { status: "error", error: "Request body is required.", httpStatus: 400 }
  try {
    return { status: "ok", value: JSON.parse(text) as unknown }
  } catch {
    return { status: "error", error: "Request body must be valid JSON.", httpStatus: 400 }
  }
}

function normalizeSafeTxServiceBaseUrl(value: string | undefined) {
  const trimmed = value?.trim().replace(/\/+$/, "")
  if (!trimmed) return defaultSafeTxServiceBaseUrl
  return trimmed
}

function parseJson(text: string) {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function readSafeTxErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback
  for (const key of ["detail", "message", "data", "nonFieldErrors"]) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim()) return value
    if (Array.isArray(value) && value.length > 0) return value.join(", ")
  }
  return fallback
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  })
}

class SafeTxUpstreamError extends Error {
  readonly payload: unknown
  readonly status: number

  constructor(status: number, message: string, payload: unknown) {
    super(message)
    this.name = "SafeTxUpstreamError"
    this.payload = payload
    this.status = status
  }
}

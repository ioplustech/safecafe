import { hashMessage, isAddress } from "viem"
import { CHAIN_ID, CONTRACTS } from "../protocol/contracts"
import { rpcStrategy, verifyRpcAccess } from "./accessStrategy"
import {
  accountSubjectKind,
  authTtlSeconds,
  canUseAuthSecret,
  challengeTtlSeconds,
  createAuthMessage,
  createChallengeToken,
  createSessionToken,
  readAddress,
  readRpcSession,
  type SessionPayload,
  verifyChallengeToken,
  verifyWalletSignature,
} from "./authSession"
import { forwardRpcRequest, type JsonRpcRequest } from "./rpcUpstream"
import {
  createRequestContext,
  logServerEvent,
  type RequestContext,
  truncateMessage,
  withRequestHeaders,
} from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

export type { RpcGatewayEnv } from "./serverEnv"

type JsonErrorDetails = {
  attempts?: number
  lastUpstream?: string
  reason?: string
  requestId?: string
  retryable?: boolean
  upstreamElapsedMs?: number
}

const maxBodyBytes = 32_000
const allowedCallTargets = new Set<string>(
  [CONTRACTS.safeToken, CONTRACTS.staking, CONTRACTS.merkleDrop, CONTRACTS.multicall3].map((address) =>
    address.toLowerCase(),
  ),
)

export async function handleRpcChallengeRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  const context = createRequestContext(request, "auth.challenge")
  if (request.method !== "POST") return httpError(context, "method_not_allowed", "Method not allowed", 405)
  if (!canUseAuthSecret(env)) {
    return httpError(context, "rpc_auth_not_configured", "RPC auth is not configured.", 503)
  }
  const body = await readJsonBody(request)
  if (body.status !== "ok") return httpError(context, body.reason, body.error, body.status)
  const signer = readAddress(body.value, "signer") ?? readAddress(body.value, "address")
  if (!signer) return httpError(context, "invalid_signer", "A valid signer address is required.", 400)
  const subject = readAddress(body.value, "subject") ?? signer
  const subjectKind = accountSubjectKind(signer, subject)
  const chainId = readNumber(body.value, "chainId") ?? CHAIN_ID
  if (chainId !== CHAIN_ID) return httpError(context, "unsupported_chain", "Only Ethereum mainnet is supported.", 400)
  const now = Math.floor(Date.now() / 1000)
  const nonce = crypto.randomUUID()
  const message = createAuthMessage({
    signer,
    subject,
    subjectKind,
    chainId,
    domain: new URL(request.url).host,
    expirationTime: new Date((now + challengeTtlSeconds) * 1000).toISOString(),
    issuedAt: new Date(now * 1000).toISOString(),
    nonce,
    strategy: rpcStrategy(env),
  })
  const challenge = await createChallengeToken(
    {
      signer,
      subject,
      subjectKind,
      chainId,
      exp: now + challengeTtlSeconds,
      iat: now,
      messageHash: hashMessage(message),
      nonce,
    },
    env,
  )
  logServerEvent(context, "info", "rpc.auth.challenge.created", { strategy: rpcStrategy(env), subjectKind })
  return json(
    {
      challenge,
      expiresAt: now + challengeTtlSeconds,
      message,
      signer,
      subject,
      subjectKind,
      strategy: rpcStrategy(env),
    },
    200,
    "no-store",
    context,
  )
}

export async function handleRpcVerifyRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  const context = createRequestContext(request, "auth.verify")
  if (request.method !== "POST") return httpError(context, "method_not_allowed", "Method not allowed", 405)
  if (!canUseAuthSecret(env)) {
    return httpError(context, "rpc_auth_not_configured", "RPC auth is not configured.", 503)
  }
  const body = await readJsonBody(request)
  if (body.status !== "ok") return httpError(context, body.reason, body.error, body.status)
  const signer = readAddress(body.value, "signer") ?? readAddress(body.value, "address")
  const subject = readAddress(body.value, "subject") ?? signer
  const challenge = readString(body.value, "challenge")
  const message = readString(body.value, "message")
  const signature = readString(body.value, "signature")
  if (!signer || !subject || !challenge || !message || !signature) {
    return httpError(
      context,
      "missing_verify_fields",
      "signer, subject, challenge, message and signature are required.",
      400,
    )
  }
  const challengePayload = await verifyChallengeToken(challenge, env)
  const challengeSigner = challengePayload?.signer ?? challengePayload?.address
  const challengeSubject = challengePayload?.subject ?? challengeSigner
  if (
    !challengePayload ||
    !challengeSigner ||
    !challengeSubject ||
    challengeSigner.toLowerCase() !== signer.toLowerCase() ||
    challengeSubject.toLowerCase() !== subject.toLowerCase()
  ) {
    return httpError(context, "invalid_challenge", "Invalid or expired challenge.", 401)
  }
  if (challengePayload.messageHash !== hashMessage(message)) {
    return httpError(context, "challenge_message_mismatch", "Challenge message does not match.", 401)
  }
  const validSignature = await verifyWalletSignature({
    address: signer,
    env,
    message,
    signature: signature as `0x${string}`,
  })
  if (!validSignature) return httpError(context, "invalid_wallet_signature", "Invalid wallet signature.", 401)
  const eligible = await verifyRpcAccess({ signer, subject }, env)
  if (!eligible) {
    return httpError(context, "access_strategy_not_satisfied", "Wallet does not satisfy the SAFE access strategy.", 403)
  }
  const now = Math.floor(Date.now() / 1000)
  const session: SessionPayload = {
    address: signer,
    signer,
    subject,
    subjectKind: accountSubjectKind(signer, subject),
    chainId: CHAIN_ID,
    exp: now + authTtlSeconds,
    iat: now,
    strategy: rpcStrategy(env),
  }
  logServerEvent(context, "info", "rpc.auth.verify.succeeded", {
    strategy: session.strategy,
    subjectKind: session.subjectKind,
  })
  return json(
    {
      address: signer,
      signer,
      subject,
      subjectKind: session.subjectKind,
      expiresAt: session.exp,
      strategy: session.strategy,
      token: await createSessionToken(session, env),
    },
    200,
    "no-store",
    context,
  )
}

export async function handleEthereumRpcGatewayRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  const context = createRequestContext(request, "rpc.ethereum")
  if (request.method !== "POST") {
    return jsonRpcHttpError(context, null, -32600, "Only POST is supported.", 405, "method_not_allowed")
  }
  if (!canUseAuthSecret(env)) {
    return jsonRpcHttpError(context, null, -32000, "RPC auth is not configured.", 503, "rpc_auth_not_configured")
  }
  const session = await readRpcSession(request, env)
  if (!session) {
    return jsonRpcHttpError(context, null, -32001, "Authentication required.", 401, "authentication_required")
  }
  const eligible = await verifyRpcAccess({ signer: session.signer, subject: session.subject }, env)
  if (!eligible) {
    return jsonRpcHttpError(
      context,
      null,
      -32003,
      "Wallet no longer satisfies access strategy.",
      403,
      "access_strategy_not_satisfied",
    )
  }
  const body = await readJsonBody(request)
  if (body.status !== "ok") return jsonRpcHttpError(context, null, -32700, body.error, body.status, body.reason)
  if (Array.isArray(body.value)) {
    if (body.value.length > 20) {
      return jsonRpcHttpError(context, null, -32600, "Batch request is too large.", 413, "batch_too_large")
    }
    const results = await Promise.all(body.value.map((item) => handleRpcItem(item, env, context)))
    return json(results, 200, "no-store", context)
  }
  return json(await handleRpcItem(body.value, env, context), 200, "no-store", context)
}

async function handleRpcItem(input: unknown, env: RpcGatewayEnv, context: RequestContext) {
  const request = input as JsonRpcRequest
  const id = isJsonRpcId(request?.id) ? request.id : null
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(context, id, -32600, "Invalid JSON-RPC request.", "invalid_json_rpc_request")
  }
  const blocked = validateRpcRequest(request)
  if (blocked) {
    logServerEvent(context, "warn", "rpc.request.blocked", {
      jsonRpcCode: blocked.code,
      method: request.method,
      reason: blocked.reason,
    })
    return jsonRpcError(context, id, blocked.code, blocked.message, blocked.reason)
  }
  const upstream = await forwardRpcRequest(request, env, context)
  if (!upstream.ok) {
    return jsonRpcError(context, id, -32002, upstream.failure.error, upstream.failure.reason, {
      attempts: upstream.failure.attempts,
      lastUpstream: upstream.failure.lastUpstream,
      retryable: upstream.failure.retryable,
      upstreamElapsedMs: upstream.failure.elapsedMs,
    })
  }
  return upstream.value
}

function validateRpcRequest(request: JsonRpcRequest): { code: number; message: string; reason: string } | null {
  const method = request.method
  if (method === "eth_chainId" || method === "eth_blockNumber") return null
  if (
    method === "eth_getBalance" ||
    method === "eth_getBlockByNumber" ||
    method === "eth_getCode" ||
    method === "eth_getTransactionByHash" ||
    method === "eth_getTransactionReceipt"
  ) {
    return null
  }
  if (method !== "eth_call")
    return { code: -32601, message: `Method is not allowed: ${method}`, reason: "method_not_allowed" }
  if (!Array.isArray(request.params) || request.params.length < 1) {
    return { code: -32602, message: "eth_call params are required.", reason: "invalid_eth_call_params" }
  }
  const call = request.params[0] as { to?: unknown; data?: unknown }
  if (!call || typeof call.to !== "string" || !isAddress(call.to)) {
    return { code: -32602, message: "eth_call target is required.", reason: "invalid_eth_call_target" }
  }
  if (!allowedCallTargets.has(call.to.toLowerCase())) {
    return { code: -32602, message: "eth_call target is not allowed.", reason: "eth_call_target_not_allowed" }
  }
  if (typeof call.data === "string" && call.data.length > 20_000) {
    return { code: -32602, message: "eth_call data is too large.", reason: "eth_call_data_too_large" }
  }
  return null
}

async function readJsonBody(
  request: Request,
): Promise<{ status: "ok"; value: unknown } | { status: number; error: string; reason: string }> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > maxBodyBytes) {
    return { status: 413, error: "Request body is too large.", reason: "request_body_too_large" }
  }
  const raw = await request.text()
  if (raw.length > maxBodyBytes) {
    return { status: 413, error: "Request body is too large.", reason: "request_body_too_large" }
  }
  try {
    return { status: "ok", value: raw ? JSON.parse(raw) : {} }
  } catch {
    return { status: 400, error: "Invalid JSON body.", reason: "invalid_json_body" }
  }
}

function readString(value: unknown, key: string) {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null
  return typeof raw === "string" ? raw : null
}

function readNumber(value: unknown, key: string) {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null
}

function isJsonRpcId(value: unknown) {
  return typeof value === "string" || typeof value === "number" || value === null
}

function json(payload: unknown, status = 200, cacheControl = "no-store", context?: RequestContext, errorCode?: string) {
  const response = new Response(JSON.stringify(payload), {
    status,
    headers: { "cache-control": cacheControl, "content-type": "application/json; charset=utf-8" },
  })
  return context ? withRequestHeaders(response, context, errorCode) : response
}

function httpError(context: RequestContext, code: string, message: string, status: number) {
  logServerEvent(context, status >= 500 ? "error" : "warn", "rpc.http.error", {
    errorCode: code,
    message: truncateMessage(message),
    status,
  })
  return json({ code, error: message, requestId: context.requestId }, status, "no-store", context, code)
}

function jsonRpcHttpError(
  context: RequestContext,
  id: unknown,
  jsonRpcCode: number,
  message: string,
  status: number,
  reason: string,
) {
  logServerEvent(context, status >= 500 ? "error" : "warn", "rpc.json_rpc.http_error", {
    jsonRpcCode,
    message: truncateMessage(message),
    reason,
    status,
  })
  return json(jsonRpcError(context, id, jsonRpcCode, message, reason), status, "no-store", context, reason)
}

function jsonRpcError(
  context: RequestContext,
  id: unknown,
  code: number,
  message: string,
  reason: string,
  details: JsonErrorDetails = {},
) {
  return {
    error: {
      code,
      data: {
        requestId: context.requestId,
        reason,
        ...details,
      },
      message,
    },
    id,
    jsonrpc: "2.0",
  }
}

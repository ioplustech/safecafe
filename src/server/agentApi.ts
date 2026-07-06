import { createPublicClient, getAddress, http, isAddress } from "viem"
import { erc20Abi, stakingAbi } from "../protocol/abi"
import { ethereumMainnet } from "../protocol/chains"
import { CONTRACTS } from "../protocol/contracts"

type AgentApiEnv = {
  SAFECAFE_AGENT_TEST_VERIFIED_ACCESS?: string
  SAFECAFE_RPC_URL?: string
  SAFECAFE_LLM_API_BASE?: string
  SAFECAFE_LLM_API_MODEL?: string
  SAFECAFE_LLM_API_KEY?: string
}

type AgentApiRequest = {
  message?: unknown
  messages?: unknown
  context?: unknown
  stream?: unknown
}

type SanitizedRequest = {
  message: string
  messages: Array<{ role: "assistant" | "user"; content: string }>
  context: {
    account: string | null
    accountConnected: boolean
    chainId: unknown
    hasLiveSnapshot: boolean
    hasStakingPosition: boolean
    liveBlock: unknown
    validatorLabels: unknown[]
  }
  stream: boolean
}

const maxBodyBytes = 24_000
const upstreamTimeoutMs = 12_000
const rateLimitWindowMs = 60_000
const maxRequestsPerWindow = 20
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

export async function handleAgentApiRequest(request: Request, env: AgentApiEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (isRateLimited(request)) return json({ error: "Too many Agent requests. Please slow down." }, 429)

  const parsed = await readAgentRequest(request)
  if (parsed.status !== "ok") return json({ error: parsed.error }, parsed.status)

  const access = await verifyAgentAccess(parsed.value, env)
  const fallback = lockedOrFallbackReply(access)
  if (fallback) return agentResponse(parsed.value, fallback.content, fallback.source, fallback.thinking)

  const base = env.SAFECAFE_LLM_API_BASE
  const model = env.SAFECAFE_LLM_API_MODEL
  const apiKey = env.SAFECAFE_LLM_API_KEY
  if (!base || !model || !apiKey) {
    return agentResponse(
      parsed.value,
      "Agent LLM is not configured. I can still draft supported staking plans locally after wallet data is loaded.",
      "fallback",
      "Service configuration was checked. No remote model call was made.",
    )
  }

  if (parsed.value.stream) {
    return streamingAgentResponse({
      apiKey,
      base,
      model,
      request: parsed.value,
      thinking: "Server-side eligibility check passed. Asking the Agent service with redacted staking context.",
    })
  }
  const upstream = await callUpstream({ base, model, apiKey, request: parsed.value })
  return agentResponse(parsed.value, upstream.content, upstream.source, upstream.thinking)
}

async function readAgentRequest(
  request: Request,
): Promise<{ status: "ok"; value: SanitizedRequest } | { status: number; error: string }> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > maxBodyBytes) return { status: 413, error: "Agent request is too large." }
  const raw = await request.text()
  if (raw.length > maxBodyBytes) return { status: 413, error: "Agent request is too large." }
  let body: AgentApiRequest
  try {
    body = raw ? (JSON.parse(raw) as AgentApiRequest) : {}
  } catch {
    return { status: 400, error: "Invalid JSON body." }
  }
  const context = summarizeContext(body.context)
  return {
    status: "ok",
    value: {
      message: typeof body.message === "string" ? body.message.slice(0, 2000) : "",
      messages: Array.isArray(body.messages)
        ? body.messages
            .filter((item): item is { role: "assistant" | "user"; content: string } => isChatMessage(item))
            .slice(-8)
            .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }))
        : [],
      context,
      stream: body.stream === true || request.headers.get("accept")?.includes("text/event-stream") === true,
    },
  }
}

async function verifyAgentAccess(
  request: SanitizedRequest,
  env: AgentApiEnv,
): Promise<{ status: "eligible" | "locked" | "unconfigured"; reason: string }> {
  if (env.SAFECAFE_AGENT_TEST_VERIFIED_ACCESS === "true") {
    return { status: "eligible", reason: "Test-only server-side eligibility override passed." }
  }
  if (!request.context.account || !isAddress(request.context.account)) {
    return {
      status: "locked",
      reason: "No valid wallet address was provided for server-side eligibility verification.",
    }
  }
  if (!env.SAFECAFE_RPC_URL) {
    return { status: "unconfigured", reason: "Server-side RPC is not configured, so remote Agent access stays locked." }
  }
  try {
    const account = getAddress(request.context.account)
    const client = createPublicClient({ chain: ethereumMainnet, transport: http(env.SAFECAFE_RPC_URL) })
    const [safeBalance, totalStaked] = await Promise.all([
      client.readContract({
        address: CONTRACTS.safeToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      }),
      client.readContract({
        address: CONTRACTS.staking,
        abi: stakingAbi,
        functionName: "totalStakerStakes",
        args: [account],
      }),
    ])
    return safeBalance > 0n || totalStaked > 0n
      ? { status: "eligible", reason: "Server-side SAFE balance/staking position check passed." }
      : { status: "locked", reason: "Server-side check found no SAFE balance or staking position." }
  } catch {
    return { status: "locked", reason: "Server-side eligibility check failed." }
  }
}

function lockedOrFallbackReply(access: {
  status: "eligible" | "locked" | "unconfigured"
  reason: string
}): { content: string; source: "fallback"; thinking: string } | null {
  if (access.status === "eligible") return null
  return {
    content:
      "Connect a wallet with SAFE or an existing SAFE staking position to unlock live Agent guidance. Until then, I can show supported examples locally.",
    source: "fallback",
    thinking: access.reason,
  }
}

async function callUpstream(params: {
  base: string
  model: string
  apiKey: string
  request: SanitizedRequest
}): Promise<{ content: string; source: "fallback" | "llm"; thinking: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs)
  try {
    const upstream = await fetch(`${params.base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        temperature: 0.2,
        messages: buildUpstreamMessages(params.request),
      }),
      signal: controller.signal,
    })
    if (!upstream.ok) {
      return unavailableReply("Upstream Agent service returned an error.")
    }
    const data = (await upstream.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    return {
      content: sanitizeAgentContent(data.choices?.[0]?.message?.content),
      source: "llm",
      thinking: "Checked eligibility, sent redacted staking context, and sanitized the model response.",
    }
  } catch {
    return unavailableReply("Upstream Agent service timed out or could not be reached.")
  } finally {
    clearTimeout(timer)
  }
}

function streamingAgentResponse(params: {
  apiKey: string
  base: string
  model: string
  request: SanitizedRequest
  thinking: string
}) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      sendStreamEvent(controller, encoder, { type: "thinking", content: params.thinking })
      const controllerAbort = new AbortController()
      const timer = setTimeout(() => controllerAbort.abort(), upstreamTimeoutMs)
      try {
        const upstream = await fetch(`${params.base.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${params.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: params.model,
            stream: true,
            temperature: 0.2,
            messages: buildUpstreamMessages(params.request),
          }),
          signal: controllerAbort.signal,
        })
        if (!upstream.ok || !upstream.body) {
          writeFinalStream(controller, encoder, unavailableReply("Upstream Agent service returned an error."))
          return
        }
        const final = await forwardUpstreamStream(upstream.body, controller, encoder)
        writeFinalStream(controller, encoder, {
          content: final || "I can help draft a staking plan.",
          source: "llm",
          thinking: params.thinking,
        })
      } catch {
        writeFinalStream(
          controller,
          encoder,
          unavailableReply("Upstream Agent service timed out or could not be reached."),
        )
      } finally {
        clearTimeout(timer)
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  })
}

async function forwardUpstreamStream(
  body: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let final = ""
  let pending = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split("\n\n")
    buffer = events.pop() ?? ""
    for (const eventText of events) {
      const dataLine = eventText
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
      if (!dataLine || dataLine === "[DONE]") continue
      const delta = parseUpstreamDelta(dataLine)
      if (!delta) continue
      final += delta
      const sanitizedSoFar = sanitizeAgentContent(final)
      if (sanitizedSoFar !== final) {
        return sanitizedSoFar
      }
      pending += delta
      if (isSafeStreamingBoundary(pending)) {
        sendStreamEvent(controller, encoder, { type: "delta", content: pending })
        pending = ""
      }
    }
  }
  if (pending && sanitizeAgentContent(final) === final)
    sendStreamEvent(controller, encoder, { type: "delta", content: pending })
  return sanitizeAgentContent(final)
}

function isSafeStreamingBoundary(content: string) {
  return /[.!?。！？]\s*$/.test(content) || content.length >= 120
}

function parseUpstreamDelta(data: string) {
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>
    }
    const value = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content
    return typeof value === "string" ? value : ""
  } catch {
    return ""
  }
}

function writeFinalStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  reply: { content: string; source: "fallback" | "llm"; thinking: string },
) {
  const content = sanitizeAgentContent(reply.content)
  if (reply.source === "fallback") {
    for (const chunk of chunkText(content)) sendStreamEvent(controller, encoder, { type: "delta", content: chunk })
  }
  sendStreamEvent(controller, encoder, { type: "final", content, source: reply.source })
}

function buildUpstreamMessages(request: SanitizedRequest) {
  return [
    {
      role: "system",
      content:
        "You are Safecafe Staking Agent. Help the user express SAFE staking intent. Never claim you can sign or submit transactions. Never generate calldata. Keep answers concise. Supported operations: stake, unstake, claim withdrawal, claim rewards, restake rewards, rebalance after withdrawal delay. Tell users every on-chain action requires wallet confirmation.",
    },
    {
      role: "system",
      content: `Current app context: ${JSON.stringify({
        ...request.context,
        account: request.context.account ? "verified" : null,
      })}`,
    },
    ...request.messages,
    { role: "user", content: request.message },
  ]
}

function unavailableReply(reason: string) {
  return {
    content: "The Agent service is unavailable. Local staking plan checks are still available.",
    source: "fallback" as const,
    thinking: reason,
  }
}

function agentResponse(
  request: SanitizedRequest,
  content: string,
  source: "fallback" | "llm",
  thinking: string,
): Response {
  const sanitizedContent = sanitizeAgentContent(content)
  if (!request.stream) return json({ content: sanitizedContent, thinking, source }, 200)
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      sendStreamEvent(controller, encoder, { type: "thinking", content: thinking })
      for (const chunk of chunkText(sanitizedContent)) {
        sendStreamEvent(controller, encoder, { type: "delta", content: chunk })
      }
      sendStreamEvent(controller, encoder, { type: "final", content: sanitizedContent, source })
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  })
}

function sendStreamEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: unknown,
) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
}

function chunkText(content: string) {
  const chunks: string[] = []
  for (let index = 0; index < content.length; index += 24) chunks.push(content.slice(index, index + 24))
  return chunks.length ? chunks : [""]
}

function isChatMessage(value: unknown): value is { role: "assistant" | "user"; content: string } {
  if (typeof value !== "object" || value === null) return false
  const item = value as { role?: unknown; content?: unknown }
  return (item.role === "assistant" || item.role === "user") && typeof item.content === "string"
}

function summarizeContext(value: unknown): SanitizedRequest["context"] {
  if (typeof value !== "object" || value === null) {
    return {
      account: null,
      accountConnected: false,
      chainId: null,
      hasLiveSnapshot: false,
      hasStakingPosition: false,
      liveBlock: null,
      validatorLabels: [],
    }
  }
  const context = value as Record<string, unknown>
  const account = typeof context.account === "string" && isAddress(context.account) ? getAddress(context.account) : null
  return {
    account,
    accountConnected: typeof context.account === "string",
    chainId: context.chainId ?? null,
    liveBlock: context.liveBlock ?? null,
    hasLiveSnapshot: Boolean(context.hasLiveSnapshot),
    hasStakingPosition: Boolean(context.hasStakingPosition),
    validatorLabels: Array.isArray(context.validatorLabels) ? context.validatorLabels.slice(0, 20) : [],
  }
}

export function sanitizeAgentContent(content: unknown) {
  if (typeof content !== "string" || !content.trim()) return "I can help draft a staking plan."
  const trimmed = content.trim()
  if (unsafeOutputPattern.test(trimmed)) {
    return "I can only help draft a reviewable staking plan. Every on-chain action must be confirmed in your wallet."
  }
  return trimmed
}

function isRateLimited(request: Request) {
  const key =
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"
  const now = Date.now()
  for (const [bucketKey, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey)
  }
  const bucket = rateLimitBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs })
    return false
  }
  bucket.count += 1
  return bucket.count > maxRequestsPerWindow
}

const unsafeOutputPattern =
  /\b(i\s+can\s+sign|i\s+will\s+sign|i'?ll\s+sign|sign\s+for\s+you|sign\s+on\s+your\s+behalf|i\s+can\s+submit|i\s+will\s+submit|i'?ll\s+submit|submit\s+for\s+you|submit\s+the\s+transaction\s+for\s+you|send\s+the\s+transaction\s+for\s+you|execute\s+automatically|automatically\s+execute|auto-?sign|call\s+data|calldata|raw\s+transaction|transaction\s+data|0x[a-f0-9]{32,})\b|我可以代签|我会代签|替你签名|帮你签名|我可以提交|我会提交|替你提交|帮你提交|帮我提交|替我提交|代我提交|代提交|自动执行|自动提交|代你提交|交易数据|调用数据/i

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

import { type Address, getAddress, isAddress } from "viem"
import type { AgentAmount, AgentIntent, AgentValidatorRef } from "../agent/types"
import {
  type AgentToolCall,
  type AgentToolDefinition,
  agentToolDefinitions,
  buildAgentRuntimeContext,
  buildAgentSystemPrompt,
} from "../agent/upstreamProtocol"
import { resolveAgentAuthRequired } from "../shared/agentAuth"
import { verifyRpcAccess } from "./accessStrategy"
import { readRpcSession } from "./authSession"
import {
  createRequestContext,
  logServerEvent,
  type RequestContext,
  redactUrl,
  truncateMessage,
  withRequestHeaders,
} from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

type AgentApiEnv = RpcGatewayEnv & {
  SAFECAFE_AGENT_AUTH?: string
  SAFECAFE_AGENT_TEST_VERIFIED_ACCESS?: string
  SAFECAFE_LLM_API_BASE?: string
  SAFECAFE_LLM_API_MODEL?: string
  SAFECAFE_LLM_API_KEY?: string
  SAFECAFE_LLM_TIMEOUT_MS?: string
  SAFECAFE_LLM_MAX_TOKENS?: string
  VITE_AGENT_AUTH?: string
}

type AgentApiRequest = {
  message?: unknown
  messages?: unknown
  context?: unknown
  stream?: unknown
}

type SanitizedRequest = {
  message: string
  messages: AgentHistoryMessage[]
  context: {
    account: string | null
    accountConnected: boolean
    subjectAccount: string | null
    subjectKind: "self" | "safe"
    chainId: unknown
    hasLiveSnapshot: boolean
    hasStakingPosition: boolean
    liveBlock: unknown
    stakingSummary: {
      safeBalance: string
      totalStaked: string
      pendingWithdrawals: string
      claimableWithdrawals: string
      claimableRewards: string
      withdrawDelaySeconds: string
    } | null
    stakingPositions: Array<{
      label: string
      status: "active" | "inactive"
      userStake: string
      commission: number | null
      participationRate: number | null
    }>
    validatorLabels: unknown[]
  }
  stream: boolean
}

type UpstreamMessage = {
  role: "assistant" | "system" | "tool" | "user"
  content: string | null
  tool_call_id?: string
  tool_calls?: AgentToolCall[]
}

type AgentToolEvent = {
  callId: string
  name: string
  status: "completed" | "failed" | "running"
  content: string
  data?: unknown
}

type AgentToolResult = AgentToolEvent & {
  modelContent: string
}

type StreamedToolCallDelta = {
  index: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

type StreamedToolCallAccumulator = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type AgentHistoryMessage = {
  role: "assistant" | "tool" | "user"
  content: string
}

type AgentConversationMessage = {
  role: "assistant" | "user"
  content: string
}

const maxBodyBytes = 24_000
const maxHistoryMessages = 24
const recentConversationMessages = 3
const maxHistoryMessageChars = 2_000
const maxSummaryChars = 1_200
const defaultUpstreamTimeoutMs = 30_000
const defaultUpstreamMaxTokens = 512
const rateLimitWindowMs = 60_000
const maxRequestsPerWindow = 20
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

export async function handleAgentApiRequest(request: Request, env: AgentApiEnv): Promise<Response> {
  const context = createRequestContext(request, "agent")
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, context, "method_not_allowed")
  if (isRateLimited(request)) {
    logServerEvent(context, "warn", "agent.rate_limited")
    return json({ error: "Too many Agent requests. Please slow down." }, 429, context, "rate_limited")
  }

  const parsed = await readAgentRequest(request)
  if (parsed.status !== "ok") {
    logServerEvent(context, "warn", "agent.request.invalid", { reason: parsed.error, status: parsed.status })
    return json({ error: parsed.error }, parsed.status, context, "invalid_agent_request")
  }

  const access = await verifyAgentAccess(request, parsed.value, env)
  const fallback = lockedOrFallbackReply(access)
  if (fallback) {
    logServerEvent(context, "warn", "agent.access.locked", { reason: access.reason })
    return agentResponse(parsed.value, fallback.content, fallback.source, fallback.thinking, context)
  }

  const base = env.SAFECAFE_LLM_API_BASE
  const model = env.SAFECAFE_LLM_API_MODEL
  const apiKey = env.SAFECAFE_LLM_API_KEY
  if (!base || !model || !apiKey) {
    logServerEvent(context, "warn", "agent.llm.not_configured", {
      hasApiBase: Boolean(base),
      hasApiKey: Boolean(apiKey),
      hasModel: Boolean(model),
    })
    return agentResponse(
      parsed.value,
      "Agent LLM is not configured. I can still prepare supported staking actions locally after wallet data is loaded.",
      "fallback",
      undefined,
      context,
    )
  }
  const timeoutMs = readBoundedInteger(env.SAFECAFE_LLM_TIMEOUT_MS, defaultUpstreamTimeoutMs, 1_000, 60_000)
  const maxTokens = readBoundedInteger(env.SAFECAFE_LLM_MAX_TOKENS, defaultUpstreamMaxTokens, 64, 4_000)

  if (parsed.value.stream) {
    return streamingAgentResponse({
      apiKey,
      base,
      context,
      maxTokens,
      model,
      request: parsed.value,
      timeoutMs,
    })
  }
  const upstream = await callUpstream({
    apiKey,
    base,
    context,
    maxTokens,
    model,
    request: parsed.value,
    timeoutMs,
  })
  return agentResponse(parsed.value, upstream.content, upstream.source, upstream.thinking, context, upstream.tools)
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
            .filter((item): item is AgentHistoryMessage => isChatMessage(item))
            .slice(-maxHistoryMessages)
            .map((item) => ({ role: item.role, content: item.content.slice(0, maxHistoryMessageChars) }))
        : [],
      context,
      stream: body.stream === true || request.headers.get("accept")?.includes("text/event-stream") === true,
    },
  }
}

async function verifyAgentAccess(
  httpRequest: Request,
  request: SanitizedRequest,
  env: AgentApiEnv,
): Promise<{ status: "eligible" | "locked"; reason: string }> {
  if (env.SAFECAFE_AGENT_TEST_VERIFIED_ACCESS === "true") {
    return { status: "eligible", reason: "Test-only server-side eligibility override passed." }
  }
  if (!resolveAgentAuthRequired({ safecafeAgentAuth: env.SAFECAFE_AGENT_AUTH, viteAgentAuth: env.VITE_AGENT_AUTH })) {
    return { status: "eligible", reason: "Agent auth is disabled by configuration." }
  }
  if (!request.context.account || !isAddress(request.context.account)) {
    return {
      status: "locked",
      reason: "No valid wallet address was provided for server-side eligibility verification.",
    }
  }
  if (!request.context.subjectAccount || !isAddress(request.context.subjectAccount)) {
    return {
      status: "locked",
      reason: "No valid staking subject address was provided for server-side eligibility verification.",
    }
  }
  try {
    const signer = getAddress(request.context.account)
    const subject = getAddress(request.context.subjectAccount)
    const session = await readRpcSession(httpRequest, env)
    if (!session) {
      return { status: "locked", reason: "Authenticated wallet session is required for live Agent access." }
    }
    if (
      session.signer.toLowerCase() !== signer.toLowerCase() ||
      session.subject.toLowerCase() !== subject.toLowerCase()
    ) {
      return { status: "locked", reason: "Authenticated wallet session does not match the requested staking account." }
    }
    return (await verifyRpcAccess({ signer, subject }, env))
      ? { status: "eligible", reason: "Server-side Agent access strategy check passed." }
      : { status: "locked", reason: "Requested wallet does not satisfy the configured Agent access strategy." }
  } catch {
    return { status: "locked", reason: "Server-side eligibility check failed." }
  }
}

function lockedOrFallbackReply(access: {
  status: "eligible" | "locked"
  reason: string
}): { content: string; source: "fallback"; thinking?: string } | null {
  if (access.status === "eligible") return null
  return {
    content:
      "Connect a wallet with SAFE or an existing SAFE staking position to unlock live Agent guidance. Until then, I can show supported examples locally.",
    source: "fallback",
  }
}

async function callUpstream(params: {
  base: string
  apiKey: string
  context: RequestContext
  maxTokens: number
  model: string
  request: SanitizedRequest
  timeoutMs: number
}): Promise<{ content: string; source: "fallback" | "llm"; thinking?: string; tools?: AgentToolEvent[] }> {
  const controller = new AbortController()
  const startedAt = Date.now()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const messages = buildUpstreamMessages(params.request)
    const first = await callChatCompletion({
      apiKey: params.apiKey,
      base: params.base,
      maxTokens: params.maxTokens,
      messages,
      model: params.model,
      signal: controller.signal,
      tools: agentToolDefinitions,
    })
    if (!first.ok) {
      logServerEvent(params.context, "warn", "agent.upstream.http_error", {
        elapsedMs: Date.now() - startedAt,
        status: first.status,
        upstream: redactUrl(params.base),
      })
      return unavailableReply("Upstream Agent service returned an error.")
    }
    const data = (await first.json()) as unknown
    const message = readFirstChoicePart(data, "message")
    const toolCalls = readToolCalls(message)
    if (toolCalls.length) {
      const toolResults = toolCalls.map((toolCall) => executeAgentTool(toolCall, params.request.context))
      const second = await callChatCompletion({
        apiKey: params.apiKey,
        base: params.base,
        maxTokens: params.maxTokens,
        messages: [
          ...messages,
          {
            role: "assistant",
            content: readTextField(message, ["content"]) ?? null,
            tool_calls: toolCalls,
          },
          ...toolResults.map((result) => ({
            role: "tool" as const,
            tool_call_id: result.callId,
            content: result.modelContent,
          })),
        ],
        model: params.model,
        signal: controller.signal,
        tools: agentToolDefinitions,
      })
      if (!second.ok) {
        logServerEvent(params.context, "warn", "agent.upstream.tool_http_error", {
          elapsedMs: Date.now() - startedAt,
          status: second.status,
          upstream: redactUrl(params.base),
        })
        return unavailableReply("Upstream Agent service returned an error after tool execution.")
      }
      const finalData = (await second.json()) as unknown
      const finalMessage = readFirstChoicePart(finalData, "message")
      logServerEvent(params.context, "info", "agent.upstream.tool_success", {
        elapsedMs: Date.now() - startedAt,
        tools: toolResults.map((tool) => tool.name),
        upstream: redactUrl(params.base),
      })
      return {
        content: sanitizeAgentContent(readTextField(finalMessage, ["content"])),
        source: "llm",
        thinking: sanitizeOptionalText(readReasoningText(finalMessage)),
        tools: toolResults.flatMap((tool) => [
          { ...tool, content: `Running ${tool.name}.`, status: "running" as const },
          tool,
        ]),
      }
    }
    logServerEvent(params.context, "info", "agent.upstream.success", {
      elapsedMs: Date.now() - startedAt,
      upstream: redactUrl(params.base),
    })
    return {
      content: sanitizeAgentContent(readTextField(message, ["content"])),
      source: "llm",
      thinking: sanitizeOptionalText(readReasoningText(message)),
    }
  } catch (error) {
    logServerEvent(params.context, "warn", "agent.upstream.unavailable", {
      elapsedMs: Date.now() - startedAt,
      error: truncateMessage(error instanceof Error ? error.message : String(error)),
      name: error instanceof Error ? error.name : "Error",
      upstream: redactUrl(params.base),
    })
    return unavailableReply("Upstream Agent service timed out or could not be reached.")
  } finally {
    clearTimeout(timer)
  }
}

function callChatCompletion(params: {
  apiKey: string
  base: string
  maxTokens: number
  messages: UpstreamMessage[]
  model: string
  signal: AbortSignal
  stream?: boolean
  tools?: AgentToolDefinition[]
}) {
  return fetch(`${params.base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      stream: params.stream === true,
      temperature: 0.2,
      max_tokens: params.maxTokens,
      messages: params.messages,
      ...(params.tools?.length ? { tools: params.tools, tool_choice: "auto" } : {}),
    }),
    signal: params.signal,
  })
}

function readToolCalls(input: unknown): AgentToolCall[] {
  const record = readRecord(input)
  if (!record || !Array.isArray(record.tool_calls)) return []
  return record.tool_calls
    .map((item) => {
      const toolCall = readRecord(item)
      const fn = readRecord(toolCall?.function)
      if (toolCall?.type !== "function") return null
      if (typeof toolCall.id !== "string" || typeof fn?.name !== "string") return null
      return {
        id: toolCall.id.slice(0, 120),
        type: "function" as const,
        function: {
          name: fn.name.slice(0, 120),
          arguments: typeof fn.arguments === "string" ? fn.arguments.slice(0, 2000) : "{}",
        },
      }
    })
    .filter((item): item is AgentToolCall => Boolean(item))
    .slice(0, 4)
}

function executeAgentTool(toolCall: AgentToolCall, context: SanitizedRequest["context"]): AgentToolResult {
  const name = toolCall.function.name
  if (name === "get_staking_context") {
    const data = buildAgentRuntimeContext(context)
    return {
      callId: toolCall.id,
      name,
      status: "completed",
      content: "Loaded current SAFE staking context.",
      data,
      modelContent: JSON.stringify(data),
    }
  }
  if (name === "refresh_live_staking_context") {
    const data = {
      clientAction: "refresh-live-staking-context",
      reason: readRefreshReason(toolCall.function.arguments),
    }
    return {
      callId: toolCall.id,
      name,
      status: "completed",
      content: "Requested a live staking data refresh in the app.",
      data,
      modelContent: JSON.stringify({
        ...data,
        note: "The client app will perform the live refresh, update the page, and show the refreshed account summary to the user.",
      }),
    }
  }
  if (name === "list_supported_staking_actions") {
    const data = {
      actions: ["stake", "unstake", "claim_withdrawal", "claim_rewards", "restake_rewards", "rebalance"],
      requiresWalletConfirmation: true,
      cannotSignOrSubmitForUser: true,
    }
    return {
      callId: toolCall.id,
      name,
      status: "completed",
      content: "Loaded supported SAFE staking actions.",
      data,
      modelContent: JSON.stringify(data),
    }
  }
  if (name === "prepare_staking_action") {
    const intent = parsePreparedStakingIntent(toolCall.function.arguments, context.validatorLabels)
    if (!intent.ok) {
      const data = { error: intent.error }
      return {
        callId: toolCall.id,
        name,
        status: "failed",
        content: intent.error,
        data,
        modelContent: JSON.stringify(data),
      }
    }
    const data = { intent: intent.value, requiresWalletConfirmation: true }
    return {
      callId: toolCall.id,
      name,
      status: "completed",
      content: "Prepared staking action for wallet review.",
      data,
      modelContent: JSON.stringify(data),
    }
  }
  const data = { error: "Unsupported Agent tool." }
  return {
    callId: toolCall.id,
    name,
    status: "failed",
    content: "Unsupported Agent tool.",
    data,
    modelContent: JSON.stringify(data),
  }
}

function readRefreshReason(rawArguments: string) {
  const args = parseToolArguments(rawArguments)
  const reason = typeof args?.reason === "string" ? args.reason.trim() : ""
  return reason.slice(0, 160)
}

function parsePreparedStakingIntent(
  rawArguments: string,
  validatorLabels: unknown[],
): { ok: true; value: AgentIntent } | { ok: false; error: string } {
  const args = parseToolArguments(rawArguments)
  if (!args) return { ok: false, error: "Invalid staking action arguments." }
  const kind = typeof args.kind === "string" ? args.kind : ""
  if (kind === "claim-withdrawal") return { ok: true, value: { kind } }
  if (kind === "claim-rewards") return { ok: true, value: { kind } }
  if (kind === "stake" || kind === "unstake") {
    const amount = parseToolAmount(args.amount)
    const validator = parseToolValidator(args.validator, validatorLabels)
    if (!amount || !validator) return { ok: false, error: "Amount and validator are required for this action." }
    return { ok: true, value: { kind, amount, validator } }
  }
  if (kind === "restake-rewards") {
    const validator =
      parseToolValidator(args.validator, validatorLabels) ?? parseToolValidator(args.toValidator, validatorLabels)
    if (!validator) return { ok: false, error: "Destination validator is required for restaking rewards." }
    return { ok: true, value: { kind, amount: { type: "all-claimable-rewards" }, validator } }
  }
  if (kind === "rebalance") {
    const amount = parseToolAmount(args.amount)
    const from = parseToolValidator(args.fromValidator, validatorLabels)
    const to = parseToolValidator(args.toValidator, validatorLabels)
    if (!amount || !from || !to) {
      return { ok: false, error: "Amount, source validator, and destination validator are required for rebalancing." }
    }
    return { ok: true, value: { kind, amount, from, to } }
  }
  return { ok: false, error: "Unsupported staking action kind." }
}

function parseToolArguments(rawArguments: string): Record<string, unknown> | null {
  try {
    return readRecord(JSON.parse(rawArguments || "{}"))
  } catch {
    return null
  }
}

function parseToolAmount(input: unknown): AgentAmount | null {
  const record = readRecord(input)
  const type = typeof record?.type === "string" ? record.type : ""
  if (type === "all-wallet" || type === "all-validator-stake" || type === "all-claimable-rewards") return { type }
  if (type === "safe") {
    const value = typeof record?.value === "string" ? record.value.trim() : null
    return value && /^\d+(?:\.\d{1,18})?$/.test(value) ? { type, value } : null
  }
  if (type === "percent-wallet" || type === "percent-validator-stake") {
    const value = typeof record?.value === "number" ? record.value : Number(record?.value)
    return Number.isFinite(value) && value > 0 && value <= 100 ? { type, value } : null
  }
  return null
}

function parseToolValidator(input: unknown, validatorLabels: unknown[]): AgentValidatorRef | null {
  const record = readRecord(input)
  const type = typeof record?.type === "string" ? record.type : ""
  if (type === "best-active") return { type }
  const value = typeof record?.value === "string" ? record.value.trim() : ""
  if (type === "address") return isAddress(value) ? { type, value: getAddress(value) as Address } : null
  if (type === "label" && value) {
    const labels = validatorLabels.filter((label): label is string => typeof label === "string")
    const match = labels.find((label) => label.toLowerCase() === value.toLowerCase())
    return match ? { type, value: match } : null
  }
  return null
}

function streamingAgentResponse(params: {
  apiKey: string
  base: string
  context: RequestContext
  maxTokens: number
  model: string
  request: SanitizedRequest
  timeoutMs: number
}) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now()
      const controllerAbort = new AbortController()
      const timer = setTimeout(() => controllerAbort.abort(), params.timeoutMs)
      try {
        const messages = buildUpstreamMessages(params.request)
        const upstream = await callChatCompletion({
          apiKey: params.apiKey,
          base: params.base,
          maxTokens: params.maxTokens,
          messages,
          model: params.model,
          signal: controllerAbort.signal,
          stream: true,
          tools: agentToolDefinitions,
        })
        if (!upstream.ok || !upstream.body) {
          logServerEvent(params.context, "warn", "agent.upstream.stream_http_error", {
            elapsedMs: Date.now() - startedAt,
            status: upstream.status,
            upstream: redactUrl(params.base),
          })
          writeFinalStream(controller, encoder, unavailableReply("Upstream Agent service returned an error."))
          return
        }
        const first = await forwardUpstreamStream(upstream.body, controller, encoder)
        const firstToolCalls = first.toolCalls ?? []
        if (firstToolCalls.length) {
          const toolResults = firstToolCalls.map((toolCall) => executeAgentTool(toolCall, params.request.context))
          for (const tool of toolResults) {
            sendStreamEvent(controller, encoder, {
              type: "tool",
              ...tool,
              content: `Running ${tool.name}.`,
              status: "running",
            })
            sendStreamEvent(controller, encoder, { type: "tool", ...tool })
          }
          const second = await callChatCompletion({
            apiKey: params.apiKey,
            base: params.base,
            maxTokens: params.maxTokens,
            messages: [
              ...messages,
              {
                role: "assistant",
                content: first.content.trim() ? first.content : null,
                tool_calls: firstToolCalls,
              },
              ...toolResults.map((result) => ({
                role: "tool" as const,
                tool_call_id: result.callId,
                content: result.modelContent,
              })),
            ],
            model: params.model,
            signal: controllerAbort.signal,
            stream: true,
            tools: agentToolDefinitions,
          })
          if (!second.ok || !second.body) {
            logServerEvent(params.context, "warn", "agent.upstream.stream_tool_http_error", {
              elapsedMs: Date.now() - startedAt,
              status: second.status,
              upstream: redactUrl(params.base),
            })
            writeFinalStream(
              controller,
              encoder,
              unavailableReply("Upstream Agent service returned an error after tool execution."),
            )
            return
          }
          const final = await forwardUpstreamStream(second.body, controller, encoder)
          logServerEvent(params.context, "info", "agent.upstream.stream_tool_success", {
            elapsedMs: Date.now() - startedAt,
            tools: toolResults.map((tool) => tool.name),
            upstream: redactUrl(params.base),
          })
          writeFinalEvent(controller, encoder, {
            content: final.content || "I can help prepare a staking action for wallet review.",
            source: "llm",
          })
          return
        }
        logServerEvent(params.context, "info", "agent.upstream.stream_orchestrated", {
          elapsedMs: Date.now() - startedAt,
          upstream: redactUrl(params.base),
        })
        writeFinalEvent(controller, encoder, {
          content: first.content || "I can help prepare a staking action for wallet review.",
          source: "llm",
        })
      } catch (error) {
        logServerEvent(params.context, "warn", "agent.upstream.stream_unavailable", {
          elapsedMs: Date.now() - startedAt,
          error: truncateMessage(error instanceof Error ? error.message : String(error)),
          name: error instanceof Error ? error.name : "Error",
          upstream: redactUrl(params.base),
        })
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
  return withRequestHeaders(
    new Response(stream, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    }),
    params.context,
  )
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
  let thinking = ""
  const toolCalls = new Map<number, StreamedToolCallAccumulator>()
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
      mergeToolCallDeltas(toolCalls, delta.toolCalls)
      if (delta.thinking) {
        thinking += delta.thinking
        const safeThinking = sanitizeOptionalText(thinking)
        if (safeThinking) sendStreamEvent(controller, encoder, { type: "thinking", content: safeThinking })
      }
      if (!delta.content) continue
      final += delta.content
      if (containsUnsafeAgentContent(final)) {
        return {
          content:
            "I can only help prepare reviewable staking actions. Every on-chain action must be confirmed in your wallet.",
          thinking: sanitizeOptionalText(thinking),
        }
      }
      for (const chunk of chunkText(delta.content, 32)) {
        sendStreamEvent(controller, encoder, { type: "delta", content: chunk })
      }
    }
  }
  return {
    content: sanitizeAgentContent(final),
    thinking: sanitizeOptionalText(thinking),
    toolCalls: finalizeStreamedToolCalls(toolCalls),
  }
}

function parseUpstreamDelta(data: string) {
  try {
    const parsed = JSON.parse(data) as unknown
    const delta = readFirstChoicePart(parsed, "delta")
    const message = readFirstChoicePart(parsed, "message")
    return {
      content: readTextField(delta, ["content"]) ?? readTextField(message, ["content"]) ?? "",
      thinking: readReasoningText(delta) ?? readReasoningText(message) ?? readReasoningText(parsed) ?? "",
      toolCalls: readStreamedToolCallDeltas(delta) ?? readStreamedToolCallDeltas(message) ?? [],
    }
  } catch {
    return { content: "", thinking: "", toolCalls: [] }
  }
}

function readStreamedToolCallDeltas(input: unknown): StreamedToolCallDelta[] | null {
  const record = readRecord(input)
  if (!record || !Array.isArray(record.tool_calls)) return null
  const deltas: StreamedToolCallDelta[] = []
  for (const item of record.tool_calls) {
    const toolCall = readRecord(item)
    if (!toolCall) continue
    const index = typeof toolCall.index === "number" && Number.isSafeInteger(toolCall.index) ? toolCall.index : null
    if (index === null || index < 0) continue
    const fn = readRecord(toolCall.function)
    const delta: StreamedToolCallDelta = { index }
    if (typeof toolCall.id === "string") delta.id = toolCall.id.slice(0, 120)
    if (typeof toolCall.type === "string") delta.type = toolCall.type.slice(0, 40)
    if (fn) {
      const functionDelta: NonNullable<StreamedToolCallDelta["function"]> = {}
      if (typeof fn.name === "string") functionDelta.name = fn.name.slice(0, 120)
      if (typeof fn.arguments === "string") functionDelta.arguments = fn.arguments.slice(0, 2000)
      if (Object.keys(functionDelta).length > 0) delta.function = functionDelta
    }
    deltas.push(delta)
  }
  return deltas
}

function mergeToolCallDeltas(toolCalls: Map<number, StreamedToolCallAccumulator>, deltas: StreamedToolCallDelta[]) {
  for (const delta of deltas) {
    const current =
      toolCalls.get(delta.index) ??
      ({
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      } satisfies StreamedToolCallAccumulator)
    if (delta.id) current.id = delta.id
    if (delta.type === "function") current.type = "function"
    if (delta.function?.name) {
      current.function.name = current.function.name
        ? `${current.function.name}${delta.function.name}`
        : delta.function.name
    }
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments
    toolCalls.set(delta.index, current)
  }
}

function finalizeStreamedToolCalls(toolCalls: Map<number, StreamedToolCallAccumulator>): AgentToolCall[] {
  return Array.from(toolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || "{}",
      },
    }))
    .filter((toolCall) => toolCall.id && toolCall.function.name)
    .slice(0, 4)
}

function readFirstChoicePart(input: unknown, key: "delta" | "message") {
  const choices = readRecord(input)?.choices
  if (!Array.isArray(choices)) return null
  const firstChoice = readRecord(choices[0])
  return readRecord(firstChoice?.[key])
}

function readTextField(input: unknown, keys: string[]) {
  const record = readRecord(input)
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

function readReasoningText(input: unknown) {
  const record = readRecord(input)
  if (!record) return null
  const direct = readTextField(record, [
    "reasoning_content",
    "reasoningContent",
    "reasoning",
    "thinking",
    "thoughts",
    "reasoning_summary",
    "reasoningSummary",
  ])
  if (direct) return direct
  return (
    readNestedText(record.reasoning_details) ??
    readNestedText(record.reasoningDetails) ??
    readNestedText(record.reasoning) ??
    readNestedText(record.thinking)
  )
}

function readNestedText(input: unknown): string | null {
  if (typeof input === "string" && input.trim()) return input
  if (Array.isArray(input)) {
    const parts = input.map((item) => readNestedText(item)).filter((item): item is string => Boolean(item))
    return parts.length ? parts.join("\n") : null
  }
  const record = readRecord(input)
  if (!record) return null
  return readTextField(record, ["text", "content", "summary"]) ?? readNestedText(record.summary)
}

function readRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null
}

function sanitizeOptionalText(content: unknown) {
  if (typeof content !== "string" || !content.trim()) return undefined
  const trimmed = content.trim()
  if (unsafeOutputPattern.test(trimmed)) return undefined
  return trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}...` : trimmed
}

function writeFinalStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  reply: { content: string; source: "fallback" | "llm"; thinking?: string },
  tools: AgentToolEvent[] = [],
) {
  const content = sanitizeAgentContent(reply.content)
  const thinking = sanitizeOptionalText(reply.thinking)
  if (thinking) sendStreamEvent(controller, encoder, { type: "thinking", content: thinking })
  for (const tool of tools) sendStreamEvent(controller, encoder, { type: "tool", ...tool })
  for (const chunk of chunkText(content)) sendStreamEvent(controller, encoder, { type: "delta", content: chunk })
  sendStreamEvent(controller, encoder, { type: "final", content, source: reply.source })
}

function writeFinalEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  reply: { content: string; source: "fallback" | "llm" },
) {
  sendStreamEvent(controller, encoder, {
    type: "final",
    content: sanitizeAgentContent(reply.content),
    source: reply.source,
  })
}

function buildUpstreamMessages(request: SanitizedRequest): UpstreamMessage[] {
  const managedContext = manageConversationContext(request.messages)
  return [
    {
      role: "system",
      content: buildAgentSystemPrompt(),
    },
    {
      role: "system",
      content: `Runtime context for this request:\n${JSON.stringify(buildAgentRuntimeContext(request.context), null, 2)}`,
    },
    ...(managedContext.summary
      ? [{ role: "system" as const, content: `Managed conversation summary:\n${managedContext.summary}` }]
      : []),
    ...managedContext.messages,
    { role: "user", content: request.message },
  ]
}

function unavailableReply(reason: string) {
  void reason
  return {
    content: "The Agent service is unavailable. Local transaction checks are still available.",
    source: "fallback" as const,
  }
}

function agentResponse(
  request: SanitizedRequest,
  content: string,
  source: "fallback" | "llm",
  thinking?: string,
  context?: RequestContext,
  tools: AgentToolEvent[] = [],
): Response {
  const sanitizedContent = sanitizeAgentContent(content)
  const sanitizedThinking = sanitizeOptionalText(thinking)
  if (!request.stream)
    return json({ content: sanitizedContent, thinking: sanitizedThinking ?? "", source, tools }, 200, context)
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      if (sanitizedThinking) sendStreamEvent(controller, encoder, { type: "thinking", content: sanitizedThinking })
      for (const tool of tools) sendStreamEvent(controller, encoder, { type: "tool", ...tool })
      for (const chunk of chunkText(sanitizedContent)) {
        sendStreamEvent(controller, encoder, { type: "delta", content: chunk })
      }
      sendStreamEvent(controller, encoder, { type: "final", content: sanitizedContent, source })
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  const response = new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  })
  return context ? withRequestHeaders(response, context) : response
}

function sendStreamEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: unknown,
) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
}

function chunkText(content: string, size = 24) {
  const chunks: string[] = []
  for (let index = 0; index < content.length; index += size) chunks.push(content.slice(index, index + size))
  return chunks.length ? chunks : [""]
}

function manageConversationContext(messages: AgentHistoryMessage[]): {
  summary: string
  messages: AgentConversationMessage[]
} {
  const chatMessages = messages.filter(isConversationMessage)
  const recentMessages = chatMessages.slice(-recentConversationMessages).map((message) => ({
    role: message.role,
    content: compactContextText(message.content, maxHistoryMessageChars),
  }))
  const recentChatStart = Math.max(0, chatMessages.length - recentConversationMessages)
  let chatIndex = 0
  const summaryParts: string[] = []
  for (const message of messages) {
    if (message.role === "tool") {
      summaryParts.push(`tool: ${summarizeToolContent(message.content)}`)
      continue
    }
    if (chatIndex < recentChatStart) {
      summaryParts.push(`${message.role}: ${compactContextText(message.content, 180)}`)
    }
    chatIndex += 1
  }
  return {
    summary: compactContextText(summaryParts.join("\n"), maxSummaryChars),
    messages: recentMessages,
  }
}

function isConversationMessage(message: AgentHistoryMessage): message is AgentConversationMessage {
  return message.role === "assistant" || message.role === "user"
}

function summarizeToolContent(content: string) {
  const text = compactContextText(content, 220)
  return text || "tool step completed"
}

function compactContextText(content: string, maxLength: number) {
  const compacted = content.replace(/\s+/g, " ").trim()
  if (compacted.length <= maxLength) return compacted
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`
}

function isChatMessage(value: unknown): value is AgentHistoryMessage {
  if (typeof value !== "object" || value === null) return false
  const item = value as { role?: unknown; content?: unknown }
  return (item.role === "assistant" || item.role === "tool" || item.role === "user") && typeof item.content === "string"
}

function summarizeContext(value: unknown): SanitizedRequest["context"] {
  if (typeof value !== "object" || value === null) {
    return {
      account: null,
      accountConnected: false,
      subjectAccount: null,
      subjectKind: "self",
      chainId: null,
      hasLiveSnapshot: false,
      hasStakingPosition: false,
      liveBlock: null,
      stakingSummary: null,
      stakingPositions: [],
      validatorLabels: [],
    }
  }
  const context = value as Record<string, unknown>
  const account = typeof context.account === "string" && isAddress(context.account) ? getAddress(context.account) : null
  const subjectAccount =
    typeof context.subjectAccount === "string" && isAddress(context.subjectAccount)
      ? getAddress(context.subjectAccount)
      : null
  return {
    account,
    accountConnected: typeof context.account === "string",
    subjectAccount,
    subjectKind: context.subjectKind === "safe" ? "safe" : "self",
    chainId: context.chainId ?? null,
    liveBlock: context.liveBlock ?? null,
    hasLiveSnapshot: Boolean(context.hasLiveSnapshot),
    hasStakingPosition: Boolean(context.hasStakingPosition),
    stakingSummary: summarizeStakingSummary(context.stakingSummary),
    stakingPositions: summarizeStakingPositions(context.stakingPositions),
    validatorLabels: Array.isArray(context.validatorLabels) ? context.validatorLabels.slice(0, 20) : [],
  }
}

function summarizeStakingSummary(value: unknown): SanitizedRequest["context"]["stakingSummary"] {
  const record = readRecord(value)
  if (!record) return null
  return {
    safeBalance: sanitizeDecimalString(record.safeBalance),
    totalStaked: sanitizeDecimalString(record.totalStaked),
    pendingWithdrawals: sanitizeDecimalString(record.pendingWithdrawals),
    claimableWithdrawals: sanitizeDecimalString(record.claimableWithdrawals),
    claimableRewards: sanitizeDecimalString(record.claimableRewards),
    withdrawDelaySeconds: sanitizeIntegerString(record.withdrawDelaySeconds),
  }
}

function summarizeStakingPositions(value: unknown): SanitizedRequest["context"]["stakingPositions"] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = readRecord(item)
      if (!record) return null
      const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : ""
      const userStake = sanitizeDecimalString(record.userStake)
      if (!label || userStake === "0") return null
      return {
        label,
        status: record.status === "inactive" ? "inactive" : "active",
        userStake,
        commission: sanitizeFiniteNumber(record.commission),
        participationRate: sanitizeFiniteNumber(record.participationRate),
      }
    })
    .filter((item): item is SanitizedRequest["context"]["stakingPositions"][number] => Boolean(item))
    .slice(0, 20)
}

function sanitizeDecimalString(value: unknown) {
  if (typeof value !== "string") return "0"
  const trimmed = value.trim()
  return /^\d+(\.\d{1,18})?$/.test(trimmed) ? trimmed.slice(0, 80) : "0"
}

function sanitizeIntegerString(value: unknown) {
  if (typeof value !== "string") return "0"
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? trimmed.slice(0, 40) : "0"
}

function sanitizeFiniteNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.round(value * 100) / 100
}

export function sanitizeAgentContent(content: unknown) {
  if (typeof content !== "string" || !content.trim()) return "I can help prepare a staking action for wallet review."
  const trimmed = content.trim()
  if (containsUnsafeAgentContent(trimmed)) {
    return "I can only help prepare reviewable staking actions. Every on-chain action must be confirmed in your wallet."
  }
  return trimmed
}

function containsUnsafeAgentContent(content: string) {
  return unsafeOutputPattern.test(content)
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

function readBoundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const unsafeOutputPattern =
  /\b(i\s+can\s+sign|i\s+will\s+sign|i'?ll\s+sign|sign\s+for\s+you|sign\s+on\s+your\s+behalf|i\s+can\s+submit|i\s+will\s+submit|i'?ll\s+submit|submit\s+for\s+you|submit\s+the\s+transaction\s+for\s+you|send\s+the\s+transaction\s+for\s+you|execute\s+automatically|automatically\s+execute|auto-?sign|call\s+data|calldata|raw\s+transaction|transaction\s+data|0x[a-f0-9]{32,})\b|我可以代签|我会代签|替你签名|帮你签名|我可以提交|我会提交|替你提交|帮你提交|帮我提交|替我提交|代我提交|代提交|自动执行|自动提交|代你提交|交易数据|调用数据/i

function json(data: unknown, status: number, context?: RequestContext, errorCode?: string) {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
  return context ? withRequestHeaders(response, context, errorCode) : response
}

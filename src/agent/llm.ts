import { type Address, getAddress, isAddress } from "viem"
import { formatSafeInput } from "../protocol"
import type { AgentAmount, AgentContext, AgentIntent, AgentValidatorRef } from "./types"
import {
  type AgentToolCall,
  agentToolDefinitions,
  buildAgentRuntimeContext,
  buildAgentSystemPrompt,
} from "./upstreamProtocol"

export type AgentChatRole = "assistant" | "tool" | "user"

export type UserLlmConfig = {
  apiBase: string
  apiKey: string
  maxTokens: number
  model: string
}

export type AgentChatRequest = {
  authToken?: string | null
  message: string
  messages: Array<{ role: AgentChatRole; content: string }>
  context: Pick<AgentContext, "account" | "chainId"> & {
    accountConnected: boolean
    agentAccess: "eligible" | "locked"
    liveBlock: string | null
    hasLiveSnapshot: boolean
    hasStakingPosition: boolean
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
      commission: number
      participationRate: number
    }>
    subjectAccount: string | null
    subjectKind: "safe" | "self"
    validatorLabels: string[]
  }
}

export type AgentChatResponse = {
  content: string
  thinking?: string
  source: "llm" | "fallback"
}

export type AgentStreamEvent =
  | { type: "thinking"; content: string }
  | {
      type: "tool"
      callId: string
      name: string
      status: "completed" | "failed" | "running"
      content: string
      data?: unknown
    }
  | { type: "delta"; content: string }
  | { type: "final"; content: string; source: AgentChatResponse["source"] }

export async function requestAgentReply(request: AgentChatRequest): Promise<AgentChatResponse> {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: agentRequestHeaders(request.authToken),
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Agent API failed: ${response.status}`)
  return (await response.json()) as AgentChatResponse
}

export async function requestAgentReplyStream(
  request: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
  userLlm?: UserLlmConfig | null,
): Promise<void> {
  if (userLlm) {
    await requestUserLlmReplyStream(request, userLlm, onEvent, signal)
    return
  }
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { ...agentRequestHeaders(request.authToken), accept: "text/event-stream" },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  })
  if (!response.ok) throw new Error(`Agent API failed: ${response.status}`)
  const contentType = response.headers.get("content-type") ?? ""
  if (!response.body || !contentType.includes("text/event-stream")) {
    const reply = (await response.json()) as AgentChatResponse
    if (reply.thinking) onEvent({ type: "thinking", content: reply.thinking })
    onEvent({ type: "final", content: reply.content, source: reply.source })
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
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
      onEvent(JSON.parse(dataLine) as AgentStreamEvent)
    }
  }
}

type UpstreamMessage = {
  role: "assistant" | "system" | "tool" | "user"
  content: string | null
  tool_call_id?: string
  tool_calls?: AgentToolCall[]
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

type AgentToolResult = Extract<AgentStreamEvent, { type: "tool" }> & {
  modelContent: string
}

async function requestUserLlmReplyStream(
  request: AgentChatRequest,
  config: UserLlmConfig,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
) {
  const messages = buildUserLlmMessages(request)
  const first = await callUserLlmChatCompletion({ config, messages, signal, tools: true })
  const firstResult = await forwardUserLlmStream(first, onEvent)
  const firstToolCalls = firstResult.toolCalls ?? []
  if (firstToolCalls.length === 0) {
    onEvent({ type: "final", content: firstResult.content || defaultAgentReply(), source: "llm" })
    return
  }

  const toolResults = firstToolCalls.map((toolCall) => executeUserLlmTool(toolCall, request.context))
  for (const tool of toolResults) {
    onEvent({
      type: "tool",
      callId: tool.callId,
      name: tool.name,
      status: "running",
      content: `Running ${tool.name}.`,
    })
    onEvent(tool)
  }
  const second = await callUserLlmChatCompletion({
    config,
    messages: [
      ...messages,
      {
        role: "assistant",
        content: firstResult.content.trim() ? firstResult.content : null,
        tool_calls: firstToolCalls,
      },
      ...toolResults.map((tool) => ({
        role: "tool" as const,
        tool_call_id: tool.callId,
        content: tool.modelContent,
      })),
    ],
    signal,
    tools: true,
  })
  const final = await forwardUserLlmStream(second, onEvent)
  onEvent({ type: "final", content: final.content || defaultAgentReply(), source: "llm" })
}

async function callUserLlmChatCompletion(params: {
  config: UserLlmConfig
  messages: UpstreamMessage[]
  signal?: AbortSignal
  tools: boolean
}) {
  const response = await fetch(`${params.config.apiBase.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.config.model,
      stream: true,
      temperature: 0.2,
      max_tokens: params.config.maxTokens,
      messages: params.messages,
      ...(params.tools ? { tools: agentToolDefinitions, tool_choice: "auto" } : {}),
    }),
    signal: params.signal,
  })
  if (!response.ok || !response.body) throw new Error(`User LLM API failed: ${response.status}`)
  return response.body
}

async function forwardUserLlmStream(body: ReadableStream<Uint8Array>, onEvent: (event: AgentStreamEvent) => void) {
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
      const delta = parseUserLlmDelta(dataLine)
      mergeToolCallDeltas(toolCalls, delta.toolCalls)
      if (delta.thinking) {
        thinking += delta.thinking
        const safeThinking = sanitizeOptionalText(thinking)
        if (safeThinking) onEvent({ type: "thinking", content: safeThinking })
      }
      if (!delta.content) continue
      final += delta.content
      if (containsUnsafeAgentContent(final)) {
        return {
          content:
            "I can only help prepare reviewable staking actions. Every on-chain action must be confirmed in your wallet.",
          thinking: sanitizeOptionalText(thinking),
          toolCalls: finalizeStreamedToolCalls(toolCalls),
        }
      }
      for (const chunk of chunkText(delta.content, 32)) onEvent({ type: "delta", content: chunk })
    }
  }
  return {
    content: sanitizeAgentContent(final),
    thinking: sanitizeOptionalText(thinking),
    toolCalls: finalizeStreamedToolCalls(toolCalls),
  }
}

function buildUserLlmMessages(request: AgentChatRequest): UpstreamMessage[] {
  return [
    { role: "system", content: buildAgentSystemPrompt() },
    {
      role: "system",
      content: `Runtime context for this request:\n${JSON.stringify(buildAgentRuntimeContext(request.context), null, 2)}`,
    },
    ...request.messages
      .filter((message) => message.role === "assistant" || message.role === "user")
      .slice(-8)
      .map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: request.message },
  ]
}

function executeUserLlmTool(toolCall: AgentToolCall, context: AgentChatRequest["context"]): AgentToolResult {
  const name = toolCall.function.name
  if (name === "get_staking_context") {
    const data = buildAgentRuntimeContext(context)
    return {
      type: "tool",
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
      type: "tool",
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
      type: "tool",
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
        type: "tool",
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
      type: "tool",
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
    type: "tool",
    callId: toolCall.id,
    name,
    status: "failed",
    content: "Unsupported Agent tool.",
    data,
    modelContent: JSON.stringify(data),
  }
}

function parseUserLlmDelta(data: string) {
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

function sanitizeAgentContent(content: unknown) {
  if (typeof content !== "string" || !content.trim()) return defaultAgentReply()
  const trimmed = content.trim()
  if (containsUnsafeAgentContent(trimmed)) {
    return "I can only help prepare reviewable staking actions. Every on-chain action must be confirmed in your wallet."
  }
  return trimmed
}

function containsUnsafeAgentContent(content: string) {
  return unsafeOutputPattern.test(content)
}

function chunkText(content: string, size = 24) {
  const chunks: string[] = []
  for (let index = 0; index < content.length; index += size) chunks.push(content.slice(index, index + size))
  return chunks.length ? chunks : [""]
}

function defaultAgentReply() {
  return "I can help prepare a staking action for wallet review."
}

const unsafeOutputPattern =
  /\b(i\s+can\s+sign|i\s+will\s+sign|i'?ll\s+sign|sign\s+for\s+you|sign\s+on\s+your\s+behalf|i\s+can\s+submit|i\s+will\s+submit|i'?ll\s+submit|submit\s+for\s+you|submit\s+the\s+transaction\s+for\s+you|send\s+the\s+transaction\s+for\s+you|execute\s+automatically|automatically\s+execute|auto-?sign|call\s+data|calldata|raw\s+transaction|transaction\s+data|0x[a-f0-9]{32,})\b|我可以代签|我会代签|替你签名|帮你签名|我可以提交|我会提交|替你提交|帮你提交|帮我提交|替我提交|代我提交|代提交|自动执行|自动提交|代你提交|交易数据|调用数据/i

function agentRequestHeaders(authToken: string | null | undefined) {
  return {
    "content-type": "application/json",
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
  }
}

export function toAgentChatContext(context: AgentContext): AgentChatRequest["context"] {
  return {
    account: context.account,
    accountConnected: Boolean(context.account),
    subjectAccount: context.subjectAccount ?? null,
    subjectKind: context.subjectKind ?? "self",
    agentAccess: hasAgentServiceAccess(context) ? "eligible" : "locked",
    chainId: context.chainId,
    liveBlock: context.liveBlock ? context.liveBlock.toString() : null,
    hasLiveSnapshot: Boolean(context.liveSnapshot),
    hasStakingPosition: context.summary.totalStaked > 0n,
    stakingSummary: context.liveSnapshot
      ? {
          safeBalance: formatSafeInput(context.summary.safeBalance),
          totalStaked: formatSafeInput(context.summary.totalStaked),
          pendingWithdrawals: formatSafeInput(context.summary.pendingWithdrawals),
          claimableWithdrawals: formatSafeInput(context.summary.claimableWithdrawals),
          claimableRewards: formatSafeInput(context.summary.claimableRewards),
          withdrawDelaySeconds: context.summary.withdrawDelay.toString(),
        }
      : null,
    stakingPositions: context.liveSnapshot
      ? context.validators
          .filter((validator) => validator.userStake > 0n)
          .slice(0, 20)
          .map((validator) => ({
            label: validator.label,
            status: validator.status,
            userStake: formatSafeInput(validator.userStake),
            commission: validator.commission,
            participationRate: validator.participationRate,
          }))
      : [],
    validatorLabels: context.validators.map((validator) => validator.label),
  }
}

export function hasAgentServiceAccess(
  context: Pick<AgentContext, "account" | "liveSnapshot" | "summary" | "subjectAccount">,
): boolean {
  return Boolean(
    context.account &&
      context.subjectAccount &&
      context.liveSnapshot &&
      (context.summary.safeBalance > 0n || context.summary.totalStaked > 0n),
  )
}

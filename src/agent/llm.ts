import { formatSafeInput } from "../protocol"
import type { AgentContext } from "./types"

export type AgentChatRole = "assistant" | "tool" | "user"

export type AgentChatRequest = {
  authToken?: string | null
  message: string
  messages: Array<{ role: AgentChatRole; content: string }>
  context: Pick<AgentContext, "account" | "chainId" | "subjectAccount" | "subjectKind"> & {
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
): Promise<void> {
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

function agentRequestHeaders(authToken: string | null | undefined) {
  return {
    "content-type": "application/json",
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
  }
}

export function toAgentChatContext(context: AgentContext): AgentChatRequest["context"] {
  return {
    account: context.account,
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

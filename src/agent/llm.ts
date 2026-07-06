import type { AgentContext } from "./types"

export type AgentChatRole = "assistant" | "user"

export type AgentChatRequest = {
  message: string
  messages: Array<{ role: AgentChatRole; content: string }>
  context: Pick<AgentContext, "account" | "chainId"> & {
    agentAccess: "eligible" | "locked"
    liveBlock: string | null
    hasLiveSnapshot: boolean
    hasStakingPosition: boolean
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
  | { type: "delta"; content: string }
  | { type: "final"; content: string; source: AgentChatResponse["source"] }

export async function requestAgentReply(request: AgentChatRequest): Promise<AgentChatResponse> {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Agent API failed: ${response.status}`)
  return (await response.json()) as AgentChatResponse
}

export async function requestAgentReplyStream(
  request: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ ...request, stream: true }),
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

export function toAgentChatContext(context: AgentContext): AgentChatRequest["context"] {
  return {
    account: context.account,
    agentAccess: hasAgentServiceAccess(context) ? "eligible" : "locked",
    chainId: context.chainId,
    liveBlock: context.liveBlock ? context.liveBlock.toString() : null,
    hasLiveSnapshot: Boolean(context.liveSnapshot),
    hasStakingPosition: context.summary.totalStaked > 0n,
    validatorLabels: context.validators.map((validator) => validator.label),
  }
}

export function hasAgentServiceAccess(context: Pick<AgentContext, "account" | "liveSnapshot" | "summary">): boolean {
  return Boolean(
    context.account && context.liveSnapshot && (context.summary.safeBalance > 0n || context.summary.totalStaked > 0n),
  )
}

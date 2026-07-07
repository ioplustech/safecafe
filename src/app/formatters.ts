import { parseSafeAmount, type TxPlan } from "../protocol"
import type { MessageBundle } from "./i18n"
import type { SafePriceState } from "./types"

export function safeParsedAmount(value: string): bigint | null {
  try {
    return parseSafeAmount(value)
  } catch {
    return null
  }
}

export function priceStatusLabel(price: SafePriceState, t: MessageBundle) {
  if (price.usd === null) return t.priceUnavailable
  const age = price.fetchedAt ? formatPriceAge(Date.now() - price.fetchedAt) : t.notChecked
  return `${price.source} · ${price.stale ? t.priceStale : t.priceCached} · ${age}`
}

export function translateTxLabel(label: string, t: MessageBundle) {
  const labels: Record<string, string> = {
    "Approve SAFE for staking contract": t.txApproveSafe,
    "Stake SAFE to validator": t.txStakeSafe,
    "Initiate withdrawal from validator": t.txInitiateWithdrawal,
    "Claim next FIFO withdrawal": t.txClaimWithdrawal,
    "Claim Merkle rewards": t.txClaimRewards,
  }
  return labels[label] ?? label
}

export function translateTxWarning(warning: string, t: MessageBundle) {
  const warnings: Record<string, string> = {
    "This plan needs approval before staking unless your wallet supports batching.": t.warningApprovalNeeded,
    "Withdrawals enter the protocol queue and become claimable after the delay.": t.warningWithdrawalQueue,
    "The staking contract claims withdrawals in FIFO order.": t.warningClaimFifo,
  }
  return warnings[warning] ?? warning
}

export function translateTxTitle(plan: TxPlan, t: MessageBundle) {
  if (plan.action === "stake") return `${t.txStakeTitle} ${plan.title.replace(/^Stake\s+/, "")}`
  if (plan.action === "unstake") return `${t.txUnstakeTitle} ${plan.title.replace(/^Unstake\s+/, "")}`
  if (plan.action === "claim-withdrawal") return t.txClaimWithdrawalTitle
  if (plan.action === "claim-rewards") return t.txClaimRewardsTitle
  if (plan.title === "Claim and stake rewards") return t.txClaimAndStakeRewardsTitle
  return plan.title
}

export function formatPriceAge(ageMs: number) {
  const minutes = Math.max(0, Math.floor(ageMs / 60000))
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

export function formatDelayLabel(seconds: bigint, t: MessageBundle) {
  const value = Number(seconds)
  const days = Math.floor(value / 86400)
  if (days > 0) return `${days} ${days === 1 ? t.day : t.days}`
  const hours = Math.floor(value / 3600)
  if (hours > 0) return `${hours} ${hours === 1 ? t.hour : t.hours}`
  const minutes = Math.floor(value / 60)
  return `${minutes} ${minutes === 1 ? t.minute : t.minutes}`
}

export function readableSimulationError(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "shortMessage" in error) {
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage
    if (typeof shortMessage === "string" && shortMessage.trim()) return shortMessage
  }
  if (typeof error === "object" && error !== null && "details" in error) {
    const details = (error as { details?: unknown }).details
    const parsed = readableJsonRpcError(details)
    if (parsed) return parsed
  }
  if (error instanceof Error) return readableJsonRpcError(error.message) ?? error.message
  return readableJsonRpcError(error) ?? fallback
}

function readableJsonRpcError(value: unknown) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return null
    const rpcError = (parsed as { error?: unknown }).error
    if (typeof rpcError !== "object" || rpcError === null) return null
    const code = (rpcError as { code?: unknown }).code
    const message = (rpcError as { message?: unknown }).message
    const codeText = typeof code === "number" || typeof code === "string" ? `RPC ${code}` : "RPC error"
    const data = (rpcError as { data?: unknown }).data
    const details = readableJsonRpcDetails(data)
    const summary = typeof message === "string" && message.trim() ? `${codeText}: ${message}` : codeText
    return details ? `${summary} (${details})` : summary
  } catch {
    return null
  }
}

function readableJsonRpcDetails(data: unknown) {
  if (typeof data !== "object" || data === null) return ""
  const parts: string[] = []
  const method = (data as { method?: unknown }).method
  const reason = (data as { reason?: unknown }).reason
  const requestId = (data as { requestId?: unknown }).requestId
  if (typeof method === "string" && method.trim()) parts.push(`method: ${method}`)
  if (typeof reason === "string" && reason.trim()) parts.push(`reason: ${reason}`)
  if (typeof requestId === "string" && requestId.trim()) parts.push(`request: ${requestId}`)
  return parts.join(", ")
}

export function merkleLabel(t: MessageBundle, matched: boolean | null) {
  if (matched === null) return t.merkleNotChecked
  return matched ? t.merkleMatched : t.merkleMismatch
}

export function stringifyBigInts<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))) as T
}

export function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

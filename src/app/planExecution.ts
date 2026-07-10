import { decodeFunctionData } from "viem"
import { stakingAbi, type TxPlan } from "../protocol"
import { reconcileTxPlanForExecution as reconcileSharedTxPlanForExecution } from "../shared/planReconcile"

export type PlanExecutionStepStatus = "cancelled" | "done" | "failed" | "pending" | "skipped"

export type PlanExecutionStep = {
  id: string
  label: string
  status: PlanExecutionStepStatus
}

export type PlanExecutionSummary = {
  actionKey: string
  completedCount: number
  currentLabel: string | null
  errorMessage: string
  pendingCount: number
  safeProposal?: SafeProposalSummary
  skippedCount: number
  status: "completed" | "failed" | "partial"
  steps: PlanExecutionStep[]
  title: string
  userRejected: boolean
}

export type SafeProposalSummary = {
  confirmations: number
  safeAddress: string
  safeTxHash: string
  status: "executed" | "pending"
  threshold: number
}

export function reconcileTxPlanForExecution(
  plan: TxPlan,
  input: {
    cumulativeClaimed: bigint
    stakingAllowance: bigint
  },
): {
  plan: TxPlan | null
  steps: PlanExecutionStep[]
} {
  const shared = reconcileSharedTxPlanForExecution(plan, input)
  return {
    plan: shared.plan,
    steps: shared.steps,
  }
}

export function isUserRejectedRequest(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const maybeCode = "code" in error ? (error as { code?: unknown }).code : null
    if (maybeCode === 4001 || maybeCode === "ACTION_REJECTED") return true
    const maybeShortMessage = "shortMessage" in error ? (error as { shortMessage?: unknown }).shortMessage : null
    if (typeof maybeShortMessage === "string" && rejectedText(maybeShortMessage)) return true
  }
  return error instanceof Error ? rejectedText(error.message) : false
}

export function isStakeTx(tx: TxPlan["txs"][number]) {
  if (tx.label !== "Stake SAFE to validator") return false
  try {
    const decoded = decodeFunctionData({
      abi: stakingAbi,
      data: tx.data,
    })
    return decoded.functionName === "stake"
  } catch {
    return false
  }
}

function rejectedText(value: string) {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.includes("user rejected") ||
    normalized.includes("user denied") ||
    normalized.includes("request rejected") ||
    normalized.includes("transaction rejected") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("rejected by user")
  )
}

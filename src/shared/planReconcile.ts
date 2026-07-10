import { decodeFunctionData } from "viem"
import { erc20Abi, merkleDropAbi, type TxPlan } from "../protocol"

export type ReconciledExecutionStep = {
  id: string
  label: string
  status: "pending" | "skipped"
}

export function reconcileTxPlanForExecution(
  plan: TxPlan,
  input: {
    cumulativeClaimed: bigint
    stakingAllowance: bigint
  },
): {
  plan: TxPlan | null
  steps: ReconciledExecutionStep[]
} {
  const steps: ReconciledExecutionStep[] = plan.txs.map((tx, index) => ({
    id: `${index}:${tx.label}`,
    label: tx.label,
    status: "pending",
  }))
  const txs = plan.txs.filter((tx, index) => {
    if (canSkipClaimRewards(tx, input.cumulativeClaimed)) {
      steps[index] = { ...steps[index], status: "skipped" }
      return false
    }
    if (canSkipApproval(tx, input.stakingAllowance)) {
      steps[index] = { ...steps[index], status: "skipped" }
      return false
    }
    return true
  })
  return {
    plan: txs.length
      ? {
          ...plan,
          simulation: undefined,
          txs,
        }
      : null,
    steps,
  }
}

function canSkipApproval(tx: TxPlan["txs"][number], stakingAllowance: bigint) {
  if (tx.label !== "Approve SAFE for staking contract") return false
  try {
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: tx.data,
    })
    if (decoded.functionName !== "approve") return false
    const amount = decoded.args?.[1]
    return typeof amount === "bigint" && stakingAllowance >= amount
  } catch {
    return false
  }
}

function canSkipClaimRewards(tx: TxPlan["txs"][number], cumulativeClaimed: bigint) {
  if (tx.label !== "Claim Merkle rewards") return false
  try {
    const decoded = decodeFunctionData({
      abi: merkleDropAbi,
      data: tx.data,
    })
    if (decoded.functionName !== "claim") return false
    const cumulativeAmount = decoded.args?.[1]
    return typeof cumulativeAmount === "bigint" && cumulativeClaimed >= cumulativeAmount
  } catch {
    return false
  }
}

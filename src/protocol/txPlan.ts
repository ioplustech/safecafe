import { type Address, encodeFunctionData, type Hex, parseUnits } from "viem"
import { erc20Abi, merkleDropAbi, stakingAbi } from "./abi"
import { CONTRACTS } from "./contracts"

export type PlannedTx = {
  label: string
  to: Address
  data: Hex
  value: bigint
}

export type TxPlanAction = "stake" | "unstake" | "claim-withdrawal" | "claim-rewards"

export type TxSimulation = {
  status: "passed" | "partial" | "failed"
  simulatedTxs: number
  message: string
}

export type TxPlan = {
  action: TxPlanAction
  title: string
  account?: Address
  txs: PlannedTx[]
  warnings: string[]
  simulation?: TxSimulation
}

export function parseSafeAmount(amount: string): bigint {
  const clean = amount.trim().replace(/,/g, "")
  if (!/^\d+(\.\d{1,18})?$/.test(clean)) throw new Error("Amount must be a decimal SAFE value with at most 18 decimals")
  if (parseUnits(clean, 18) <= 0n) throw new Error("Amount must be greater than zero")
  return parseUnits(clean, 18)
}

export function planStake(params: {
  validator: Address
  amount: string
  account?: Address
  allowance?: bigint
}): TxPlan {
  const amount = parseSafeAmount(params.amount)
  const txs: PlannedTx[] = []
  const warnings: string[] = []

  if (params.allowance === undefined || params.allowance < amount) {
    txs.push({
      label: "Approve SAFE for staking contract",
      to: CONTRACTS.safeToken,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CONTRACTS.staking, amount],
      }),
    })
  }

  txs.push({
    label: "Stake SAFE to validator",
    to: CONTRACTS.staking,
    value: 0n,
    data: encodeFunctionData({
      abi: stakingAbi,
      functionName: "stake",
      args: [params.validator, amount],
    }),
  })

  if (txs.length > 1) {
    warnings.push("This plan needs approval before staking unless your wallet supports batching.")
  }

  return {
    action: "stake",
    title: `Stake ${params.amount} SAFE`,
    account: params.account,
    txs,
    warnings,
  }
}

export function planUnstake(params: { validator: Address; amount: string; account?: Address }): TxPlan {
  const amount = parseSafeAmount(params.amount)
  return {
    action: "unstake",
    title: `Unstake ${params.amount} SAFE`,
    account: params.account,
    txs: [
      {
        label: "Initiate withdrawal from validator",
        to: CONTRACTS.staking,
        value: 0n,
        data: encodeFunctionData({
          abi: stakingAbi,
          functionName: "initiateWithdrawal",
          args: [params.validator, amount],
        }),
      },
    ],
    warnings: ["Withdrawals enter the protocol queue and become claimable after the delay."],
  }
}

export function planClaimWithdrawal(account?: Address): TxPlan {
  return {
    action: "claim-withdrawal",
    title: "Claim withdrawal",
    account,
    txs: [
      {
        label: "Claim next FIFO withdrawal",
        to: CONTRACTS.staking,
        value: 0n,
        data: encodeFunctionData({
          abi: stakingAbi,
          functionName: "claimWithdrawal",
        }),
      },
    ],
    warnings: ["The staking contract claims withdrawals in FIFO order."],
  }
}

export function planClaimRewards(params: {
  account: Address
  cumulativeAmount: bigint
  merkleRoot: Hex
  proof: Hex[]
}): TxPlan {
  return {
    action: "claim-rewards",
    title: "Claim staking rewards",
    account: params.account,
    txs: [
      {
        label: "Claim Merkle rewards",
        to: CONTRACTS.merkleDrop,
        value: 0n,
        data: encodeFunctionData({
          abi: merkleDropAbi,
          functionName: "claim",
          args: [params.account, params.cumulativeAmount, params.merkleRoot, params.proof],
        }),
      },
    ],
    warnings: [],
  }
}

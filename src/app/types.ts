import type { Address } from "viem"
import type { TxPlanAction, ValidatorInfo } from "../protocol"

export const navItems = ["dashboard", "withdrawals", "rewards", "validators", "settings"] as const

export type NavItem = (typeof navItems)[number]
export type Action = TxPlanAction

export const emptySummary = {
  safeBalance: 0n,
  totalStaked: 0n,
  pendingWithdrawals: 0n,
  claimableWithdrawals: 0n,
  claimableRewards: 0n,
  withdrawDelay: 0n,
}

export type AccountSummary = typeof emptySummary

export const defaultValidator: ValidatorInfo = {
  address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
  label: "Core Contributors",
  status: "active",
  commission: 0,
  participationRate: 0,
  totalStake: 0n,
  userStake: 0n,
}

export type SafePriceState = {
  usd: number | null
  source: string
  fetchedAt: number | null
  stale: boolean
  error: string
}

export type DiscoveredSafe = {
  address: Address
  ownersCount: number | null
  threshold: number | null
}

export type DataStatus = {
  chainId: number | null
  isLive: boolean
  liveBlock: bigint | null
  liveError: string
  merkleRootMatched: boolean | null
  proofFound: boolean
  rewardsSource: string
  validatorCount: number
  validatorStakeOk: boolean
  validatorStakeStatus: string
}

export type Modal =
  | { type: "readiness" }
  | { type: "validator"; validator: ValidatorInfo }
  | { type: "data" }
  | { type: "network" }
  | { type: "wallet" }
  | null

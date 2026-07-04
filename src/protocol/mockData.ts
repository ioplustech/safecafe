import type { Address } from "viem"
import type { ValidatorInfo } from "./validators"

const eth = 10n ** 18n

export const mockAccount = "0xbf3d000000000000000000000000000000008c49" as Address

export const mockSummary = {
  safeBalance: 1250n * eth,
  totalStaked: 8400n * eth,
  pendingWithdrawals: 320n * eth,
  claimableWithdrawals: 210n * eth,
  claimableRewards: 95n * eth,
  withdrawDelay: 7n * 24n * 60n * 60n,
}

export const mockValidators: ValidatorInfo[] = [
  {
    address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
    label: "Core Contributors",
    status: "active",
    commission: 5,
    participationRate: 98.7,
    totalStake: 1200000n * eth,
    userStake: 2000n * eth,
  },
  {
    address: "0x3D58a5475c1336b0A755c3aBd298CeB9b7BB9CDe",
    label: "Gnosis",
    status: "active",
    commission: 8,
    participationRate: 95.2,
    totalStake: 950000n * eth,
    userStake: 3500n * eth,
  },
  {
    address: "0x7B0A8EFA45dE81F11F2846EC28259B62155a2b37",
    label: "Greenfield",
    status: "active",
    commission: 7,
    participationRate: 93.4,
    totalStake: 740000n * eth,
    userStake: 2900n * eth,
  },
  {
    address: "0xb0E735D4a3b70195420E0ae933689A55750CFcd2",
    label: "RockawayX",
    status: "inactive",
    commission: 10,
    participationRate: 0,
    totalStake: 0n,
    userStake: 0n,
  },
]

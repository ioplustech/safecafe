import type { Address, PublicClient } from "viem"
import { erc20Abi, merkleDropAbi, stakingAbi } from "./abi"
import { CONTRACTS } from "./contracts"
import type { ValidatorInfo } from "./validators"

export type AccountSnapshot = {
  safeBalance: bigint
  totalStaked: bigint
  pendingWithdrawals: readonly { amount: bigint; claimableAt: bigint }[]
  nextClaimableWithdrawal: readonly [bigint, bigint]
  cumulativeClaimed: bigint
  withdrawDelay: bigint
  stakingAllowance: bigint
}

export async function readAccountSnapshot(client: PublicClient, account: Address): Promise<AccountSnapshot> {
  const results = await client.multicall({
    allowFailure: false,
    contracts: [
      {
        address: CONTRACTS.safeToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      },
      {
        address: CONTRACTS.staking,
        abi: stakingAbi,
        functionName: "totalStakerStakes",
        args: [account],
      },
      {
        address: CONTRACTS.staking,
        abi: stakingAbi,
        functionName: "getPendingWithdrawals",
        args: [account],
      },
      {
        address: CONTRACTS.staking,
        abi: stakingAbi,
        functionName: "getNextClaimableWithdrawal",
        args: [account],
      },
      {
        address: CONTRACTS.merkleDrop,
        abi: merkleDropAbi,
        functionName: "cumulativeClaimed",
        args: [account],
      },
      {
        address: CONTRACTS.staking,
        abi: stakingAbi,
        functionName: "withdrawDelay",
      },
      {
        address: CONTRACTS.safeToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, CONTRACTS.staking],
      },
    ],
  })
  const [
    safeBalance,
    totalStaked,
    pendingWithdrawals,
    nextClaimableWithdrawal,
    cumulativeClaimed,
    withdrawDelay,
    stakingAllowance,
  ] = results

  return {
    safeBalance,
    totalStaked,
    pendingWithdrawals,
    nextClaimableWithdrawal,
    cumulativeClaimed,
    withdrawDelay,
    stakingAllowance,
  }
}

export async function readValidatorPositions(
  client: PublicClient,
  account: Address,
  validators: ValidatorInfo[],
): Promise<ValidatorInfo[]> {
  const contracts = validators.flatMap((validator) => [
    {
      address: CONTRACTS.staking,
      abi: stakingAbi,
      functionName: "stakes" as const,
      args: [account, validator.address] as const,
    },
    {
      address: CONTRACTS.staking,
      abi: stakingAbi,
      functionName: "totalValidatorStakes" as const,
      args: [validator.address] as const,
    },
  ])

  const results = await client.multicall({ contracts, allowFailure: true })

  return validators.map((validator, index) => {
    const userStakeResult = results[index * 2]
    const totalStakeResult = results[index * 2 + 1]
    return {
      ...validator,
      userStake: userStakeResult.status === "success" ? userStakeResult.result : 0n,
      totalStake: totalStakeResult.status === "success" ? totalStakeResult.result : 0n,
    }
  })
}

export async function readValidatorTotals(client: PublicClient, validators: ValidatorInfo[]): Promise<ValidatorInfo[]> {
  const contracts = validators.map((validator) => ({
    address: CONTRACTS.staking,
    abi: stakingAbi,
    functionName: "totalValidatorStakes" as const,
    args: [validator.address] as const,
  }))

  const results = await client.multicall({ contracts, allowFailure: true })

  return validators.map((validator, index) => {
    const totalStakeResult = results[index]
    return {
      ...validator,
      totalStake: totalStakeResult.status === "success" ? totalStakeResult.result : validator.totalStake,
    }
  })
}

export async function readHealth(client: PublicClient) {
  const [blockNumber, [withdrawDelay, merkleRoot]] = await Promise.all([
    client.getBlockNumber(),
    client.multicall({
      allowFailure: false,
      contracts: [
        {
          address: CONTRACTS.staking,
          abi: stakingAbi,
          functionName: "withdrawDelay",
        },
        {
          address: CONTRACTS.merkleDrop,
          abi: merkleDropAbi,
          functionName: "merkleRoot",
        },
      ],
    }),
  ])

  return { blockNumber, withdrawDelay, merkleRoot }
}

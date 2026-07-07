import { type Address, createPublicClient, fallback, http } from "viem"
import { erc20Abi, safeAccountAbi, stakingAbi } from "../protocol/abi"
import { ethereumMainnet } from "../protocol/chains"
import { CONTRACTS } from "../protocol/contracts"
import { rpcUrls } from "./rpcUpstream"
import type { RpcGatewayEnv } from "./serverEnv"

export type AccessStrategy = "safe-staking-access" | "signed-wallet-access"

const eligibleCache = new Map<string, { expiresAt: number; result: boolean }>()
const eligibleCacheMs = 60_000

export function allowAllWallets(env: RpcGatewayEnv) {
  return env.SAFECAFE_RPC_ALLOW_ALL_WALLETS === "true"
}

export function rpcStrategy(env: RpcGatewayEnv): AccessStrategy {
  return allowAllWallets(env) ? "signed-wallet-access" : "safe-staking-access"
}

export async function verifySafeStakingAccess(address: Address, env: RpcGatewayEnv) {
  const key = address.toLowerCase()
  const cached = eligibleCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.result
  try {
    const client = await createAccessClient(env)
    const [safeBalance, totalStaked] = await Promise.all([
      client.readContract({
        address: CONTRACTS.safeToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
      client.readContract({
        address: CONTRACTS.staking,
        abi: stakingAbi,
        functionName: "totalStakerStakes",
        args: [address],
      }),
    ])
    const result = safeBalance > 0n || totalStaked > 0n
    eligibleCache.set(key, { expiresAt: Date.now() + eligibleCacheMs, result })
    return result
  } catch {
    return false
  }
}

export async function verifySubjectControl(signer: Address, subject: Address, env: RpcGatewayEnv) {
  if (signer.toLowerCase() === subject.toLowerCase()) return true
  const key = `control:${signer.toLowerCase()}:${subject.toLowerCase()}`
  const cached = eligibleCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.result
  try {
    const client = await createAccessClient(env)
    const isOwner = await client.readContract({
      address: subject,
      abi: safeAccountAbi,
      functionName: "isOwner",
      args: [signer],
    })
    eligibleCache.set(key, { expiresAt: Date.now() + eligibleCacheMs, result: isOwner })
    return isOwner
  } catch {
    return false
  }
}

export async function verifySafeStakingSubjectAccess(input: { signer: Address; subject: Address }, env: RpcGatewayEnv) {
  const [canControl, hasSafeOrStake] = await Promise.all([
    verifySubjectControl(input.signer, input.subject, env),
    verifySafeStakingAccess(input.subject, env),
  ])
  return canControl && hasSafeOrStake
}

export function verifyRpcAccess(input: { signer: Address; subject: Address }, env: RpcGatewayEnv) {
  if (allowAllWallets(env)) return Promise.resolve(Boolean(input.signer))
  return verifySafeStakingSubjectAccess(input, env)
}

async function createAccessClient(env: RpcGatewayEnv) {
  return createPublicClient({
    chain: ethereumMainnet,
    transport: fallback((await rpcUrls(env)).map((url) => http(url, { timeout: 8_000 }))),
  })
}

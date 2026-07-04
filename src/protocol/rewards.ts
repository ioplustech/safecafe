import { type Address, getAddress, type Hex } from "viem"
import { DEFAULT_REWARDS_BASE_URL, DEFAULT_REWARDS_BASE_URLS } from "./contracts"

export type RewardProof = {
  cumulativeAmount: string
  kycAmount?: string
  merkleRoot: Hex
  proof: Hex[] | null
  kyc?: boolean
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
}

export function proofPath(address: Address): string {
  const lower = getAddress(address).toLowerCase()
  const radix = lower.slice(2, 10)
  return `${radix.slice(0, 2)}/${radix.slice(2, 4)}/${radix.slice(4, 6)}/${radix.slice(6, 8)}/${lower}.json`
}

export function proofUrl(address: Address, baseUrl = DEFAULT_REWARDS_BASE_URL): string {
  return `${baseUrl}/proofs/${proofPath(address)}`
}

export function validateRewardProof(input: unknown): RewardProof {
  if (typeof input !== "object" || input === null) throw new Error("Invalid reward proof")
  const value = input as Record<string, unknown>
  if (typeof value.cumulativeAmount !== "string" || !/^\d+$/.test(value.cumulativeAmount)) {
    throw new Error("Invalid cumulativeAmount")
  }
  if (!isHex32(value.merkleRoot)) throw new Error("Invalid merkleRoot")
  if (value.proof !== null && !(Array.isArray(value.proof) && value.proof.every((entry) => isHex32(entry)))) {
    throw new Error("Invalid proof")
  }
  return value as RewardProof
}

export async function fetchRewardProof(
  address: Address,
  baseUrls: string | readonly string[] = DEFAULT_REWARDS_BASE_URLS,
): Promise<RewardProof | null> {
  const candidates = Array.isArray(baseUrls) ? baseUrls : [baseUrls]
  let lastError: Error | null = null

  for (const baseUrl of candidates) {
    try {
      const response = await fetch(proofUrl(address, baseUrl))
      if (response.status === 404) continue
      if (!response.ok) throw new Error(`Failed to fetch reward proof: ${response.status}`)
      return validateRewardProof(await response.json())
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (lastError) throw lastError
  return null
}

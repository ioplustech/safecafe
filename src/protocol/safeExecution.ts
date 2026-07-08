import { type Address, encodeFunctionData, getAddress, type Hex, isAddressEqual, type PublicClient, padHex } from "viem"
import { safeAccountAbi } from "./abi"
import type { PlannedTx } from "./txPlan"

export type SafeExecutionMode =
  | { kind: "direct"; threshold: bigint }
  | { kind: "not-owner"; threshold: bigint }
  | { kind: "multi-owner"; owners: Address[]; threshold: bigint }

const zeroAddress = "0x0000000000000000000000000000000000000000" as const

export async function resolveSafeExecutionMode(params: {
  client: PublicClient
  safe: Address
  signer: Address
}): Promise<SafeExecutionMode> {
  const [owners, threshold] = await Promise.all([
    params.client.readContract({
      address: params.safe,
      abi: safeAccountAbi,
      functionName: "getOwners",
    }),
    params.client.readContract({
      address: params.safe,
      abi: safeAccountAbi,
      functionName: "getThreshold",
    }),
  ])
  const normalizedOwners = owners.map((owner) => getAddress(owner))
  if (!normalizedOwners.some((owner) => isAddressEqual(owner, params.signer))) return { kind: "not-owner", threshold }
  if (threshold === 1n) return { kind: "direct", threshold }
  return { kind: "multi-owner", owners: normalizedOwners, threshold }
}

export function buildSafeExecTransaction(params: { safe: Address; signer: Address; tx: PlannedTx }): {
  to: Address
  data: Hex
  value: bigint
} {
  const signatures = buildApprovedHashSignature(params.signer)
  return {
    to: params.safe,
    value: 0n,
    data: encodeFunctionData({
      abi: safeAccountAbi,
      functionName: "execTransaction",
      args: [params.tx.to, params.tx.value, params.tx.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
    }),
  }
}

function buildApprovedHashSignature(owner: Address): Hex {
  const ownerWord = padHex(owner, { dir: "left", size: 32 })
  return `${ownerWord}${"0".repeat(64)}01` as Hex
}

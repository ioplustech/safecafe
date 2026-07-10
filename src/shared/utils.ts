import { type Address, isAddress } from "viem"

export type ProductIdentity = {
  name: string
  cliName: string
  version: string
  rpcEnvNames: readonly string[]
  safePayloadDescription: string
}

export function parseAddress(value: string, label = "address"): Address {
  if (!isAddress(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value as Address
}

export function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value
}

export function stringifyBigInts(value: unknown, spacing = 2) {
  return JSON.stringify(value, bigintReplacer, spacing)
}

export function totalAmount(items: readonly { amount: bigint }[]) {
  return items.reduce((sum, item) => sum + item.amount, 0n)
}

export function resolveEnvValue(env: Record<string, string | undefined>, names: readonly string[]) {
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
  return undefined
}

export function resolveEnvList(env: Record<string, string | undefined>, names: readonly string[]) {
  const value = resolveEnvValue(env, names)
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

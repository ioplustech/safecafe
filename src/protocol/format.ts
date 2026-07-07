import { type Address, formatUnits } from "viem"

export function formatSafeInput(value: bigint): string {
  const raw = formatUnits(value, 18)
  return raw.includes(".") ? raw.replace(/\.?0+$/, "") : raw
}

export function formatSafe(value: bigint, digits = 2): string {
  const raw = Number(formatUnits(value, 18))
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(raw) ? raw : 0)
}

export function formatUsdFromSafe(value: bigint, safePrice: number | null): string {
  if (safePrice === null || !Number.isFinite(safePrice) || safePrice <= 0) return "--"
  const raw = Number(formatUnits(value, 18)) * safePrice
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(raw) ? raw : 0)
}

export function compactAddress(address: Address | string, head = 6, tail = 4): string {
  if (!address) return ""
  if (address.length <= head + tail) return address
  return `${address.slice(0, head)}...${address.slice(-tail)}`
}

export function formatDelay(seconds: bigint): string {
  const value = Number(seconds)
  const days = Math.floor(value / 86400)
  if (days > 0) return `${days} days`
  const hours = Math.floor(value / 3600)
  if (hours > 0) return `${hours} hours`
  const minutes = Math.floor(value / 60)
  return `${minutes} minutes`
}

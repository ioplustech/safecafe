import { type Address, getAddress, isAddress } from "viem"
import { DEFAULT_VALIDATOR_INFO_URLS } from "./contracts"

export type ValidatorInfo = {
  address: Address
  label: string
  status: "active" | "inactive"
  commission: number
  participationRate: number
  totalStake: bigint
  userStake: bigint
}

type RawValidator = {
  address?: unknown
  label?: unknown
  is_active?: unknown
  commission?: unknown
  participation_rate_14d?: unknown
}

type FetchValidatorsOptions = {
  fallback?: boolean
}

const fallbackValidators: ValidatorInfo[] = [
  {
    address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
    label: "Core Contributors",
    status: "active",
    commission: 5,
    participationRate: 98.7,
    totalStake: 0n,
    userStake: 0n,
  },
  {
    address: "0x3D58a5475c1336b0A755c3aBd298CeB9b7BB9CDe",
    label: "Gnosis",
    status: "active",
    commission: 5,
    participationRate: 96.4,
    totalStake: 0n,
    userStake: 0n,
  },
  {
    address: "0x7B0A8EFA45dE81F11F2846EC28259B62155a2b37",
    label: "Greenfield",
    status: "active",
    commission: 7,
    participationRate: 95.2,
    totalStake: 0n,
    userStake: 0n,
  },
  {
    address: "0xb0E735D4a3b70195420E0ae933689A55750CFcd2",
    label: "RockawayX",
    status: "active",
    commission: 8,
    participationRate: 93.4,
    totalStake: 0n,
    userStake: 0n,
  },
]

function toValidator(raw: RawValidator): ValidatorInfo | null {
  if (typeof raw.address !== "string" || !isAddress(raw.address)) return null
  if (typeof raw.label !== "string") return null

  const commission = typeof raw.commission === "number" ? Math.round(raw.commission * 10000) / 100 : 0
  const participationRate =
    typeof raw.participation_rate_14d === "number" ? Math.round(raw.participation_rate_14d * 10000) / 100 : 0

  return {
    address: getAddress(raw.address),
    label: raw.label,
    status: raw.is_active === false ? "inactive" : "active",
    commission,
    participationRate,
    totalStake: 0n,
    userStake: 0n,
  }
}

export async function fetchValidators(
  urls: string | readonly string[] = DEFAULT_VALIDATOR_INFO_URLS,
  options: FetchValidatorsOptions = {},
): Promise<ValidatorInfo[]> {
  const candidates = Array.isArray(urls) ? urls : [urls]
  let lastError: Error | null = null

  for (const url of candidates) {
    try {
      const validators = await fetchValidatorsFromUrl(url)
      if (validators) return validators
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (options.fallback === false) {
    throw lastError ?? new Error("No validator metadata was available from the configured URLs.")
  }

  if (lastError) {
    console.warn("Failed to fetch validator info from all URLs, using fallback data:", lastError.message)
  }
  return fallbackValidators
}

async function fetchValidatorsFromUrl(url: string): Promise<ValidatorInfo[] | null> {
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Failed to fetch validators: ${response.status}`)
  const text = await response.text()
  const sanitized = text.replace(/,\s*,/g, ",").replace(/,\s*([}\]])/g, "$1")
  const json: unknown = JSON.parse(sanitized)
  if (!Array.isArray(json)) return null
  const validators = json.map((entry) => toValidator(entry as RawValidator)).filter(Boolean)
  return validators.length ? (validators as ValidatorInfo[]) : null
}

export function findValidator(validators: ValidatorInfo[], query: string): ValidatorInfo | null {
  const normalized = query.toLowerCase()
  return (
    validators.find(
      (validator) => validator.address.toLowerCase() === normalized || validator.label.toLowerCase() === normalized,
    ) ?? null
  )
}

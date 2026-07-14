import { type Address, getAddress, isAddress } from "viem"

export const appStorageKeys = {
  agentActiveSession: "safecafe:agent:active-session",
  agentLauncherPosition: "safecafe:agent-launcher-position",
  agentSessions: "safecafe:agent:sessions",
  accountLiveCache: "safecafe:account-live-cache:v1",
  customRpcUrl: "safecafe:custom-rpc-url",
  userSafeApiKey: "safecafe:user-safe-api-key",
  userLlmConfig: "safecafe:user-llm-config",
  dashboardAction: "safecafe:dashboard-action",
  layoutDensity: "safecafe:layout-density",
  locale: "safecafe:locale",
  rpcSession: "safecafe:rpc-session",
  safePrice: "safecafe.safeUsdPrice.v1",
  safeProposal: "safecafe:safe-proposal:v1",
  selectedValidator: "safecafe:selected-validator",
  validatorQuery: "safecafe:validator-query",
  validatorSort: "safecafe:validator-sort",
  validatorsActiveOnly: "safecafe:validators-active-only",
  walletDisconnected: "safecafe:wallet-disconnected",
  walletSubjects: "safecafe:wallet-subjects",
} as const

type StorageKey = (typeof appStorageKeys)[keyof typeof appStorageKeys]

export function readStorageText(key: StorageKey): string | null {
  const storage = readBrowserStorage()
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorageText(key: StorageKey, value: string) {
  const storage = readBrowserStorage()
  if (!storage) return
  try {
    storage.setItem(key, value)
  } catch {
    // Browser storage can be disabled or full. UI state persistence is best-effort.
  }
}

export function removeStorageValue(key: StorageKey) {
  const storage = readBrowserStorage()
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Best-effort cleanup.
  }
}

export function readBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readStorageJson<T>(key: StorageKey, readValue: (value: unknown) => T | null): T | null {
  const raw = readStorageText(key)
  if (!raw) return null
  try {
    return readValue(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeStorageJson(key: StorageKey, value: unknown) {
  writeStorageText(key, JSON.stringify(value))
}

export function readStorageEnum<T extends string>(key: StorageKey, values: readonly T[], fallback: T): T {
  const stored = readStorageText(key)
  return values.includes(stored as T) ? (stored as T) : fallback
}

export function readStorageAddress(key: StorageKey): Address | null {
  return normalizeAddress(readStorageText(key))
}

export function writeStorageAddress(key: StorageKey, value: Address | null) {
  const address = normalizeAddress(value)
  if (address) {
    writeStorageText(key, address)
  } else {
    removeStorageValue(key)
  }
}

export function readStorageFlag(key: StorageKey) {
  return readStorageText(key) === "true"
}

export function writeStorageFlag(key: StorageKey, value: boolean) {
  if (value) {
    writeStorageText(key, "true")
  } else {
    removeStorageValue(key)
  }
}

export function readStoredWalletSubject(signer: Address | null): Address | null {
  if (!signer) return null
  const subjects = readWalletSubjects()
  const subject = subjects[signer.toLowerCase()]
  return normalizeAddress(subject)
}

export function writeStoredWalletSubject(signer: Address | null, subject: Address | null) {
  if (!signer || !subject) return
  const normalizedSigner = normalizeAddress(signer)
  const normalizedSubject = normalizeAddress(subject)
  if (!normalizedSigner || !normalizedSubject) return
  const subjects = readWalletSubjects()
  subjects[normalizedSigner.toLowerCase()] = normalizedSubject
  writeStorageJson(appStorageKeys.walletSubjects, subjects)
}

export function clearStoredWalletSubject(signer: Address | null) {
  if (!signer) return
  const normalizedSigner = normalizeAddress(signer)
  if (!normalizedSigner) return
  const subjects = readWalletSubjects()
  delete subjects[normalizedSigner.toLowerCase()]
  writeStorageJson(appStorageKeys.walletSubjects, subjects)
}

function readWalletSubjects(): Record<string, Address> {
  return (
    readStorageJson(appStorageKeys.walletSubjects, (value) => {
      if (!value || typeof value !== "object") return {}
      const subjects: Record<string, Address> = {}
      for (const [signer, subject] of Object.entries(value)) {
        const normalizedSigner = normalizeAddress(signer)
        const normalizedSubject = normalizeAddress(subject)
        if (normalizedSigner && normalizedSubject) subjects[normalizedSigner.toLowerCase()] = normalizedSubject
      }
      return subjects
    }) ?? {}
  )
}

function normalizeAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? (getAddress(value) as Address) : null
}

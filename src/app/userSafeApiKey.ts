export type UserSafeApiStatus = "configured" | "idle" | "invalid"

export function resolveUserSafeApiSave(draft: string, savedKey: string): { key: string; status: "configured" } | null {
  const key = draft.trim() || savedKey.trim()
  return key ? { key, status: "configured" } : null
}

export function isUserSafeApiKeyRejected(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "safe_api_key_invalid")
}

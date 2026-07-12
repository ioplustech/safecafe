import type { Address } from "viem"

export function defaultSafeSubjectInput(
  subjectKind: "safe" | "self",
  subjectAccount: Address | null,
  discoveredSafeAddresses: readonly Address[],
  currentInput: string,
): string {
  if (currentInput.trim()) return currentInput
  if (subjectKind === "safe" && subjectAccount) return subjectAccount
  return discoveredSafeAddresses[0] ?? ""
}

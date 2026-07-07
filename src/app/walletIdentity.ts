import { type Address, getAddress, isAddress } from "viem"

export type WalletIdentity = {
  signer: Address | null
  subject: Address | null
  subjectKind: "self" | "safe"
}

export function createWalletIdentity(signer: Address | null, subject?: Address | null): WalletIdentity {
  const normalizedSigner = normalizeAddress(signer)
  const normalizedSubject = subject === undefined ? normalizedSigner : normalizeAddress(subject)
  return {
    signer: normalizedSigner,
    subject: normalizedSubject,
    subjectKind:
      normalizedSigner && normalizedSubject && normalizedSigner.toLowerCase() !== normalizedSubject.toLowerCase()
        ? "safe"
        : "self",
  }
}

export function normalizeAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null
}

export function isSelfSubject(identity: Pick<WalletIdentity, "signer" | "subject">) {
  return Boolean(
    identity.signer && identity.subject && identity.signer.toLowerCase() === identity.subject.toLowerCase(),
  )
}

import type { ValidatorInfo } from "../protocol"

export function compareBigintDesc(a: bigint, b: bigint) {
  if (a === b) return 0
  return a > b ? -1 : 1
}

export function findPreferredRestakeValidator(validators: ValidatorInfo[]) {
  const [stakedValidator] = validators
    .filter((validator) => validator.userStake > 0n)
    .sort((a, b) => compareBigintDesc(a.userStake, b.userStake) || a.label.localeCompare(b.label))
  if (stakedValidator) return stakedValidator
  return validators.find((validator) => validator.status === "active") ?? null
}

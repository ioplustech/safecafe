import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  fetchRewardProof,
  fetchValidators,
  findValidator,
  formatSafe,
  mockValidators,
  parseSafeAmount,
  readAccountSnapshot,
  readHealth,
  readValidatorPositions,
  type TxPlan,
} from "../src/protocol"
import {
  type CliGlobalOptions,
  createProductPublicClient,
  output,
  printPlan,
  readSigningKeyring,
  resolvePreferredSignerAddress,
  resolveRpcUrl,
  selectEoaSigningKey,
  selectSafeSigningKey,
  sendPlanTransactions,
  sendSafePlanTransactions,
} from "../src/shared/cli"
import { reconcileTxPlanForExecution } from "../src/shared/planReconcile"
import { parseAddress, resolveEnvList, resolveEnvValue } from "../src/shared/utils"

export type GlobalOptions = CliGlobalOptions

export type WriteOptions = {
  account?: string
  dryRun?: boolean
  send?: boolean
  yes?: boolean
  privateKeyPrompt?: boolean
  privateKeyStdin?: boolean
  privateKeyEnv?: string
  signer?: string
}

export const rpcEnvNames = ["SAFECAFE_RPC_URL", "SAFENET_RPC_URL"] as const
export const safeApiKeyEnvNames = ["SAFECAFE_SAFE_API_KEYS"] as const
export const safeTxServiceEnvNames = ["SAFECAFE_SAFE_TX_SERVICE_URL"] as const

export function createClient(globals: GlobalOptions) {
  return createProductPublicClient(globals, process.env, rpcEnvNames)
}

export function resolvePlanningAccount(options: WriteOptions, globals: GlobalOptions): Address | undefined {
  if (globals.mock) return undefined
  if (options.account) return parseAddress(options.account, "account")
  throw new Error("--account is required for live planning and sending.")
}

export async function resolveValidator(
  query: string,
  mock?: boolean,
  options: { allowDirectAddress?: boolean } = {},
): Promise<Address> {
  const direct = tryParseAddress(query)
  if (direct && options.allowDirectAddress) return direct
  const validators = mock ? mockValidators : await fetchValidators()
  const validator = findValidator(validators, query)
  if (!validator) throw new Error(`Unknown validator: ${query}`)
  return validator.address
}

function tryParseAddress(value: string): Address | null {
  try {
    return parseAddress(value)
  } catch {
    return null
  }
}

export async function assertStakePossible(
  globals: GlobalOptions,
  account: Address,
  validator: Address,
  amountText: string,
) {
  const amount = parseSafeAmount(amountText)
  const client = createClient(globals)
  const [snapshot, validators] = await Promise.all([readAccountSnapshot(client, account), fetchValidators()])
  const validatorMetadata = findValidator(validators, validator)
  if (validatorMetadata?.status === "inactive") throw new Error(`Validator is inactive: ${validatorMetadata.label}`)
  if (snapshot.safeBalance < amount) {
    throw new Error(
      `Insufficient SAFE balance. Need ${formatSafe(amount, 6)}, have ${formatSafe(snapshot.safeBalance, 6)}.`,
    )
  }
}

export async function assertUnstakePossible(
  globals: GlobalOptions,
  account: Address,
  validator: Address,
  amountText: string,
) {
  const amount = parseSafeAmount(amountText)
  const [position] = await readValidatorPositions(createClient(globals), account, [
    {
      address: validator,
      label: "Selected validator",
      status: "active",
      commission: 0,
      participationRate: 0,
      totalStake: 0n,
      userStake: 0n,
    },
  ])
  if (position.userStake < amount) {
    throw new Error(
      `Insufficient validator stake. Need ${formatSafe(amount, 6)}, have ${formatSafe(position.userStake, 6)}.`,
    )
  }
}

export async function assertWithdrawalClaimable(globals: GlobalOptions, account: Address) {
  const snapshot = await readAccountSnapshot(createClient(globals), account)
  const { amount, claimableAt } = snapshot.nextClaimableWithdrawal
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (amount <= 0n || claimableAt > now) {
    const suffix = claimableAt > 0n ? ` Next claimable at ${new Date(Number(claimableAt) * 1000).toISOString()}.` : ""
    throw new Error(`No withdrawal is claimable yet.${suffix}`)
  }
}

export async function assertRewardsClaimable(globals: GlobalOptions, account: Address) {
  const client = createClient(globals)
  const [proof, snapshot, health] = await Promise.all([
    fetchRewardProof(account),
    readAccountSnapshot(client, account),
    readHealth(client),
  ])
  if (!proof?.proof) throw new Error("No reward proof found for account.")
  if (proof.merkleRoot.toLowerCase() !== health.merkleRoot.toLowerCase())
    throw new Error("Reward proof Merkle root does not match the live contract root.")
  const cumulativeAmount = BigInt(proof.cumulativeAmount)
  if (cumulativeAmount <= snapshot.cumulativeClaimed) throw new Error("Rewards are already fully claimed.")
}

export async function handlePlan(globals: GlobalOptions, plan: TxPlan, options: WriteOptions) {
  if (globals.mock && options.send) throw new Error("--mock cannot be combined with --send")
  if (globals.json && options.send) throw new Error("--json cannot be combined with --send")

  output(globals, plan, () => printPlan(plan))
  if (!options.send) return

  if (!options.yes) throw new Error("--yes is required with --send to confirm live transaction submission")
  if (!plan.account) throw new Error("--account is required with --send")

  const client = createClient(globals)
  const code = await client.getCode({ address: plan.account })

  if (options.privateKeyEnv) {
    console.error("Warning: environment-variable signing is intended for controlled automation only.")
    console.error("Do not store private keys in .env files, shell history, shared CI variables, or logs.")
  }
  const keyring = await readSigningKeyring(options, process.env)
  const preferredSigner = resolvePreferredSignerAddress(options, process.env)
  const rpcUrl = resolveRpcUrl(globals, process.env, rpcEnvNames)

  console.error("Safecafe will execute the live staking action with the provided signing key.")
  console.error(
    "The private key is used in memory for this run only; prefer --private-key-prompt or --private-key-stdin.",
  )

  const snapshot = await readAccountSnapshot(client, plan.account)
  const reconciled = reconcileTxPlanForExecution(plan, {
    cumulativeClaimed: snapshot.cumulativeClaimed,
    stakingAllowance: snapshot.stakingAllowance,
  })
  if (!reconciled.plan) {
    console.log("All actionable steps are already satisfied on-chain.")
    return
  }
  const executablePlan = reconciled.plan

  if (code && code !== "0x") {
    const selectedSigner = await selectSafeSigningKey(keyring, {
      createSafeProtocolKit: undefined,
      preferredSigner,
      rpcUrl,
      safeAddress: plan.account,
    })
    const result = await sendSafePlanTransactions(executablePlan, {
      privateKey: selectedSigner.privateKey,
      rpcUrl,
      safeApiKeys: resolveEnvList(process.env, safeApiKeyEnvNames),
      safeTxServiceUrl: resolveEnvValue(process.env, safeTxServiceEnvNames),
      onSubmitted: (label, hash) => console.log(`Submitted ${label}: ${hash}`),
      onConfirmed: (label, blockNumber) => console.log(`Confirmed ${label}: block ${blockNumber}`),
    })
    if (result.mode === "safe-proposed") {
      console.log(
        `Safe transaction proposed: ${result.safeTxHash} (${result.confirmations}/${result.threshold} confirmations)`,
      )
    } else if (result.mode === "safe-executed") {
      console.log(`Safe transaction executed: ${result.safeTxHash}`)
    }
    return
  }

  const selectedSigner = selectEoaSigningKey(keyring, plan.account, preferredSigner)
  const signer = privateKeyToAccount(selectedSigner.privateKey)
  if (signer.address.toLowerCase() !== plan.account.toLowerCase()) {
    throw new Error(`Signing key resolves to ${signer.address}, but --account is ${plan.account}.`)
  }

  await sendPlanTransactions(executablePlan, {
    privateKey: selectedSigner.privateKey,
    rpcUrl,
    onSubmitted: (label, hash) => console.log(`Submitted ${label}: ${hash}`),
    onConfirmed: (label, blockNumber) => console.log(`Confirmed ${label}: block ${blockNumber}`),
  })
}

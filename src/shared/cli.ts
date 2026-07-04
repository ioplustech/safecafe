import { readFileSync, writeFileSync } from "node:fs"
import { stdin as input, stdout as outputStream } from "node:process"
import { createInterface } from "node:readline/promises"
import { createWalletClient, type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { mainnet } from "viem/chains"
import {
  compactAddress,
  createSafenetPublicClient,
  DEFAULT_RPC_URLS,
  type TxPlan,
  toSafeTransactionPayload,
} from "../protocol"
import { bigintReplacer, resolveEnvValue, stringifyBigInts } from "./utils"

export type CliGlobalOptions = {
  rpc?: string
  json?: boolean
  mock?: boolean
}

export type SigningOptions = {
  privateKeyPrompt?: boolean
  privateKeyStdin?: boolean
  privateKeyEnv?: string
}

export type SendPlanOptions = {
  privateKey: Hex
  rpcUrl?: string
  onSubmitted?: (label: string, hash: Hex) => void
  onConfirmed?: (label: string, blockNumber: bigint) => void
}

export function resolveRpcUrl(
  globals: Pick<CliGlobalOptions, "rpc">,
  env: Record<string, string | undefined>,
  envNames: readonly string[],
) {
  return globals.rpc || resolveEnvValue(env, envNames)
}

export function createProductPublicClient(
  globals: Pick<CliGlobalOptions, "rpc">,
  env: Record<string, string | undefined>,
  envNames: readonly string[],
) {
  return createSafenetPublicClient(resolveRpcUrl(globals, env, envNames))
}

export function output(globals: Pick<CliGlobalOptions, "json">, payload: unknown, printText: () => void) {
  if (globals.json) {
    console.log(stringifyBigInts(payload))
    return
  }
  printText()
}

export async function readSigningPrivateKey(
  options: SigningOptions,
  env: Record<string, string | undefined>,
): Promise<Hex> {
  const sourceCount =
    Number(!!options.privateKeyPrompt) + Number(!!options.privateKeyStdin) + Number(!!options.privateKeyEnv)
  if (sourceCount !== 1) {
    throw new Error(
      "Choose exactly one signing key source: --private-key-prompt, --private-key-stdin, or --private-key-env <name>.",
    )
  }

  if (options.privateKeyPrompt) return normalizePrivateKey(await promptHidden("Private key (input hidden): "))
  if (options.privateKeyStdin) return normalizePrivateKey(readFileSync(0, "utf8"))

  const value = options.privateKeyEnv ? env[options.privateKeyEnv] : undefined
  if (!value) throw new Error(`Missing private key in ${options.privateKeyEnv}`)
  return normalizePrivateKey(value)
}

async function promptHidden(prompt: string): Promise<string> {
  if (!input.isTTY) throw new Error("--private-key-prompt requires an interactive terminal")

  const rl = createInterface({ input, output: outputStream })
  const hidden = rl as unknown as { _writeToOutput: (text: string) => void }
  hidden._writeToOutput = (text: string) => {
    if (text.includes(prompt)) outputStream.write(prompt)
  }

  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
    outputStream.write("\n")
  }
}

function normalizePrivateKey(value: string): Hex {
  const privateKey = value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string.")
  }
  return privateKey as Hex
}

export function printPlan(plan: TxPlan) {
  console.log(`Plan: ${plan.title}`)
  if (plan.account) console.log(`Account: ${plan.account}`)
  console.log("")
  plan.txs.forEach((tx, index) => {
    console.log(`${index + 1}. ${tx.label}`)
    console.log(`   to:   ${tx.to}`)
    console.log(`   data: ${compactAddress(tx.data, 18, 12)}`)
  })
  if (plan.warnings.length) {
    console.log("")
    for (const warning of plan.warnings) {
      console.log(`Warning: ${warning}`)
    }
  }
}

export function writeSafePayloadFile(plan: TxPlan, path: string, description: string, chainId = 1) {
  const payload = toSafeTransactionPayload(plan, chainId, { description })
  writeFileSync(path, JSON.stringify(payload, bigintReplacer, 2))
  return payload
}

export async function sendPlanTransactions(plan: TxPlan, options: SendPlanOptions) {
  const account = privateKeyToAccount(options.privateKey)
  const rpcUrl = options.rpcUrl || DEFAULT_RPC_URLS[0]
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  })
  const publicClient = createSafenetPublicClient(rpcUrl)

  for (const tx of plan.txs) {
    const hash = await walletClient.sendTransaction({
      account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })
    options.onSubmitted?.(tx.label, hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    options.onConfirmed?.(tx.label, receipt.blockNumber)
  }
}

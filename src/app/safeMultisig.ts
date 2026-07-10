import Safe from "@safe-global/protocol-kit"
import type { Address, Hex } from "viem"
import type { TxPlan } from "../protocol"

type SafeTxErrorCode =
  | "safe_api_key_invalid"
  | "safe_api_key_missing"
  | "safe_tx_auth_mismatch"
  | "safe_tx_auth_required"
  | "safe_tx_service_failed"
  | "safe_tx_service_not_found"
  | "safe_tx_service_rate_limited"

type SafeTxErrorMessages = Partial<
  Record<Exclude<SafeTxErrorCode, "safe_tx_auth_mismatch" | "safe_tx_service_not_found">, string>
>

type Eip1193Provider = {
  request: (args: { method: string; params?: object | readonly unknown[] }) => Promise<unknown>
}

type SafeProtocolKitLike = {
  createTransaction(input: { transactions: Array<{ data: string; to: string; value: string }> }): Promise<unknown>
  executeTransaction(transaction: unknown): Promise<{ hash: string }>
  getChainId(): Promise<bigint>
  getThreshold(): Promise<number>
  getTransactionHash(transaction: unknown): Promise<string>
  isOwner(owner: string): Promise<boolean>
  signHash(safeTxHash: string): Promise<{ data: string }>
}

type SafeApiKitLike = {
  confirmTransaction(safeTxHash: string, signature: string): Promise<unknown>
  getTransaction(safeTxHash: string): Promise<unknown>
  getTransactionConfirmations(safeTxHash: string): Promise<unknown>
  proposeTransaction(input: {
    origin?: string
    safeAddress: string
    safeTransactionData: unknown
    safeTxHash: string
    senderAddress: string
    senderSignature: string
  }): Promise<void>
}

type SafeMultisigTestKit = {
  createSafeApiKit?: (config: { chainId: bigint; txServiceUrl?: string; userSafeApiKey?: string }) => SafeApiKitLike
  createSafeProtocolKit?: (config: {
    provider: Eip1193Provider
    safeAddress: string
    signer: string
  }) => Promise<SafeProtocolKitLike>
}

export type SafeMultisigProposalResult =
  | { mode: "executed"; hash: Hex; safeTxHash: string; threshold: number }
  | { mode: "proposed"; confirmations: number; safeTxHash: string; threshold: number }

export async function submitSafeMultisigPlan(params: {
  origin: string
  plan: TxPlan
  provider: Eip1193Provider
  safeAddress: Address
  safeTxErrorMessages?: SafeTxErrorMessages
  signer: Address
  authToken?: string | null
  userSafeApiKey?: string
}): Promise<SafeMultisigProposalResult> {
  const protocolKit = await createSafeProtocolKit({
    provider: params.provider,
    safeAddress: params.safeAddress,
    signer: params.signer,
  })

  if (!(await protocolKit.isOwner(params.signer))) throw new Error("Connected wallet is not a Safe owner.")

  const transactions = params.plan.txs.map((tx) => ({
    data: tx.data,
    to: tx.to,
    value: tx.value.toString(),
  }))
  const safeTransaction = await protocolKit.createTransaction({ transactions })
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
  const signature = await protocolKit.signHash(safeTxHash)
  const threshold = await protocolKit.getThreshold()
  const apiKit = createSafeTxServiceClient({
    authToken: params.authToken,
    chainId: await protocolKit.getChainId(),
    messages: params.safeTxErrorMessages,
    safeAddress: params.safeAddress,
    senderAddress: params.signer,
    userSafeApiKey: params.userSafeApiKey,
  })
  const existingConfirmations = await readSafeConfirmations(apiKit, safeTxHash)
  let minimumConfirmations = 0
  let transactionReadyForExecution: unknown = null

  if (existingConfirmations.length === 0) {
    await apiKit.proposeTransaction({
      origin: params.origin,
      safeAddress: params.safeAddress,
      safeTransactionData: getSafeTransactionData(safeTransaction),
      safeTxHash,
      senderAddress: params.signer,
      senderSignature: signature.data,
    })
    minimumConfirmations = 1
    transactionReadyForExecution = safeTransaction
  } else if (!hasOwnerConfirmation(existingConfirmations, params.signer)) {
    minimumConfirmations = existingConfirmations.length
    await apiKit.confirmTransaction(safeTxHash, signature.data)
    minimumConfirmations += 1
  } else {
    minimumConfirmations = existingConfirmations.length
  }

  const confirmations = await countSafeConfirmations(apiKit, safeTxHash, minimumConfirmations)
  if (confirmations < threshold) return { mode: "proposed", confirmations, safeTxHash, threshold }

  const transaction = transactionReadyForExecution ?? (await apiKit.getTransaction(safeTxHash))
  const result = await protocolKit.executeTransaction(transaction)
  return { mode: "executed", hash: result.hash as Hex, safeTxHash, threshold }
}

async function readSafeConfirmations(apiKit: SafeApiKitLike, safeTxHash: string) {
  try {
    return readConfirmations(await apiKit.getTransactionConfirmations(safeTxHash))
  } catch (error) {
    if (!isSafeTxNotFoundError(error)) throw error
    return []
  }
}

function hasOwnerConfirmation(confirmations: Array<{ owner: string }>, owner: Address) {
  return confirmations.some((confirmation) => confirmation.owner.toLowerCase() === owner.toLowerCase())
}

async function countSafeConfirmations(apiKit: SafeApiKitLike, safeTxHash: string, fallback = 0) {
  try {
    return Math.max(fallback, readConfirmations(await apiKit.getTransactionConfirmations(safeTxHash)).length)
  } catch (error) {
    if (fallback > 0 && isSafeTxNotFoundError(error)) return fallback
    throw error
  }
}

function readConfirmations(value: unknown): Array<{ owner: string }> {
  if (!value || typeof value !== "object") return []
  const results = (value as { results?: unknown }).results
  const confirmations = Array.isArray(results) ? results : Array.isArray(value) ? value : []
  return confirmations.filter(isOwnerConfirmation)
}

function isOwnerConfirmation(value: unknown): value is { owner: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { owner?: unknown }).owner === "string")
}

function getSafeTransactionData(transaction: unknown) {
  if (transaction && typeof transaction === "object" && "data" in transaction) {
    return (transaction as { data: unknown }).data
  }
  return transaction
}

function createSafeProtocolKit(config: { provider: Eip1193Provider; safeAddress: Address; signer: Address }) {
  const testKit = readTestKit()
  if (testKit?.createSafeProtocolKit) return testKit.createSafeProtocolKit(config)
  return Safe.init(config) as Promise<SafeProtocolKitLike>
}

function createSafeTxServiceClient(config: {
  authToken?: string | null
  chainId: bigint
  messages?: SafeTxErrorMessages
  safeAddress: Address
  senderAddress: Address
  userSafeApiKey?: string
}): SafeApiKitLike {
  const testKit = readTestKit()
  if (testKit?.createSafeApiKit) return testKit.createSafeApiKit({ ...config, txServiceUrl: readSafeTxServiceUrl() })
  if (config.userSafeApiKey?.trim()) {
    return new DirectSafeTxServiceClient({
      apiKey: config.userSafeApiKey.trim(),
      baseUrl: readSafeTxServiceUrl(config.chainId),
      messages: config.messages,
    })
  }
  return new ProxiedSafeTxServiceClient({
    authToken: config.authToken,
    messages: config.messages,
    safeAddress: config.safeAddress,
    senderAddress: config.senderAddress,
  })
}

function readTestKit(): SafeMultisigTestKit | null {
  return (window.__safecafeSafeMultisigTestKit as SafeMultisigTestKit | undefined) ?? null
}

function readSafeTxServiceUrl(chainId = 1n) {
  return `https://api.safe.global/tx-service/${safeNetworkShortName(chainId)}/api`
}

function safeNetworkShortName(chainId: bigint) {
  if (chainId === 1n) return "eth"
  throw new SafeTxServiceError("safe_tx_service_failed", `Unsupported Safe Transaction Service chainId ${chainId}.`)
}

function isSafeTxNotFoundError(error: unknown) {
  return error instanceof SafeTxServiceError && error.code === "safe_tx_service_not_found"
}

class DirectSafeTxServiceClient implements SafeApiKitLike {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #messages?: SafeTxErrorMessages

  constructor(config: { apiKey: string; baseUrl: string; messages?: SafeTxErrorMessages }) {
    this.#apiKey = config.apiKey
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "")
    this.#messages = config.messages
  }

  async confirmTransaction(safeTxHash: string, signature: string) {
    return this.#request({
      body: { signature },
      method: "POST",
      url: `${this.#baseUrl}/v1/multisig-transactions/${safeTxHash}/confirmations/`,
    })
  }

  async getTransaction(safeTxHash: string) {
    return this.#request({
      method: "GET",
      url: `${this.#baseUrl}/v2/multisig-transactions/${safeTxHash}/`,
    })
  }

  async getTransactionConfirmations(safeTxHash: string) {
    return this.#request({
      method: "GET",
      url: `${this.#baseUrl}/v1/multisig-transactions/${safeTxHash}/confirmations/`,
    })
  }

  async proposeTransaction(input: {
    origin?: string
    safeAddress: string
    safeTransactionData: unknown
    safeTxHash: string
    senderAddress: string
    senderSignature: string
  }) {
    await this.#request({
      body: {
        ...readSafeTransactionDataObject(input.safeTransactionData),
        contractTransactionHash: input.safeTxHash,
        origin: input.origin,
        sender: input.senderAddress,
        signature: input.senderSignature,
      },
      method: "POST",
      url: `${this.#baseUrl}/v2/safes/${input.safeAddress}/multisig-transactions/`,
    })
  }

  async #request(request: { body?: unknown; method: string; url: string }) {
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    })
    return readSafeTxResponse(response, this.#messages)
  }
}

class ProxiedSafeTxServiceClient implements SafeApiKitLike {
  readonly #authToken?: string | null
  readonly #messages?: SafeTxErrorMessages
  readonly #safeAddress: Address
  readonly #senderAddress: Address

  constructor(config: {
    authToken?: string | null
    messages?: SafeTxErrorMessages
    safeAddress: Address
    senderAddress: Address
  }) {
    this.#authToken = config.authToken
    this.#messages = config.messages
    this.#safeAddress = config.safeAddress
    this.#senderAddress = config.senderAddress
  }

  confirmTransaction(safeTxHash: string, signature: string) {
    return this.#request({ action: "confirm", safeTxHash, signature })
  }

  getTransaction(safeTxHash: string) {
    return this.#request({ action: "get", safeTxHash })
  }

  getTransactionConfirmations(safeTxHash: string) {
    return this.#request({ action: "confirmations", safeTxHash })
  }

  async proposeTransaction(input: {
    origin?: string
    safeAddress: string
    safeTransactionData: unknown
    safeTxHash: string
    senderAddress: string
    senderSignature: string
  }) {
    await this.#request({
      action: "propose",
      origin: input.origin,
      safeAddress: input.safeAddress,
      safeTransactionData: readSafeTransactionDataObject(input.safeTransactionData),
      safeTxHash: input.safeTxHash,
      senderAddress: input.senderAddress,
      senderSignature: input.senderSignature,
    })
  }

  async #request(body: Record<string, unknown>) {
    const response = await fetch("/api/safe/transaction", {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(this.#authToken ? { authorization: `Bearer ${this.#authToken}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        safeAddress: this.#safeAddress,
        senderAddress: this.#senderAddress,
        ...body,
      }),
    })
    const payload = await readSafeTxResponse(response, this.#messages)
    return readProxyResult(payload)
  }
}

async function readSafeTxResponse(response: Response, messages?: SafeTxErrorMessages) {
  const text = await response.text()
  const payload = parseJson(text)
  if (response.ok) return payload
  const code = readSafeTxErrorCode(payload, response.status)
  const message =
    readConfiguredSafeTxErrorMessage(messages, code) ??
    readSafeTxErrorMessage(payload) ??
    defaultSafeTxErrorMessage(code)
  throw new SafeTxServiceError(code, message)
}

function readProxyResult(payload: unknown) {
  if (payload && typeof payload === "object" && "result" in payload) return (payload as { result: unknown }).result
  return payload
}

function readSafeTransactionDataObject(value: unknown): object {
  return value && typeof value === "object" ? value : {}
}

function parseJson(text: string) {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function readSafeTxErrorCode(payload: unknown, status: number): SafeTxErrorCode {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code
      if (isSafeTxErrorCode(code)) return code
    }
  }
  if (status === 401 || status === 403) return "safe_api_key_invalid"
  if (status === 404) return "safe_tx_service_not_found"
  if (status === 429) return "safe_tx_service_rate_limited"
  return "safe_tx_service_failed"
}

function readSafeTxErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null
  const error = "error" in payload ? (payload as { error?: unknown }).error : payload
  if (!error || typeof error !== "object") return null
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message : null
}

function isSafeTxErrorCode(value: unknown): value is SafeTxErrorCode {
  return (
    value === "safe_api_key_invalid" ||
    value === "safe_api_key_missing" ||
    value === "safe_tx_auth_mismatch" ||
    value === "safe_tx_auth_required" ||
    value === "safe_tx_service_failed" ||
    value === "safe_tx_service_not_found" ||
    value === "safe_tx_service_rate_limited"
  )
}

function readConfiguredSafeTxErrorMessage(messages: SafeTxErrorMessages | undefined, code: SafeTxErrorCode) {
  if (code === "safe_tx_service_not_found") return null
  if (code === "safe_tx_auth_mismatch") return null
  return messages?.[code] ?? null
}

function defaultSafeTxErrorMessage(code: SafeTxErrorCode) {
  if (code === "safe_api_key_missing") {
    return "Safe API key is not configured. Add your own Safe API key in Settings, or export the Safe Transaction Builder JSON."
  }
  if (code === "safe_api_key_invalid") {
    return "Safe API key is invalid or not allowed. Update the Safe API key in Settings, or export the Safe Transaction Builder JSON."
  }
  if (code === "safe_tx_service_rate_limited") {
    return "Safe Transaction Service is rate limited. Try again later or use your own Safe API key in Settings."
  }
  if (code === "safe_tx_service_not_found") return "Safe transaction was not found."
  if (code === "safe_tx_auth_required") return "Sign in with your wallet before syncing the Safe proposal."
  if (code === "safe_tx_auth_mismatch") return "The Safe proposal does not match the signed wallet session."
  return "Safe Transaction Service is unavailable. Try again later or export the Safe Transaction Builder JSON."
}

class SafeTxServiceError extends Error {
  readonly code: SafeTxErrorCode

  constructor(code: SafeTxErrorCode, message: string) {
    super(message)
    this.name = "SafeTxServiceError"
    this.code = code
  }
}

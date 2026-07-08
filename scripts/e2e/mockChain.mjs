import { decodeFunctionData, encodeFunctionResult, getAddress, isAddressEqual, numberToHex, parseAbi } from "viem"

const eth = 10n ** 18n

export const mockContracts = {
  safeToken: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe",
  staking: "0x115E78f160e1E3eF163B05C84562Fa16fA338509",
  merkleDrop: "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2",
}

export const mockValidators = [
  {
    address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
    label: "Core Contributors",
    status: "active",
    commission: 5,
    participationRate: 98,
    totalStake: 3000n * eth,
    userStake: 0n,
  },
  {
    address: "0x3D58a5475c1336b0A755c3aBd298CeB9b7BB9CDe",
    label: "Gnosis",
    status: "active",
    commission: 5,
    participationRate: 96,
    totalStake: 2000n * eth,
    userStake: 0n,
  },
]

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
])

const stakingAbi = parseAbi([
  "function withdrawDelay() view returns (uint128)",
  "function totalValidatorStakes(address validator) view returns (uint256)",
  "function stakes(address staker, address validator) view returns (uint256)",
  "function totalStakerStakes(address staker) view returns (uint256)",
  "function getPendingWithdrawals(address staker) view returns ((uint256 amount, uint256 claimableAt)[])",
  "function getNextClaimableWithdrawal(address staker) view returns (uint256 amount, uint256 claimableAt)",
  "function stake(address validator, uint256 amount)",
  "function initiateWithdrawal(address validator, uint256 amount)",
  "function claimWithdrawal()",
])

const merkleDropAbi = parseAbi([
  "function merkleRoot() view returns (bytes32)",
  "function cumulativeClaimed(address account) view returns (uint256)",
  "function claim(address account, uint256 cumulativeAmount, bytes32 expectedMerkleRoot, bytes32[] merkleProof)",
])

const safeAccountAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
])

const allAbis = [erc20Abi, stakingAbi, merkleDropAbi, safeAccountAbi]

export function createMockChain(seed = {}) {
  const now = Math.floor(Date.now() / 1000)
  const defaultAccount = getAddress(seed.account ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
  const state = {
    account: defaultAccount,
    blockNumber: 100n,
    cumulativeClaimed: 0n,
    merkleRoot: seed.merkleRoot ?? `0x${"11".repeat(32)}`,
    pendingWithdrawals: [...(seed.pendingWithdrawals ?? [])],
    rewardCumulativeAmount: seed.rewardCumulativeAmount ?? 8n * eth,
    safeBalance: seed.safeBalance ?? 100n * eth,
    safes: seed.safes ?? ["0x1111111111111111111111111111111111111111"],
    safeOwners: (seed.safeOwners ?? [defaultAccount]).map((owner) => getAddress(owner)),
    safeThreshold: seed.safeThreshold ?? 1n,
    agentRequests: 0,
    rpcCalls: [],
    stakingAllowance: seed.stakingAllowance ?? 0n,
    txIndex: 0n,
    validators: mockValidators.map((validator) => ({
      ...validator,
      address: getAddress(validator.address),
      userStake:
        seed.stakes?.[validator.address.toLowerCase()] ??
        (isAddressEqual(validator.address, mockValidators[0].address) ? (seed.coreStake ?? 20n * eth) : 0n),
    })),
    withdrawDelay: seed.withdrawDelay ?? 7n * 24n * 60n * 60n,
  }
  const receipts = new Map()

  function toAccountLivePayload(account = state.account) {
    const normalized = getAddress(account)
    const pending = state.pendingWithdrawals.filter((item) => isAddressEqual(item.account, normalized))
    const claimable = pending.find((item) => item.claimableAt <= BigInt(now))
    const validatorsWithPositions = state.validators.map((validator) => ({
      address: validator.address,
      commission: validator.commission,
      label: validator.label,
      participationRate: validator.participationRate,
      status: validator.status,
      totalStake: validator.totalStake,
      userStake: validator.userStake,
    }))
    return {
      health: {
        blockNumber: state.blockNumber,
        merkleRoot: state.merkleRoot,
        withdrawDelay: state.withdrawDelay,
      },
      snapshot: {
        cumulativeClaimed: state.cumulativeClaimed,
        nextClaimableWithdrawal: claimable
          ? { amount: claimable.amount, claimableAt: claimable.claimableAt }
          : { amount: 0n, claimableAt: 0n },
        pendingWithdrawals: pending.map(({ amount, claimableAt }) => ({ amount, claimableAt })),
        safeBalance: state.safeBalance,
        stakingAllowance: state.stakingAllowance,
        totalStaked: state.validators.reduce((sum, validator) => sum + validator.userStake, 0n),
        withdrawDelay: state.withdrawDelay,
      },
      validatorsWithPositions,
    }
  }

  function toRewardProofPayload() {
    if (state.rewardCumulativeAmount <= state.cumulativeClaimed) return null
    return {
      cumulativeAmount: state.rewardCumulativeAmount.toString(),
      merkleRoot: state.merkleRoot,
      proof: [],
    }
  }

  async function fulfillAccountLive(route) {
    const url = new URL(route.request().url())
    const account = url.searchParams.get("account") ?? state.account
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: stringifyBigints(toAccountLivePayload(account)),
    })
  }

  async function fulfillSafes(route) {
    const url = new URL(route.request().url())
    const safe = url.searchParams.get("safe")
    const metadata = (address) => ({
      address: getAddress(address),
      ownersCount: state.safeOwners.length,
      threshold: Number(state.safeThreshold),
    })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(safe ? { safe: metadata(safe) } : { safes: state.safes.map(metadata) }),
    })
  }

  async function fulfillAuthChallenge(route) {
    const body = await route.request().postDataJSON()
    const signer = body.signer ?? body.address ?? state.account
    const subject = body.subject ?? signer
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        challenge: "mock-challenge",
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        message: `Mock SafeCafe sign-in for ${signer}`,
        signer,
        subject,
        subjectKind: signer.toLowerCase() === subject.toLowerCase() ? "self" : "safe",
        strategy: "signed-wallet-access",
      }),
    })
  }

  async function fulfillAuthVerify(route) {
    const body = await route.request().postDataJSON()
    const signer = body.signer ?? body.address ?? state.account
    const subject = body.subject ?? signer
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        address: signer,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        signer,
        subject,
        subjectKind: signer.toLowerCase() === subject.toLowerCase() ? "self" : "safe",
        strategy: "signed-wallet-access",
        token: "mock-rpc-session",
      }),
    })
  }

  async function fulfillRewardProof(route) {
    const proof = toRewardProofPayload()
    if (!proof) {
      await route.fulfill({ status: 404, body: "" })
      return
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: stringifyBigints(proof) })
  }

  async function fulfillValidators(route) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        state.validators.map((validator) => ({
          address: validator.address,
          commission: validator.commission / 100,
          is_active: validator.status === "active",
          label: validator.label,
          participation_rate_14d: validator.participationRate / 100,
        })),
      ),
    })
  }

  async function fulfillRpc(route) {
    const body = await route.request().postDataJSON()
    const response = Array.isArray(body) ? body.map(handleRpcItem) : handleRpcItem(body)
    await route.fulfill({ status: 200, contentType: "application/json", body: stringifyBigints(response) })
  }

  async function fulfillAgent(route) {
    state.agentRequests += 1
    const request = route.request()
    let body = {}
    try {
      body = request.postDataJSON() ?? {}
    } catch {
      body = {}
    }
    const wantsStream = request.headers().accept?.includes("text/event-stream") === true || body?.stream === true
    const thinking = "Mock model reasoning for this staking response."
    const content = "Mock Agent stream complete. Every transaction still needs wallet confirmation."
    if (!wantsStream) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ content, thinking, source: "fallback" }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
      body:
        `data: ${JSON.stringify({ type: "thinking", content: thinking })}\n\n` +
        `data: ${JSON.stringify({ type: "delta", content: "Mock Agent stream " })}\n\n` +
        `data: ${JSON.stringify({ type: "delta", content: "complete." })}\n\n` +
        `data: ${JSON.stringify({ type: "final", content, source: "fallback" })}\n\n` +
        "data: [DONE]\n\n",
    })
  }

  function handleRpcItem(request) {
    const id = request?.id ?? null
    try {
      state.rpcCalls.push({ method: request?.method, params: request?.params })
      if (request?.method === "eth_chainId") return ok(id, "0x1")
      if (request?.method === "eth_blockNumber") return ok(id, numberToHex(state.blockNumber))
      if (request?.method === "eth_getTransactionByHash") {
        const hash = request.params?.[0]
        const receipt = receipts.get(hash)
        return ok(
          id,
          receipt
            ? {
                blockHash: receipt.blockHash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                gas: receipt.gasUsed,
                gasPrice: receipt.effectiveGasPrice,
                hash,
                input: "0x",
                nonce: "0x0",
                r: `0x${"00".repeat(32)}`,
                s: `0x${"00".repeat(32)}`,
                to: receipt.to,
                transactionIndex: receipt.transactionIndex,
                type: receipt.type,
                v: "0x0",
                value: "0x0",
              }
            : null,
        )
      }
      if (request?.method === "eth_getTransactionReceipt") {
        const hash = request.params?.[0]
        return ok(id, receipts.get(hash) ?? null)
      }
      if (request?.method === "eth_call") {
        const call = request.params?.[0]
        return ok(id, simulateCall(call?.from ?? state.account, call?.to, call?.data))
      }
      return error(id, -32601, `Unsupported mock RPC method ${request?.method}`)
    } catch (err) {
      return error(id, 3, err instanceof Error ? err.message : String(err))
    }
  }

  function simulateCall(from, to, data) {
    if (!to || !data || data === "0x") return "0x"
    const decoded = decodeKnownFunction(data)
    if (isAddressEqual(to, mockContracts.safeToken)) {
      if (decoded.functionName === "balanceOf") return encodeResult(erc20Abi, "balanceOf", state.safeBalance)
      if (decoded.functionName === "allowance") return encodeResult(erc20Abi, "allowance", state.stakingAllowance)
      if (decoded.functionName === "approve") return encodeResult(erc20Abi, "approve", true)
    }
    if (isAddressEqual(to, mockContracts.staking)) {
      return simulateStakingCall(from, decoded)
    }
    if (isAddressEqual(to, mockContracts.merkleDrop)) {
      return simulateMerkleCall(from, decoded)
    }
    if (state.safes.some((safe) => isAddressEqual(to, safe))) {
      return simulateSafeCall(from, decoded)
    }
    return "0x"
  }

  function simulateStakingCall(_from, decoded) {
    if (decoded.functionName === "withdrawDelay") return encodeResult(stakingAbi, "withdrawDelay", state.withdrawDelay)
    if (decoded.functionName === "stakes") {
      const [, validator] = decoded.args
      return encodeResult(stakingAbi, "stakes", validatorState(validator).userStake)
    }
    if (decoded.functionName === "totalValidatorStakes") {
      const [validator] = decoded.args
      return encodeResult(stakingAbi, "totalValidatorStakes", validatorState(validator).totalStake)
    }
    if (decoded.functionName === "totalStakerStakes") {
      return encodeResult(
        stakingAbi,
        "totalStakerStakes",
        state.validators.reduce((sum, validator) => sum + validator.userStake, 0n),
      )
    }
    if (decoded.functionName === "getPendingWithdrawals") {
      const [account] = decoded.args
      const pending = state.pendingWithdrawals.filter((item) => isAddressEqual(item.account, account))
      return encodeResult(
        stakingAbi,
        "getPendingWithdrawals",
        pending.map(({ amount, claimableAt }) => [amount, claimableAt]),
      )
    }
    if (decoded.functionName === "getNextClaimableWithdrawal") {
      const [account] = decoded.args
      const claimable = state.pendingWithdrawals.find(
        (item) => isAddressEqual(item.account, account) && item.claimableAt <= BigInt(now),
      )
      return encodeResult(stakingAbi, "getNextClaimableWithdrawal", [
        claimable ? claimable.amount : 0n,
        claimable ? claimable.claimableAt : 0n,
      ])
    }
    if (decoded.functionName === "stake") {
      const [, amount] = decoded.args
      ensure(state.stakingAllowance >= amount, "ERC20: insufficient allowance")
      ensure(state.safeBalance >= amount, "SAFE balance too low")
      return "0x"
    }
    if (decoded.functionName === "initiateWithdrawal") {
      const [validator, amount] = decoded.args
      ensure(validatorState(validator).userStake >= amount, "Stake too low")
      return "0x"
    }
    if (decoded.functionName === "claimWithdrawal") {
      ensure(
        state.pendingWithdrawals.some((item) => item.claimableAt <= BigInt(now)),
        "No claimable withdrawal",
      )
      return "0x"
    }
    return "0x"
  }

  function simulateMerkleCall(_from, decoded) {
    if (decoded.functionName === "merkleRoot") return encodeResult(merkleDropAbi, "merkleRoot", state.merkleRoot)
    if (decoded.functionName === "cumulativeClaimed") {
      return encodeResult(merkleDropAbi, "cumulativeClaimed", state.cumulativeClaimed)
    }
    if (decoded.functionName === "claim") {
      const [, cumulativeAmount, merkleRoot] = decoded.args
      ensure(String(merkleRoot).toLowerCase() === state.merkleRoot.toLowerCase(), "Merkle root mismatch")
      ensure(cumulativeAmount > state.cumulativeClaimed, "Rewards already claimed")
      return "0x"
    }
    return "0x"
  }

  function simulateSafeCall(from, decoded) {
    if (decoded.functionName === "getOwners") return encodeResult(safeAccountAbi, "getOwners", state.safeOwners)
    if (decoded.functionName === "getThreshold")
      return encodeResult(safeAccountAbi, "getThreshold", state.safeThreshold)
    if (decoded.functionName === "isOwner") {
      const [owner] = decoded.args
      return encodeResult(
        safeAccountAbi,
        "isOwner",
        state.safeOwners.some((safeOwner) => isAddressEqual(safeOwner, owner)),
      )
    }
    if (decoded.functionName === "execTransaction") {
      const [to, value, data, operation] = decoded.args
      ensure(
        state.safeOwners.some((owner) => isAddressEqual(owner, from)),
        "Signer is not Safe owner",
      )
      ensure(state.safeThreshold === 1n, "Safe threshold requires multiple owners")
      ensure(operation === 0, "Only Safe CALL operation is supported")
      ensure(value === 0n, "Only zero-value Safe transactions are supported")
      const nested = decodeKnownFunction(data)
      if (isAddressEqual(to, mockContracts.safeToken) && nested.functionName === "approve") return "0x"
      if (isAddressEqual(to, mockContracts.staking)) return simulateStakingCall(state.safes[0], nested)
      if (isAddressEqual(to, mockContracts.merkleDrop)) return simulateMerkleCall(state.safes[0], nested)
    }
    return "0x"
  }

  async function installWallet(page, account = state.account) {
    await page.addInitScript(
      ({ account: injectedAccount }) => {
        const listeners = new Map()
        let txNonce = 0
        window.__mockWalletPersonalSignCount = 0
        window.__mockWalletTransactions = []
        window.ethereum = {
          request: async ({ method, params }) => {
            if (method === "eth_chainId") return "0x1"
            if (method === "eth_accounts") return [injectedAccount]
            if (method === "eth_requestAccounts") return [injectedAccount]
            if (method === "wallet_switchEthereumChain") return null
            if (method === "personal_sign") {
              window.__mockWalletPersonalSignCount += 1
              return `0x${"11".repeat(65)}`
            }
            if (method === "eth_sendTransaction") {
              const tx = params?.[0]
              txNonce += 1
              const hash = `0x${txNonce.toString(16).padStart(64, "0")}`
              await window.safecafeApplyMockTransaction({ hash, tx })
              window.__mockWalletTransactions.push({ hash, tx })
              return hash
            }
            throw new Error(`Unexpected wallet method ${method} ${JSON.stringify(params)}`)
          },
          on: (event, handler) => {
            const current = listeners.get(event) ?? []
            current.push(handler)
            listeners.set(event, current)
          },
          removeListener: (event, handler) => {
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((item) => item !== handler),
            )
          },
        }
        window.localStorage.removeItem("safecafe:wallet-disconnected")
        window.localStorage.setItem(
          "safecafe:rpc-session",
          JSON.stringify({
            address: injectedAccount,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            signer: injectedAccount,
            subject: injectedAccount,
            subjectKind: "self",
            token: "mock-rpc-session",
          }),
        )
      },
      { account },
    )
    await page.exposeFunction("safecafeApplyMockTransaction", ({ hash, tx }) => applyTransaction(account, tx, hash))
  }

  function applyTransaction(from, tx, hash) {
    const account = getAddress(from)
    const to = getAddress(tx.to)
    const data = tx.data
    const decoded = decodeKnownFunction(data)
    if (isAddressEqual(to, mockContracts.safeToken) && decoded.functionName === "approve") {
      const [spender, amount] = decoded.args
      ensure(isAddressEqual(spender, mockContracts.staking), "Only staking allowance is supported")
      state.stakingAllowance = amount
    } else if (isAddressEqual(to, mockContracts.staking)) {
      applyStakingTransaction(account, decoded)
    } else if (isAddressEqual(to, mockContracts.merkleDrop)) {
      applyMerkleTransaction(account, decoded)
    } else if (state.safes.some((safe) => isAddressEqual(to, safe))) {
      applySafeTransaction(account, decoded)
    } else {
      throw new Error(`Unsupported mock transaction target ${to}`)
    }
    state.blockNumber += 1n
    receipts.set(hash, {
      blockHash: `0x${"aa".repeat(32)}`,
      blockNumber: numberToHex(state.blockNumber),
      contractAddress: null,
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      from: account,
      gasUsed: "0x5208",
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "success",
      to,
      transactionHash: hash,
      transactionIndex: "0x0",
      type: "0x2",
    })
  }

  function applyStakingTransaction(account, decoded) {
    if (decoded.functionName === "stake") {
      const [validator, amount] = decoded.args
      ensure(state.stakingAllowance >= amount, "ERC20: insufficient allowance")
      ensure(state.safeBalance >= amount, "SAFE balance too low")
      const target = validatorState(validator)
      state.safeBalance -= amount
      state.stakingAllowance -= amount
      target.userStake += amount
      target.totalStake += amount
      return
    }
    if (decoded.functionName === "initiateWithdrawal") {
      const [validator, amount] = decoded.args
      const target = validatorState(validator)
      ensure(target.userStake >= amount, "Stake too low")
      target.userStake -= amount
      target.totalStake -= amount
      state.pendingWithdrawals.push({ account, amount, claimableAt: BigInt(now) })
      return
    }
    if (decoded.functionName === "claimWithdrawal") {
      const index = state.pendingWithdrawals.findIndex(
        (item) => isAddressEqual(item.account, account) && item.claimableAt <= BigInt(now),
      )
      ensure(index >= 0, "No claimable withdrawal")
      const [withdrawal] = state.pendingWithdrawals.splice(index, 1)
      state.safeBalance += withdrawal.amount
      return
    }
    throw new Error(`Unsupported staking transaction ${decoded.functionName}`)
  }

  function applyMerkleTransaction(account, decoded) {
    if (decoded.functionName !== "claim") throw new Error(`Unsupported merkle transaction ${decoded.functionName}`)
    const [claimAccount, cumulativeAmount, merkleRoot] = decoded.args
    ensure(isAddressEqual(claimAccount, account), "Reward claim account mismatch")
    ensure(String(merkleRoot).toLowerCase() === state.merkleRoot.toLowerCase(), "Merkle root mismatch")
    ensure(cumulativeAmount > state.cumulativeClaimed, "Rewards already claimed")
    state.safeBalance += cumulativeAmount - state.cumulativeClaimed
    state.cumulativeClaimed = cumulativeAmount
  }

  function applySafeTransaction(account, decoded) {
    if (decoded.functionName !== "execTransaction")
      throw new Error(`Unsupported Safe transaction ${decoded.functionName}`)
    const [to, value, data, operation] = decoded.args
    ensure(
      state.safeOwners.some((owner) => isAddressEqual(owner, account)),
      "Signer is not Safe owner",
    )
    ensure(state.safeThreshold === 1n, "Safe threshold requires multiple owners")
    ensure(operation === 0, "Only Safe CALL operation is supported")
    ensure(value === 0n, "Only zero-value Safe transactions are supported")
    const safeAccount = state.safes[0]
    const nested = decodeKnownFunction(data)
    if (isAddressEqual(to, mockContracts.safeToken) && nested.functionName === "approve") {
      const [spender, amount] = nested.args
      ensure(isAddressEqual(spender, mockContracts.staking), "Only staking allowance is supported")
      state.stakingAllowance = amount
      return
    }
    if (isAddressEqual(to, mockContracts.staking)) {
      applyStakingTransaction(safeAccount, nested)
      return
    }
    if (isAddressEqual(to, mockContracts.merkleDrop)) {
      applyMerkleTransaction(safeAccount, nested)
      return
    }
    throw new Error(`Unsupported Safe nested target ${to}`)
  }

  function validatorState(address) {
    const validator = state.validators.find((item) => isAddressEqual(item.address, address))
    ensure(validator, `Unknown validator ${address}`)
    return validator
  }

  return {
    applyTransaction,
    fulfillAgent,
    fulfillAccountLive,
    fulfillAuthChallenge,
    fulfillAuthVerify,
    fulfillRewardProof,
    fulfillSafes,
    fulfillRpc,
    fulfillValidators,
    installWallet,
    state,
    toAccountLivePayload,
    toRewardProofPayload,
  }
}

function decodeKnownFunction(data) {
  for (const abi of allAbis) {
    try {
      return decodeFunctionData({ abi, data })
    } catch {
      // Try the next ABI.
    }
  }
  throw new Error(`Unsupported calldata ${data}`)
}

function encodeResult(abi, functionName, result) {
  return encodeFunctionResult({ abi, functionName, result })
}

function ok(id, result) {
  return { id, jsonrpc: "2.0", result }
}

function error(id, code, message) {
  return { error: { code, message }, id, jsonrpc: "2.0" }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

export function stringifyBigints(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
}

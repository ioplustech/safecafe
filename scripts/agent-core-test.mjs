import assert from "node:assert/strict"
import { privateKeyToAccount } from "viem/accounts"

import {
  compileAgentPlan,
  flattenCurrentExecutableTxPlan,
  flattenExecutableTxPlan,
  parseAgentInstruction,
  resolveAgentAmount,
  resolveAgentValidator,
} from "../src/agent/index.ts"
import {
  createSafenetPublicClient,
  DEFAULT_RPC_URLS,
  isTxPlanForAccount,
  readAccountSnapshot,
  readHealth,
} from "../src/protocol/index.ts"
import { mockAccount, mockSummary, mockValidators } from "../src/protocol/mockData.ts"
import { handleAccountLiveRequest } from "../src/server/accountLive.ts"
import { handleAgentApiRequest, sanitizeAgentContent } from "../src/server/agentApi.ts"
import {
  handleEthereumRpcGatewayRequest,
  handleRpcChallengeRequest,
  handleRpcVerifyRequest,
} from "../src/server/rpcGateway.ts"

function ok(input) {
  const result = parseAgentInstruction(input, mockValidators)
  assert.equal(result.status, "ok", input)
  return result.intent
}

assert.deepEqual(ok("stake 100 safe to Core Contributors"), {
  kind: "stake",
  amount: { type: "safe", value: "100" },
  validator: { type: "label", value: "Core Contributors" },
})
assert.deepEqual(ok("unstake 25% from Gnosis"), {
  kind: "unstake",
  amount: { type: "percent-validator-stake", value: 25 },
  validator: { type: "label", value: "Gnosis" },
})
assert.deepEqual(ok("claim rewards"), { kind: "claim-rewards" })
assert.deepEqual(ok("领取奖励"), { kind: "claim-rewards" })
assert.deepEqual(ok("claim withdrawal"), { kind: "claim-withdrawal" })
assert.deepEqual(ok("claim rewards and restake all to best validator"), {
  kind: "restake-rewards",
  amount: { type: "all-claimable-rewards" },
  validator: { type: "best-active" },
})
assert.deepEqual(ok("move 500 safe from Gnosis to Core Contributors"), {
  kind: "rebalance",
  from: { type: "label", value: "Gnosis" },
  to: { type: "label", value: "Core Contributors" },
  amount: { type: "safe", value: "500" },
})
assert.deepEqual(ok("质押 100 safe 到 Core Contributors"), {
  kind: "stake",
  amount: { type: "safe", value: "100" },
  validator: { type: "label", value: "Core Contributors" },
})

const unsupported = parseAgentInstruction("bridge SAFE to arbitrum", mockValidators)
assert.equal(unsupported.status, "blocked")
assert.equal(unsupported.risks[0].code, "unsupported-operation")
assert.equal(parseAgentInstruction("automatically stake 100 SAFE every day", mockValidators).status, "blocked")
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors every month", mockValidators).status, "blocked")
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors monthly", mockValidators).status, "blocked")
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors tomorrow", mockValidators).status, "blocked")
assert.equal(
  parseAgentInstruction("stake 100 SAFE to Core Contributors in 10 minutes", mockValidators).status,
  "blocked",
)
assert.equal(
  parseAgentInstruction("stake 100 SAFE to Core Contributors every Friday", mockValidators).status,
  "blocked",
)
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors at 9pm", mockValidators).status, "blocked")
assert.equal(
  parseAgentInstruction("submit for me and stake 100 SAFE to Core Contributors", mockValidators).status,
  "blocked",
)
assert.equal(parseAgentInstruction("每天自动复投奖励", mockValidators).status, "blocked")
assert.equal(
  parseAgentInstruction("please sign for me and stake 100 SAFE to Core Contributors", mockValidators).status,
  "blocked",
)

const empty = parseAgentInstruction("   ", mockValidators)
assert.equal(empty.status, "needs-clarification")

const eth = 10n ** 18n
const amountContext = {
  summary: {
    safeBalance: 1000n * eth,
    totalStaked: 2000n * eth,
    pendingWithdrawals: 0n,
    claimableWithdrawals: 0n,
    claimableRewards: 50n * eth,
    withdrawDelay: 0n,
  },
}
const core = mockValidators[0]
assert.equal(resolveAgentAmount({ type: "percent-wallet", value: 25 }, amountContext, core).text, "250")
assert.equal(resolveAgentAmount({ type: "percent-validator-stake", value: 50 }, amountContext, core).text, "1000")
assert.equal(resolveAgentAmount({ type: "all-claimable-rewards" }, amountContext, core).text, "50")
assert.equal(resolveAgentValidator({ type: "best-active" }, mockValidators).validator.label, "Core Contributors")

const agentContext = {
  account: mockAccount,
  chainId: 1,
  liveBlock: 123n,
  liveSnapshot: {
    safeBalance: mockSummary.safeBalance,
    totalStaked: mockSummary.totalStaked,
    pendingWithdrawals: [],
    nextClaimableWithdrawal: { amount: mockSummary.claimableWithdrawals, claimableAt: 0n },
    cumulativeClaimed: 0n,
    withdrawDelay: mockSummary.withdrawDelay,
    stakingAllowance: 0n,
  },
  summary: mockSummary,
  validators: mockValidators,
  rewardProof: {
    cumulativeAmount: String(mockSummary.claimableRewards),
    merkleRoot: `0x${"11".repeat(32)}`,
    proof: [`0x${"22".repeat(32)}`],
  },
  liveMerkleRoot: `0x${"11".repeat(32)}`,
}

const stakePlan = compileAgentPlan(
  "stake 100 safe to Core Contributors",
  ok("stake 100 safe to Core Contributors"),
  agentContext,
)
assert.equal(
  stakePlan.risks.some((risk) => risk.severity === "blocked"),
  false,
)
assert.equal(flattenExecutableTxPlan(stakePlan)?.txs.length, 2)
assert.equal(flattenExecutableTxPlan(stakePlan)?.action, "agent-plan")
assert.equal(isTxPlanForAccount(flattenExecutableTxPlan(stakePlan), mockAccount), true)
assert.equal(isTxPlanForAccount(flattenExecutableTxPlan(stakePlan), `0x${"12".repeat(20)}`), false)

const claimPlan = compileAgentPlan("claim rewards", ok("claim rewards"), agentContext)
assert.equal(flattenExecutableTxPlan(claimPlan)?.action, "agent-plan")

const restakePlan = compileAgentPlan(
  "claim rewards and restake all to best validator",
  ok("claim rewards and restake all to best validator"),
  agentContext,
)
assert.equal(restakePlan.phases.length, 2)
assert.equal(restakePlan.phases[1].executableNow, false)
assert.equal(flattenExecutableTxPlan(restakePlan), null)
assert.equal(flattenCurrentExecutableTxPlan(restakePlan)?.action, "agent-plan")

const rebalancePlan = compileAgentPlan(
  "move 500 safe from Gnosis to Core Contributors",
  ok("move 500 safe from Gnosis to Core Contributors"),
  agentContext,
)
assert.equal(rebalancePlan.phases.length, 2)
assert.equal(rebalancePlan.phases[1].executableNow, false)
assert.equal(flattenExecutableTxPlan(rebalancePlan), null)
assert.equal(flattenCurrentExecutableTxPlan(rebalancePlan)?.action, "agent-plan")

const disconnectedPlan = compileAgentPlan(
  "claim rewards",
  { kind: "claim-rewards" },
  { ...agentContext, account: null },
)
assert.equal(disconnectedPlan.risks[0].code, "wallet-required")

const safeLlmFallback =
  "I can only help draft a reviewable staking plan. Every on-chain action must be confirmed in your wallet."
assert.equal(sanitizeAgentContent("I'll submit the transaction for you."), safeLlmFallback)
assert.equal(sanitizeAgentContent("call data"), safeLlmFallback)
assert.equal(sanitizeAgentContent("transaction data"), safeLlmFallback)
assert.equal(sanitizeAgentContent("transaction data: 0xabcdefabcdefabcdefabcdefabcdefabcdef"), safeLlmFallback)
assert.equal(sanitizeAgentContent("我可以替你提交交易。"), safeLlmFallback)
assert.equal(sanitizeAgentContent("请帮我代提交交易。"), safeLlmFallback)
assert.equal(
  sanitizeAgentContent("You can review the staking plan before signing."),
  "You can review the staking plan before signing.",
)

assert.equal(DEFAULT_RPC_URLS[0], "https://ethereum-rpc.publicnode.com")
assert.equal(createSafenetPublicClient({ authToken: "test-token" }).transport.type, "http")
assert.equal(createSafenetPublicClient({ authToken: "test-token" }).transport.url, "/api/rpc/ethereum")
assert.equal(createSafenetPublicClient().transport.type, "fallback")
assert.equal(createSafenetPublicClient({ rpcUrl: "/api/rpc/ethereum" }).transport.type, "fallback")

const fakeClient = {
  multicallCalls: [],
  readContractCalls: [],
  async getBlockNumber() {
    return 123n
  },
  async multicall(input) {
    this.multicallCalls.push(input)
    if (input.contracts.length === 7) {
      return [1n, 2n, [], [0n, 0n], 3n, 4n, 5n]
    }
    if (input.contracts.length === 2) {
      return [6n, `0x${"11".repeat(32)}`]
    }
    throw new Error(`Unexpected multicall size: ${input.contracts.length}`)
  },
  async readContract(input) {
    this.readContractCalls.push(input)
    throw new Error("readContract should not be used for aggregated startup reads")
  },
}
const fakeSnapshot = await readAccountSnapshot(fakeClient, mockAccount)
assert.equal(fakeSnapshot.safeBalance, 1n)
const fakeHealth = await readHealth(fakeClient)
assert.equal(fakeHealth.blockNumber, 123n)
assert.equal(fakeClient.multicallCalls.length, 2)
assert.equal(fakeClient.readContractCalls.length, 0)

const lockedAgentResponse = await handleAgentApiRequest(
  new Request("http://localhost/api/agent", {
    method: "POST",
    body: JSON.stringify({
      message: "hello",
      context: { agentAccess: "locked", hasLiveSnapshot: false, validatorLabels: [] },
    }),
  }),
  {
    SAFECAFE_LLM_API_BASE: "https://example.invalid",
    SAFECAFE_LLM_API_MODEL: "test",
    SAFECAFE_LLM_API_KEY: "secret",
  },
)
assert.equal(lockedAgentResponse.status, 200)
assert.equal((await lockedAgentResponse.json()).source, "fallback")

const tooLargeResponse = await handleAgentApiRequest(
  new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-length": "24001" },
    body: "{}",
  }),
  {},
)
assert.equal(tooLargeResponse.status, 413)

const invalidJsonResponse = await handleAgentApiRequest(
  new Request("http://localhost/api/agent", { method: "POST", body: "{" }),
  {},
)
assert.equal(invalidJsonResponse.status, 400)

const originalFetch = globalThis.fetch
let upstreamCalls = 0
let unsafeStream = false
let rpcGatewayCalls = 0
let rpcErrorCalls = 0
const safeOwnerCallSelector = "0x2f54bf6e"
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"))
  if (body.id === 9 && body.method === "eth_getBalance") {
    return new Response("bad gateway", { status: 502 })
  }
  if (body.method === "eth_blockNumber") {
    rpcGatewayCalls += 1
    if (rpcGatewayCalls === 1) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32046, message: "Cannot fulfill request" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x7b" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (Array.isArray(body)) {
    return new Response(
      JSON.stringify(
        body.map((item) => ({
          jsonrpc: "2.0",
          id: item.id,
          result: `0x${(10n ** 18n).toString(16)}`,
        })),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (body.method === "eth_call") {
    if (body.params?.[0]?.data === "0xdeadbeef") {
      rpcErrorCalls += 1
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (typeof body.params?.[0]?.data === "string" && body.params[0].data.startsWith(safeOwnerCallSelector)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"0".repeat(63)}1` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${(10n ** 18n).toString(16).padStart(64, "0")}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }
  upstreamCalls += 1
  if (body.stream) {
    if (unsafeStream) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"I\\u0027ll "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"submit the transaction for you."}}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"Review "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"before signing."}}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "Review this plan before signing." } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}
try {
  const forgedEligibleAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "hello",
        context: { account: mockAccount, agentAccess: "eligible", hasLiveSnapshot: true, validatorLabels: [] },
      }),
    }),
    {
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const forgedEligibleAgentJson = await forgedEligibleAgentResponse.json()
  assert.equal(forgedEligibleAgentJson.source, "fallback")
  assert.equal(forgedEligibleAgentJson.thinking.includes("Authenticated wallet session is required"), true)

  unsafeStream = true
  const unsafeStreamResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({
        message: "help",
        stream: true,
        context: { account: mockAccount, hasLiveSnapshot: true, validatorLabels: [] },
      }),
    }),
    {
      SAFECAFE_AGENT_TEST_VERIFIED_ACCESS: "true",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const unsafeStreamText = await unsafeStreamResponse.text()
  assert.equal(unsafeStreamText.includes("submit the transaction for you"), false)
  assert.equal(unsafeStreamText.includes('"type":"final"'), true)

  const unauthenticatedRpc = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { "x-request-id": "test-rpc-unauthenticated" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret" },
  )
  assert.equal(unauthenticatedRpc.status, 401)
  assert.equal(unauthenticatedRpc.headers.get("x-request-id"), "test-rpc-unauthenticated")
  const unauthenticatedRpcJson = await unauthenticatedRpc.json()
  assert.equal(unauthenticatedRpcJson.error.data.requestId, "test-rpc-unauthenticated")
  assert.equal(unauthenticatedRpcJson.error.data.reason, "authentication_required")

  const blockedMethod = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: "Bearer bad-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret" },
  )
  assert.equal(blockedMethod.status, 401)

  const testAccount = privateKeyToAccount(`0x${"11".repeat(32)}`)
  const challengeResponse = await handleRpcChallengeRequest(
    new Request("http://localhost/api/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: testAccount.address, chainId: 1 }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal(challengeResponse.status, 200)
  const challenge = await challengeResponse.json()
  const tamperedMessage = challenge.message.replace("Sign in to SafeCafe RPC Gateway.", "Sign in somewhere else.")
  const tamperedSignature = await testAccount.signMessage({ message: tamperedMessage })
  const tamperedVerifyResponse = await handleRpcVerifyRequest(
    new Request("http://localhost/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        address: testAccount.address,
        challenge: challenge.challenge,
        message: tamperedMessage,
        signature: tamperedSignature,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal(tamperedVerifyResponse.status, 401)
  assert.equal((await tamperedVerifyResponse.json()).error, "Challenge message does not match.")
  const signature = await testAccount.signMessage({ message: challenge.message })
  const verifyResponse = await handleRpcVerifyRequest(
    new Request("http://localhost/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        address: testAccount.address,
        challenge: challenge.challenge,
        message: challenge.message,
        signature,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal(verifyResponse.status, 200)
  const session = await verifyResponse.json()
  assert.equal(session.signer, testAccount.address)
  assert.equal(session.subject, testAccount.address)
  assert.equal(session.subjectKind, "self")

  const authenticatedAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        message: "hello",
        context: {
          account: testAccount.address,
          subjectAccount: testAccount.address,
          agentAccess: "eligible",
          hasLiveSnapshot: true,
          validatorLabels: [],
        },
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const authenticatedAgentJson = await authenticatedAgentResponse.json()
  assert.equal(authenticatedAgentJson.source, "llm")
  assert.equal(authenticatedAgentJson.thinking.includes("Server-side RPC is not configured"), false)

  const streamUpstreamCallsBefore = upstreamCalls
  const streamResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { accept: "text/event-stream", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        message: "help",
        stream: true,
        context: {
          account: testAccount.address,
          subjectAccount: testAccount.address,
          agentAccess: "eligible",
          hasLiveSnapshot: true,
          hasStakingPosition: true,
          validatorLabels: [],
        },
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  assert.equal(streamResponse.headers.get("content-type")?.includes("text/event-stream"), true)
  const streamText = await streamResponse.text()
  assert.equal(streamText.includes('"type":"thinking"'), true)
  assert.equal(streamText.includes('"type":"final"'), true)
  assert.equal(upstreamCalls - streamUpstreamCallsBefore, 1)

  const authenticatedRpc = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal(authenticatedRpc.status, 200)
  assert.equal((await authenticatedRpc.json()).result, "0x7b")
  assert.equal(rpcGatewayCalls, 2)

  const revertedRpc = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{ to: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe", data: "0xdeadbeef" }, "latest"],
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_RPC_URLS: "https://rpc-one.example,https://rpc-two.example",
    },
  )
  const revertedRpcJson = await revertedRpc.json()
  assert.equal(revertedRpcJson.error.message, "execution reverted")
  assert.equal(rpcErrorCalls, 1)

  const accountLiveResponse = await handleAccountLiveRequest(
    new Request(`http://localhost/api/account/live?account=${testAccount.address}`),
    { SAFECAFE_MOCK_ACCOUNT_LIVE: "true" },
  )
  assert.equal(accountLiveResponse.status, 200)
  assert.equal(accountLiveResponse.headers.get("cache-control"), "no-store")

  const authenticatedBlockedMethod = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "x-request-id": "test-rpc-blocked-method" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal(authenticatedBlockedMethod.headers.get("x-request-id"), "test-rpc-blocked-method")
  const authenticatedBlockedMethodJson = await authenticatedBlockedMethod.json()
  assert.equal(authenticatedBlockedMethodJson.error.code, -32601)
  assert.equal(authenticatedBlockedMethodJson.error.data.reason, "method_not_allowed")

  const upstreamFailure = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "x-request-id": "test-rpc-upstream-failure" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "eth_getBalance",
        params: [testAccount.address, "latest"],
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_RPC_URLS: "https://rpc-fail-one.example,https://rpc-fail-two.example",
    },
  )
  assert.equal(upstreamFailure.status, 200)
  assert.equal(upstreamFailure.headers.get("x-request-id"), "test-rpc-upstream-failure")
  const upstreamFailureJson = await upstreamFailure.json()
  assert.equal(upstreamFailureJson.error.code, -32002)
  assert.equal(upstreamFailureJson.error.data.requestId, "test-rpc-upstream-failure")
  assert.equal(upstreamFailureJson.error.data.reason, "upstream_unavailable")
  assert.equal(upstreamFailureJson.error.data.attempts >= 2, true)

  const authenticatedBlockedTarget = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: `0x${"33".repeat(20)}`, data: "0x" }, "latest"],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal((await authenticatedBlockedTarget.json()).error.message, "eth_call target is not allowed.")

  const managedSafe = `0x${"44".repeat(20)}`
  const safeChallengeResponse = await handleRpcChallengeRequest(
    new Request("http://localhost/api/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ chainId: 1, signer: testAccount.address, subject: managedSafe }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  assert.equal(safeChallengeResponse.status, 200)
  const safeChallenge = await safeChallengeResponse.json()
  assert.equal(safeChallenge.signer, testAccount.address)
  assert.equal(safeChallenge.subject, managedSafe)
  assert.equal(safeChallenge.subjectKind, "safe")
  assert.equal(safeChallenge.message.includes(`Staking Subject: ${managedSafe}`), true)
  const safeSignature = await testAccount.signMessage({ message: safeChallenge.message })
  const safeVerifyResponse = await handleRpcVerifyRequest(
    new Request("http://localhost/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        challenge: safeChallenge.challenge,
        message: safeChallenge.message,
        signature: safeSignature,
        signer: testAccount.address,
        subject: managedSafe,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  assert.equal(safeVerifyResponse.status, 200)
  const safeSession = await safeVerifyResponse.json()
  assert.equal(safeSession.signer, testAccount.address)
  assert.equal(safeSession.subject, managedSafe)
  assert.equal(safeSession.subjectKind, "safe")
} finally {
  globalThis.fetch = originalFetch
}

console.log("Agent core tests passed")

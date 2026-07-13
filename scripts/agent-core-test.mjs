import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { encodeFunctionData } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { isDefaultApiCorsOrigin } from "../functions/api/_middleware.ts"
import {
  compileAgentPlan,
  flattenCurrentExecutableTxPlan,
  flattenExecutableTxPlan,
  parseAgentInstruction,
  readStoredAgentSessions,
  requestAgentReplyStream,
  resolveAgentAmount,
  resolveAgentValidator,
  serializeAgentSessions,
  shouldRouteClarificationToAgentReply,
  toAgentChatContext,
} from "../src/agent/index.ts"
import { chainActionBusyLabel, chainTxStepStatuses } from "../src/app/actionStatus.ts"
import { readableRpcAuthError, readableSimulationError } from "../src/app/formatters.ts"
import { readCachedLiveData, writeCachedLiveData } from "../src/app/liveDataCache.ts"
import {
  appStorageKeys,
  readStorageAddress,
  readStorageEnum,
  readStorageFlag,
  readStoredWalletSubject,
  removeStorageValue,
  writeStorageAddress,
  writeStorageFlag,
  writeStorageJson,
  writeStorageText,
  writeStoredWalletSubject,
} from "../src/app/persistence.ts"
import { resolveEnsTrustStatus } from "../src/app/releaseTrust.ts"
import { RpcAuthError } from "../src/app/rpcAuth.ts"
import { defaultSafeSubjectInput } from "../src/app/safeSelection.ts"
import { isUserSafeApiKeyRejected, resolveUserSafeApiSave } from "../src/app/userSafeApiKey.ts"
import { findPreferredRestakeValidator } from "../src/app/validatorSelection.ts"
import {
  CONTRACTS,
  createSafenetPublicClient,
  DEFAULT_RPC_URLS,
  isTxPlanForAccount,
  readAccountSnapshot,
  readHealth,
  safeAccountAbi,
} from "../src/protocol/index.ts"
import { mockAccount, mockSummary, mockValidators } from "../src/protocol/mockData.ts"
import { handleAccountLiveRequest } from "../src/server/accountLive.ts"
import { handleAgentApiRequest, sanitizeAgentContent } from "../src/server/agentApi.ts"
import { handleAgentFeedbackRequest } from "../src/server/agentFeedback.ts"
import { handleRewardProofRequest, readRewardProof } from "../src/server/rewardsProof.ts"
import {
  handleEthereumRpcGatewayRequest,
  handleRpcChallengeRequest,
  handleRpcVerifyRequest,
} from "../src/server/rpcGateway.ts"
import { rpcPoolTestHooks, rpcUrls } from "../src/server/rpcPool.ts"
import { handleSafeTxServiceRequest } from "../src/server/safeTxService.ts"
import { handleValidatorsRequest, readValidatorMetadata, validatorMetadataTestHooks } from "../src/server/validators.ts"
import { apiUrl, isSafecafeStaticFrontendHost } from "../src/shared/apiUrl.ts"
import { assertSuccessfulReceipt } from "../src/shared/cli.ts"

function parseServerSentEvents(text) {
  return text
    .split("\n\n")
    .map((eventText) =>
      eventText
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6),
    )
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data))
}

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
assert.deepEqual(ok("restake rewards to Core Contributors"), {
  kind: "restake-rewards",
  amount: { type: "all-claimable-rewards" },
  validator: { type: "label", value: "Core Contributors" },
})
assert.deepEqual(ok("全部复投到 Core Contributors"), {
  kind: "restake-rewards",
  amount: { type: "all-claimable-rewards" },
  validator: { type: "label", value: "Core Contributors" },
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
assert.equal(unsupported.status, "needs-clarification")
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
const generalChat = parseAgentInstruction("你好", mockValidators)
assert.equal(generalChat.status, "needs-clarification")
assert.equal(shouldRouteClarificationToAgentReply(generalChat.question), true)
const incompleteStake = parseAgentInstruction("stake 100 SAFE", mockValidators)
assert.equal(incompleteStake.status, "needs-clarification")
assert.equal(shouldRouteClarificationToAgentReply(incompleteStake.question), false)
const incompleteRestake = parseAgentInstruction("复投", mockValidators)
assert.equal(incompleteRestake.status, "needs-clarification")
assert.equal(incompleteRestake.question, "Which validator should receive restaked rewards?")
assert.equal(shouldRouteClarificationToAgentReply(incompleteRestake.question), false)

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
  subjectAccount: mockAccount,
  subjectKind: "self",
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

const agentChatContext = toAgentChatContext(agentContext)
assert.deepEqual(agentChatContext.stakingSummary, {
  safeBalance: "1250",
  totalStaked: "8400",
  pendingWithdrawals: "320",
  claimableWithdrawals: "210",
  claimableRewards: "95",
  withdrawDelaySeconds: "604800",
})
assert.deepEqual(
  agentChatContext.stakingPositions.map((position) => ({
    label: position.label,
    status: position.status,
    userStake: position.userStake,
  })),
  [
    { label: "Core Contributors", status: "active", userStake: "2000" },
    { label: "Gnosis", status: "active", userStake: "3500" },
    { label: "Greenfield", status: "active", userStake: "2900" },
  ],
)
assert.equal(findPreferredRestakeValidator(agentContext.validators)?.label, "Gnosis")
assert.equal(
  findPreferredRestakeValidator(agentContext.validators.map((validator) => ({ ...validator, userStake: 0n })))?.label,
  "Core Contributors",
)

const restakePlan = compileAgentPlan(
  "claim rewards and restake all to best validator",
  ok("claim rewards and restake all to best validator"),
  agentContext,
)
assert.equal(restakePlan.phases.length, 2)
assert.equal(
  restakePlan.phases.every((phase) => phase.executableNow),
  true,
)
assert.equal(flattenExecutableTxPlan(restakePlan)?.action, "agent-plan")
assert.equal(flattenExecutableTxPlan(restakePlan)?.txs.length, 3)
assert.equal(flattenCurrentExecutableTxPlan(restakePlan)?.action, "agent-plan")

const noRewardRestakePlan = compileAgentPlan(
  "claim rewards and restake all to best validator",
  ok("claim rewards and restake all to best validator"),
  {
    ...agentContext,
    summary: { ...agentContext.summary, claimableRewards: 0n },
    rewardProof: { ...agentContext.rewardProof, cumulativeAmount: "0" },
  },
)
assert.equal(noRewardRestakePlan.phases.length, 0)
assert.equal(
  noRewardRestakePlan.risks.some((risk) => risk.code === "no-claimable-rewards-direct-stake"),
  true,
)
assert.equal(
  noRewardRestakePlan.risks.some((risk) => risk.severity === "blocked"),
  false,
)
assert.equal(flattenExecutableTxPlan(noRewardRestakePlan), null)

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
const longComposerText = "draft ".repeat(1200)
const storedSessions = serializeAgentSessions([
  {
    composerText: "stake draft",
    draft: stakePlan,
    draftKey: "stale",
    executablePlan: flattenExecutableTxPlan(stakePlan),
    id: "session-a",
    messages: [
      { id: "message-a", role: "user", content: "hello" },
      {
        id: "message-b",
        role: "assistant",
        content: "line\n".repeat(8).trim(),
        contentExpanded: false,
        thinking: "reasoning",
        thinkingOpen: true,
        thinkingPinned: true,
      },
      { id: "message-c", role: "tool", content: "loading", isLoading: true },
    ],
    pendingIntentText: "stake 100 safe",
    title: "Saved session",
    warningsAccepted: true,
  },
  {
    composerText: longComposerText,
    draft: null,
    draftKey: "",
    executablePlan: null,
    id: "session-b",
    messages: [],
    pendingIntentText: "",
    title: "Long draft",
    warningsAccepted: false,
  },
])
assert.equal(storedSessions[0].composerText, "stake draft")
assert.equal(storedSessions[1].composerText.length, 6000)
assert.equal(storedSessions[0].draft?.phases.length, stakePlan.phases.length)
assert.equal(storedSessions[0].executablePlan?.txs.length, flattenExecutableTxPlan(stakePlan)?.txs.length)
assert.equal(storedSessions[0].draftKey, "stale")
assert.equal(storedSessions[0].pendingIntentText, "stake 100 safe")
assert.equal(storedSessions[0].warningsAccepted, true)
assert.equal(storedSessions[0].messages.length, 3)
assert.equal(storedSessions[0].messages[1].contentExpanded, false)
assert.equal(storedSessions[0].messages[1].thinkingOpen, true)
assert.equal(storedSessions[0].messages[2].isLoading, false)
const storedSessionsJson = JSON.stringify(storedSessions)
const restoredSessions = readStoredAgentSessions(JSON.stringify(storedSessions), "New session")
assert.equal(restoredSessions[0].id, "session-a")
assert.equal(restoredSessions[0].title, "Saved session")
assert.equal(restoredSessions[0].composerText, "stake draft")
assert.equal(restoredSessions[0].draft?.phases.length, stakePlan.phases.length)
assert.equal(restoredSessions[0].draft?.createdAtBlock, stakePlan.createdAtBlock)
assert.equal(restoredSessions[0].executablePlan?.txs.length, flattenExecutableTxPlan(stakePlan)?.txs.length)
assert.equal(restoredSessions[0].executablePlan?.txs[0].value, 0n)
assert.equal(restoredSessions[0].draftKey, "stale")
assert.equal(restoredSessions[0].pendingIntentText, "stake 100 safe")
assert.equal(restoredSessions[0].warningsAccepted, true)
assert.equal(restoredSessions[1].composerText, longComposerText.slice(0, 6000))
assert.equal(restoredSessions[0].messages[1].content, "line\n".repeat(8).trim())
assert.equal(restoredSessions[0].messages[1].contentExpanded, false)
assert.equal(restoredSessions[0].messages[1].thinking, "reasoning")
assert.equal(storedSessionsJson.includes('"value":"0"'), true)
assert.equal(
  readStoredAgentSessions(
    JSON.stringify([
      {
        id: "expanded-by-default",
        messages: [{ id: "message-default", role: "assistant", content: "long content" }],
        title: "Expanded by default",
      },
    ]),
    "New session",
  )[0].messages[0].contentExpanded,
  undefined,
)
assert.equal(readStoredAgentSessions("not json", "New session")[0].title, "New session")

const safeLlmFallback =
  "I can only help prepare reviewable staking actions. Every on-chain action must be confirmed in your wallet."
assert.equal(sanitizeAgentContent("I'll submit the transaction for you."), safeLlmFallback)
assert.equal(sanitizeAgentContent("call data"), safeLlmFallback)
assert.equal(sanitizeAgentContent("transaction data"), safeLlmFallback)
assert.equal(sanitizeAgentContent("transaction data: 0xabcdefabcdefabcdefabcdefabcdefabcdef"), safeLlmFallback)
assert.equal(sanitizeAgentContent("我可以替你提交交易。"), safeLlmFallback)
assert.equal(sanitizeAgentContent("请帮我代提交交易。"), safeLlmFallback)
assert.equal(
  sanitizeAgentContent("You can review the staking action before signing."),
  "You can review the staking action before signing.",
)

assert.equal(DEFAULT_RPC_URLS[0], "https://ethereum-rpc.publicnode.com")
assert.equal(createSafenetPublicClient({ authToken: "test-token" }).transport.type, "http")
assert.equal(createSafenetPublicClient({ authToken: "test-token" }).transport.url, "/api/rpc/ethereum")
assert.equal(
  createSafenetPublicClient({ apiBaseUrl: "https://safecafe.baserun.link", authToken: "test-token" }).transport.url,
  "https://safecafe.baserun.link/api/rpc/ethereum",
)
assert.equal(createSafenetPublicClient().transport.type, "fallback")
assert.equal(createSafenetPublicClient({ rpcUrl: "/api/rpc/ethereum" }).transport.type, "http")
globalThis.location = { hostname: "safe-staking.eth.limo" }
assert.equal(apiUrl("/api/health"), "https://safecafe.baserun.link/api/health")
globalThis.location = { hostname: "bafybeicuiscughm4nzr7fln377jv243mi23yzbzk2eklvvteqmckjxs7fy.ipfs.dweb.link" }
assert.equal(apiUrl("/api/health"), "https://safecafe.baserun.link/api/health")
globalThis.location = { hostname: "ipfs.filebase.io" }
assert.equal(apiUrl("/api/health"), "https://safecafe.baserun.link/api/health")
globalThis.location = {
  hostname: "bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq.ipfs.inbrowser.link",
}
assert.equal(apiUrl("/api/health"), "https://safecafe.baserun.link/api/health")
assert.equal(isSafecafeStaticFrontendHost("example.com"), false)
delete globalThis.location
assert.equal(isDefaultApiCorsOrigin("https://safe-staking.eth.limo"), true)
assert.equal(
  isDefaultApiCorsOrigin("https://bafybeicuiscughm4nzr7fln377jv243mi23yzbzk2eklvvteqmckjxs7fy.ipfs.dweb.link"),
  true,
)
assert.equal(
  isDefaultApiCorsOrigin("https://bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq.ipfs.inbrowser.link"),
  true,
)
assert.equal(isDefaultApiCorsOrigin("https://evil.eth.limo"), false)
assert.equal(isDefaultApiCorsOrigin("https://ipfs.filebase.io"), false)
assert.equal(resolveEnsTrustStatus(null, "bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq"), "resolved")
assert.equal(
  resolveEnsTrustStatus(
    "bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq",
    "bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq",
  ),
  "matched",
)

assert.deepEqual(resolveUserSafeApiSave("  user-safe-key  ", ""), {
  key: "user-safe-key",
  status: "configured",
})
assert.deepEqual(resolveUserSafeApiSave("", "stored-safe-key"), {
  key: "stored-safe-key",
  status: "configured",
})
assert.equal(resolveUserSafeApiSave("", ""), null)
assert.equal(isUserSafeApiKeyRejected({ code: "safe_api_key_invalid" }), true)
assert.equal(isUserSafeApiKeyRejected({ code: "safe_tx_service_rate_limited" }), false)
assert.equal(isUserSafeApiKeyRejected(new Error("network failed")), false)
assert.equal(
  defaultSafeSubjectInput(
    "self",
    null,
    mockValidators.map((validator) => validator.address),
    "",
  ),
  mockValidators[0].address,
)
assert.equal(defaultSafeSubjectInput("safe", mockValidators[0].address, [], ""), mockValidators[0].address)

const actionStatusMessages = {
  preparingAction: "Preparing...",
  simulationStatus: "Pre-flight check",
  walletConfirmation: "Wallet confirmation",
  safeExecDirect: "Safe execution",
  confirmingTx: "Confirming transaction",
}
assert.equal(chainActionBusyLabel(actionStatusMessages, ""), "Preparing...")
assert.equal(chainActionBusyLabel(actionStatusMessages, "Pre-flight check: Approve SAFE"), "Pre-flight check")
assert.equal(chainActionBusyLabel(actionStatusMessages, "Wallet confirmation: Stake SAFE"), "Wallet confirmation")
assert.equal(chainActionBusyLabel(actionStatusMessages, "Safe execution: Stake SAFE"), "Wallet confirmation")
assert.equal(chainActionBusyLabel(actionStatusMessages, "Confirming transaction: Stake SAFE"), "Confirming transaction")
assert.deepEqual(
  chainTxStepStatuses(
    ["Claim Merkle rewards", "Approve SAFE for staking contract", "Stake SAFE to validator"],
    "Wallet confirmation: Approve SAFE for staking contract",
    true,
  ),
  ["done", "current", "pending"],
)
assert.deepEqual(chainTxStepStatuses(["Claim Merkle rewards", "Stake SAFE to validator"], "", false), [
  "pending",
  "pending",
])
assert.deepEqual(chainTxStepStatuses(["Claim Merkle rewards", "Stake SAFE to validator"], "Preparing...", true), [
  "current",
  "pending",
])

const appSource = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8")
const viewsSource = readFileSync(new URL("../src/app/views.tsx", import.meta.url), "utf8")
const uiSource = readFileSync(new URL("../src/app/ui.tsx", import.meta.url), "utf8")
const rpcAuthSource = readFileSync(new URL("../src/app/rpcAuth.ts", import.meta.url), "utf8")
const zhMessages = JSON.parse(readFileSync(new URL("../src/app/locales/zh.json", import.meta.url), "utf8"))
const releaseTrustSource = readFileSync(new URL("../src/app/releaseTrust.ts", import.meta.url), "utf8")
const publishIpfsSource = readFileSync(new URL("../scripts/publish-ipfs.mjs", import.meta.url), "utf8")
const publicReleaseRecord = readFileSync(new URL("../public/release-record.json", import.meta.url), "utf8")
const sourceReleaseRecord = readFileSync(new URL("../releases/ipfs/latest.json", import.meta.url), "utf8")
assert.equal(publicReleaseRecord, sourceReleaseRecord, "Static release record should match the source IPFS record.")
assert.match(rpcAuthSource, /export class RpcAuthError extends Error/)
assert.match(rpcAuthSource, /resetAt\?: string/)
assert.match(
  appSource,
  /readableRpcAuthError\(error, t\.agentAuthFailed, t, locale\)/,
  "RPC sign-in rate limits should use the shared localized UI copy.",
)
assert.match(
  appSource,
  /message: readableRpcAuthError\(error, t\.agentAuthFailed, t, locale\)/,
  "RPC auth failures during simulation should preserve localized retry guidance.",
)
assert.match(
  appSource,
  /error\.status === 404 \|\| error\.status === 405 \|\| error\.status >= 500/,
  "Hosted account API server errors should fall back to direct public RPC reads.",
)
assert.match(
  appSource,
  /error instanceof ApiResponseError && error\.code === "ip_rate_limited"[\s\S]*formatRateLimitMessage/,
  "Account API rate limits should preserve explicit localized retry guidance.",
)
assert.equal(zhMessages.agentIpRateLimitExceeded, "当前网络的 Staking Agent 请求过于频繁，请在 {resetAt} 后再试。")
assert.equal(zhMessages.requestRateLimited, "请求过于频繁，请稍后再试。")
assert.equal(zhMessages.requestRateLimitedWithReset, "请求过于频繁，请在 {resetAt} 后再试。")
assert.equal(
  readableRpcAuthError(
    new RpcAuthError(429, "RPC authentication failed: 429", {
      code: "ip_rate_limited",
      resetAt: "2026-07-13T08:00:00.000Z",
    }),
    "认证失败。",
    zhMessages,
    "zh-CN",
  ),
  zhMessages.requestRateLimitedWithReset.replace(
    "{resetAt}",
    new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date("2026-07-13T08:00:00.000Z"),
    ),
  ),
)
assert.equal(
  readableSimulationError(
    {
      shortMessage: "HTTP request failed.",
      details: JSON.stringify({ error: { data: { reason: "ip_rate_limited" } } }),
    },
    "交易失败。",
    "请求过于频繁，请稍后再试。",
  ),
  "请求过于频繁，请稍后再试。",
)
assert.match(
  releaseTrustSource,
  /shouldPreferBundledReleaseManifest\(\)/,
  "Release Trust should avoid external release-record lookups on ENS/IPFS gateways.",
)
assert.match(
  releaseTrustSource,
  /readReleaseJson\("\/release-record\.json", "\/latest\.json"\)/,
  "Release Trust should still read the stable public record and keep the legacy static latest.json fallback on hosted mirrors.",
)
assert.match(
  publishIpfsSource,
  /writeFileSync\(publicReleaseRecordPath, content\)/,
  "IPFS publish sync should keep public/release-record.json available for regular Pages builds.",
)
const executeActionSource = appSource.match(
  /async function executeAction[\s\S]*?async function executeClaimRewardsAndStake/,
)?.[0]
assert.ok(executeActionSource, "executeAction source should be locatable")
assert.match(
  executeActionSource,
  /requireAuth:\s*true/,
  "Manual dashboard actions must require protected RPC auth before simulation and submission.",
)
assert.match(
  executeActionSource,
  /nextAction === "claim-rewards" && !refreshed/,
  "Claim rewards must stop if the forced live refresh fails.",
)
assert.match(
  executeActionSource,
  /skipRewardCheck: nextAction === "claim-rewards"/,
  "Manual actions must run local validation before entering loading state.",
)
assert.doesNotMatch(
  executeActionSource,
  /setTxProgress\(t\.preparingAction\)/,
  "Local validation failures must not flash the chain progress panel.",
)
const executeClaimRewardsAndStakeSource = appSource.match(
  /async function executeClaimRewardsAndStake[\s\S]*?async function simulateTxPlan/,
)?.[0]
assert.ok(executeClaimRewardsAndStakeSource, "executeClaimRewardsAndStake source should be locatable")
assert.match(
  executeClaimRewardsAndStakeSource,
  /if \(!refreshed\) throw new Error\(t\.liveDataFailed\)/,
  "Claim and restake must stop if the forced live refresh fails.",
)
assert.doesNotMatch(
  executeClaimRewardsAndStakeSource,
  /setTxProgress\(t\.preparingAction\)/,
  "Claim-and-restake local validation failures must not flash the chain progress panel.",
)
assert.match(appSource, /transactionReceiptPollingIntervalMs = 3_000/)
assert.equal(
  [...appSource.matchAll(/waitForTransactionReceipt\(\{[^}]*pollingInterval: transactionReceiptPollingIntervalMs/g)]
    .length,
  2,
)
const validateActionSource = appSource.match(/function validateAction[\s\S]*?function selectAction/)?.[0]
assert.ok(validateActionSource, "validateAction source should be locatable")
assert.match(validateActionSource, /targetAction === "stake" && targetValidator\.status !== "active"/)
assert.match(validateActionSource, /skipChainCheck/)
assert.match(validateActionSource, /skipRewardCheck/)
assert.doesNotMatch(
  validateActionSource,
  /if \(selectedValidator\.status !== "active"\) return t\.inactiveValidator/,
  "Inactive validators must remain unstakeable when the user has stake.",
)
const dashboardViewSource = viewsSource.match(/export function DashboardView[\s\S]*?function DecisionMetricsStrip/)?.[0]
assert.ok(dashboardViewSource, "DashboardView source should be locatable")
assert.match(
  dashboardViewSource,
  /const formControlsDisabled = props\.isSubmitting/,
  "Dashboard transaction state should be scoped to the active form controls.",
)
assert.match(
  dashboardViewSource,
  /disabled=\{!props\.accountReady \|\| formControlsDisabled\}/,
  "Dashboard MAX should stay locked while a transaction is submitting.",
)
assert.match(
  dashboardViewSource,
  /disabled=\{!hasValidators \|\| formControlsDisabled\}/,
  "Dashboard validator selectors should stay locked while a transaction is submitting.",
)
assert.match(
  dashboardViewSource,
  /placeholder="0\.00"\s+disabled=\{formControlsDisabled\}/,
  "Dashboard amount input should stay locked while a transaction is submitting.",
)
assert.match(
  dashboardViewSource,
  /<ButtonBusyLabel>\{busyActionLabel\}<\/ButtonBusyLabel>/,
  "Dashboard transaction buttons should show an inline loading indicator while submitting.",
)
assert.match(
  dashboardViewSource,
  /<ChainProgressPanel/,
  "Dashboard transaction progress should use the visual chain progress panel.",
)
const rewardsViewSource = viewsSource.match(/export function RewardsView[\s\S]*?export function DocsView/)?.[0]
assert.ok(rewardsViewSource, "RewardsView source should be locatable")
assert.doesNotMatch(
  rewardsViewSource,
  /props\.selectAction/,
  "Rewards buttons must not mutate the selected dashboard action before validation succeeds.",
)
assert.match(
  rewardsViewSource,
  /showClaimRewardsProgress = isClaimingRewards && Boolean\(props\.txProgress\)/,
  "Rewards claim card should only become visually active after a real transaction progress phase starts.",
)
assert.match(
  rewardsViewSource,
  /showClaimAndRestakeProgress = isClaimingAndRestaking && Boolean\(props\.txProgress\)/,
  "Rewards restake card should only become visually active after a real transaction progress phase starts.",
)
assert.match(
  rewardsViewSource,
  /void props\.executeAction\("claim-rewards", \{ validator: props\.selectedValidator\.address \}\)/,
  "Claim rewards should execute directly from the rewards page button.",
)
assert.match(
  rewardsViewSource,
  /void props\.executeClaimRewardsAndStake\(props\.selectedValidator\.address\)/,
  "Claim-and-restake should execute directly from the rewards page button.",
)
const withdrawalsViewSource = viewsSource.match(
  /export function WithdrawalsView[\s\S]*?export function RewardsView/,
)?.[0]
assert.ok(withdrawalsViewSource, "WithdrawalsView source should be locatable")
assert.doesNotMatch(
  withdrawalsViewSource,
  /props\.selectAction/,
  "Claim withdrawals must not mutate the selected dashboard action before validation succeeds.",
)
assert.match(
  withdrawalsViewSource,
  /void props\.executeAction\("claim-withdrawal"\)/,
  "Claim withdrawals should execute directly from the withdrawals page button.",
)
assert.match(
  viewsSource,
  /function ChainProgressPanel/,
  "Views should expose a shared visual chain transaction progress panel.",
)
assert.match(
  appSource,
  /<DashboardView[\s\S]*txPlan=\{txPlan\}/,
  "Dashboard should receive the active tx plan for visual progress steps.",
)
assert.match(
  appSource,
  /<RewardsView[\s\S]*txPlan=\{txPlan\}/,
  "Rewards should receive the active tx plan for visual progress steps.",
)
assert.match(
  appSource,
  /<WithdrawalsView[\s\S]*txPlan=\{txPlan\}/,
  "Withdrawals should receive the active tx plan for visual progress steps.",
)
assert.match(
  appSource,
  /function openValidatorDashboardAction\(nextValidator: Address, nextAction: Extract<Action, "stake" \| "unstake">\)/,
  "Validator row actions should use a dedicated dashboard handoff.",
)
assert.match(
  appSource,
  /setDashboardActionFocusRequest\(\(current\) => current \+ 1\)/,
  "Validator row actions should request focus on the dashboard action form after navigation.",
)
assert.doesNotMatch(
  appSource,
  /validatorActionPrepared/,
  "Validator row actions should rely on navigation and focused form state instead of a duplicate handoff toast.",
)
assert.match(
  appSource,
  /function isAllowedUserLlmApiBase\(url: URL\)[\s\S]*url\.protocol === "https:"[\s\S]*isLoopbackHostname\(url\.hostname\)/,
  "Custom LLM API Base should require https except loopback development hosts.",
)
assert.match(
  appSource,
  /onStake=\{\(nextValidator\) => \{\s*openValidatorDashboardAction\(nextValidator, "stake"\)\s*\}\}/,
  "Validator Stake buttons should hand off to the focused dashboard action form.",
)
assert.match(
  appSource,
  /onUnstake=\{\(nextValidator\) => \{\s*openValidatorDashboardAction\(nextValidator, "unstake"\)\s*\}\}/,
  "Validator Unstake buttons should hand off to the focused dashboard action form.",
)
assert.match(
  uiSource,
  /if \(props\.disabled && open\) setOpen\(false\)/,
  "Custom selects should close if they become disabled while open.",
)
assert.match(uiSource, /function ButtonBusyLabel/, "Shared UI should expose a reusable busy button label.")
assert.match(
  viewsSource,
  /\{t\.prepareStakeAction\}[\s\S]*\{t\.prepareUnstakeAction\}/,
  "Validator row action buttons should describe preparation, not immediate wallet execution.",
)
assert.match(
  viewsSource,
  /\{t\.userLlmSecurityNote\}/,
  "Custom LLM settings should clearly explain local key storage and provider data sharing.",
)

const agentDialogSource = readFileSync(new URL("../src/app/AgentChatDialog.tsx", import.meta.url), "utf8")
assert.match(
  agentDialogSource,
  /error\.code === "ip_rate_limited"[\s\S]*agentIpRateLimitExceeded/,
  "Agent IP rate limits should use localized retry guidance.",
)
const agentComposerSource = agentDialogSource.match(
  /<div className="agent-dialog-footer"[\s\S]*?\n {6}\{isStopConfirmOpen &&/,
)?.[0]
assert.ok(agentComposerSource, "Agent composer source should be locatable")
assert.doesNotMatch(
  agentComposerSource,
  /props\.isSubmitting/,
  "Page transaction loading must not disable Agent chat input, prompts, or send button.",
)
const agentPlanCardSource = agentDialogSource.match(/function AgentPlanCard[\s\S]*?function translateRiskSeverity/)?.[0]
assert.ok(agentPlanCardSource, "Agent plan card source should be locatable")
assert.match(
  agentPlanCardSource,
  /disabled=\{!props\.canUsePlan \|\| props\.isSubmitting\}/,
  "Agent wallet-confirmation action must stay disabled while another transaction is submitting.",
)
assert.match(
  agentPlanCardSource,
  /chainActionBusyLabel\(props\.t, props\.txProgress\)/,
  "Agent wallet-confirmation action should show the current transaction phase while submitting.",
)
assert.match(
  agentPlanCardSource,
  /<ButtonBusyLabel>\{chainActionBusyLabel\(props\.t, props\.txProgress\)\}<\/ButtonBusyLabel>/,
  "Agent wallet-confirmation action should include an inline loading indicator while submitting.",
)
assert.match(
  agentPlanCardSource,
  /chainTxStepStatuses\(txStepLabels, props\.txProgress, props\.isSubmitting\)/,
  "Agent transaction steps should derive per-step progress from the active transaction progress.",
)
assert.match(
  agentPlanCardSource,
  /<AgentTxStep/,
  "Agent transaction steps should render with per-step progress indicators.",
)
assert.match(
  agentDialogSource,
  /props\.t\.agentTransactionInProgress/,
  "Agent confirmation text should explain why an action cannot open while another wallet transaction is active.",
)
assert.match(agentDialogSource, /ConfirmDialog/, "Agent stop should use the shared confirmation dialog.")
assert.match(
  agentDialogSource,
  /canStopAgentRun \? setIsStopConfirmOpen\(true\) : void send\(\)/,
  "Agent stop button should ask for confirmation before interrupting an active run.",
)
const agentDialogEscapeHandlerSource = agentDialogSource.match(
  /if \(event\.key === "Escape"\) \{[\s\S]*?return\s+\}/,
)?.[0]
assert.ok(agentDialogEscapeHandlerSource, "Agent Escape handler should be locatable")
assert.doesNotMatch(
  agentDialogEscapeHandlerSource,
  /props\.onClose\(\)/,
  "Escape must not close the Agent dialog; users should close it with the explicit close button.",
)

assert.doesNotThrow(() => assertSuccessfulReceipt("Stake SAFE", { blockNumber: 1n, status: "success" }))
assert.throws(
  () => assertSuccessfulReceipt("Stake SAFE", { blockNumber: 1n, status: "reverted" }),
  /Transaction failed: Stake SAFE/,
)

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
assert.equal(lockedAgentResponse.status, 401)
assert.equal((await lockedAgentResponse.json()).code, "agent_auth_required")

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
let reasoningStream = false
let reasoningJson = false
let useToolCallJson = false
let usePrepareToolCallJson = false
let useRefreshToolCallJson = false
let useFeedbackToolCallJson = false
let useToolCallStream = false
let lastAgentMessages = []
let lastAgentTools = []
let lastAgentBodies = []
let rpcGatewayCalls = 0
let rpcErrorCalls = 0
let rpcForbiddenCalls = 0
let rpcInternalErrorCalls = 0
let transactionByHashNullRetryCalls = 0
let transactionReceiptNullRetryCalls = 0
let chainListCalls = 0
let rewardProofCalls = 0
let validatorMetadataCalls = 0
const safeOwnerCallSelector = "0x2f54bf6e"
const mockFetch = async (url, init) => {
  if (String(url).includes("validator-info.json")) {
    validatorMetadataCalls += 1
    return new Response(
      JSON.stringify([
        {
          address: mockValidators[0].address,
          label: mockValidators[0].label,
          is_active: true,
          commission: 0.05,
          participation_rate_14d: 0.987,
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (String(url).includes("/proofs/")) {
    rewardProofCalls += 1
    return new Response(
      JSON.stringify({
        cumulativeAmount: (mockSummary.cumulativeClaimed ?? mockSummary.claimableRewards).toString(),
        merkleRoot: `0x${"11".repeat(32)}`,
        proof: [`0x${"22".repeat(32)}`],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (String(url).includes("chainid.network")) {
    chainListCalls += 1
    return new Response(
      JSON.stringify([
        {
          chainId: 1,
          rpc: [
            "http://cleartext.example",
            "wss://ws.example",
            "https://chain-rpc.example",
            "https://chain-rpc-two.example",
            "https://chain-rpc.example",
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const body = JSON.parse(String(init?.body ?? "{}"))
  if (body.id === 9 && body.method === "eth_getBalance") {
    return new Response("bad gateway", { status: 502 })
  }
  if (body.id === 15 && body.method === "eth_getBalance") {
    rpcForbiddenCalls += 1
    return new Response("forbidden", { status: 403 })
  }
  if (body.id === 17 && body.method === "eth_getTransactionByHash") {
    transactionByHashNullRetryCalls += 1
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          transactionByHashNullRetryCalls === 1
            ? null
            : { blockNumber: "0x7b", hash: body.params[0], transactionIndex: "0x0" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (body.id === 18 && body.method === "eth_getTransactionReceipt") {
    transactionReceiptNullRetryCalls += 1
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          transactionReceiptNullRetryCalls === 1
            ? null
            : { blockNumber: "0x7b", status: "0x1", transactionHash: body.params[0], transactionIndex: "0x0" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
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
  if (body.method === "eth_getTransactionByHash") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (body.method === "eth_getTransactionReceipt") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), {
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
    if (body.params?.[0]?.data === "0xfeedface") {
      rpcInternalErrorCalls += 1
      if (rpcInternalErrorCalls === 1) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Internal error" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
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
  lastAgentBodies.push(body)
  lastAgentMessages = body.messages ?? []
  lastAgentTools = body.tools ?? []
  if (body.stream) {
    if (usePrepareToolCallJson) {
      if (!body.messages?.some((message) => message.role === "tool")) {
        const argumentsJson = JSON.stringify({
          kind: "stake",
          amount: { type: "safe", value: "100" },
          validator: { type: "label", value: "Core Contributors" },
        })
        const firstArgumentsChunk = argumentsJson.slice(0, Math.ceil(argumentsJson.length / 2))
        const secondArgumentsChunk = argumentsJson.slice(firstArgumentsChunk.length)
        return new Response(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_prepare_stake",
                      type: "function",
                      function: { name: "prepare_staking_action", arguments: firstArgumentsChunk },
                    },
                  ],
                },
              },
            ],
          })}\n\n` +
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: secondArgumentsChunk },
                      },
                    ],
                  },
                },
              ],
            })}\n\n` +
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
            "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"I prepared "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"a stake action."}}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }
    if (useToolCallStream) {
      if (!body.messages?.some((message) => message.role === "tool")) {
        return new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream_context","type":"function","function":{"name":"get_staking_context","arguments":"{"}}]}}]}\n\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
            "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"Tool-backed "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"answer."}}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }
    if (reasoningStream) {
      return new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"Model considered the staking context."}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Review "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"before signing."}}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }
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
  if (reasoningJson) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "Review this action before signing.",
              reasoning_content: "Model considered the wallet-safe staking context.",
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const shouldPrepareStakingAction =
    usePrepareToolCallJson ||
    body.messages?.some((message) => message.role === "user" && message.content === "Stake 100 SAFE")
  if (shouldPrepareStakingAction && !body.messages?.some((message) => message.role === "tool")) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_prepare_stake",
                  type: "function",
                  function: {
                    name: "prepare_staking_action",
                    arguments: JSON.stringify({
                      kind: "stake",
                      amount: { type: "safe", value: "100" },
                      validator: { type: "label", value: "Core Contributors" },
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (shouldPrepareStakingAction) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "I prepared a stake action for wallet review." } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (useRefreshToolCallJson && !body.messages?.some((message) => message.role === "tool")) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_refresh_context",
                  type: "function",
                  function: {
                    name: "refresh_live_staking_context",
                    arguments: JSON.stringify({ reason: "User asked for latest staking data." }),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (useRefreshToolCallJson) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "The app is refreshing live staking data now." } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (useFeedbackToolCallJson && !body.messages?.some((message) => message.role === "tool")) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_collect_feedback",
                  type: "function",
                  function: {
                    name: "collect_user_feedback",
                    arguments: JSON.stringify({
                      area: "agent",
                      category: "ux",
                      originalText: "这个 Agent 交互太绕了，希望简化",
                      severity: "medium",
                      summary: "Agent interaction feels too complicated.",
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (useFeedbackToolCallJson) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "我已记录这条反馈，会继续帮你处理 staking 问题。" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (useToolCallJson && !body.messages?.some((message) => message.role === "tool")) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_staking_context",
                  type: "function",
                  function: { name: "get_staking_context", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (useToolCallJson) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "You have 1250 SAFE available and 8400 SAFE staked." } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "Review this action before signing." } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}
globalThis.fetch = mockFetch
try {
  const originalWindow = globalThis.window
  const storage = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => {
        storage.delete(key)
      },
      setItem: (key, value) => {
        storage.set(key, String(value))
      },
    },
  }
  const signerA = mockAccount
  const signerB = `0x${"12".repeat(20)}`
  const subjectA = `0x${"34".repeat(20)}`
  writeStoredWalletSubject(signerA, subjectA)
  writeStoredWalletSubject(signerB, signerB)
  writeStorageJson(appStorageKeys.walletSubjects, {
    ...JSON.parse(storage.get(appStorageKeys.walletSubjects)),
    "not-address": subjectA,
    [signerA.toLowerCase()]: "not-address",
  })
  assert.equal(readStoredWalletSubject(signerA), null)
  assert.equal(readStoredWalletSubject(signerB), signerB)
  writeStoredWalletSubject(signerA, subjectA)
  assert.equal(readStoredWalletSubject(signerA), subjectA)
  writeStorageFlag(appStorageKeys.walletDisconnected, true)
  assert.equal(readStorageFlag(appStorageKeys.walletDisconnected), true)
  writeStorageFlag(appStorageKeys.walletDisconnected, false)
  assert.equal(readStorageFlag(appStorageKeys.walletDisconnected), false)
  writeStorageText(appStorageKeys.dashboardAction, "claim-rewards")
  assert.equal(
    readStorageEnum(appStorageKeys.dashboardAction, ["stake", "unstake", "claim-rewards"], "stake"),
    "claim-rewards",
  )
  writeStorageText(appStorageKeys.dashboardAction, "invalid-action")
  assert.equal(readStorageEnum(appStorageKeys.dashboardAction, ["stake", "unstake", "claim-rewards"], "stake"), "stake")
  writeStorageAddress(appStorageKeys.selectedValidator, subjectA)
  assert.equal(readStorageAddress(appStorageKeys.selectedValidator), subjectA)
  writeStorageAddress(appStorageKeys.selectedValidator, null)
  assert.equal(readStorageAddress(appStorageKeys.selectedValidator), null)
  const liveCacheData = {
    health: {
      blockNumber: 123n,
      merkleRoot: `0x${"11".repeat(32)}`,
      withdrawDelay: mockSummary.withdrawDelay,
    },
    rewardProof: agentContext.rewardProof,
    rewardProofStatus: "available",
    rewards: mockSummary.claimableRewards,
    snapshot: agentContext.liveSnapshot,
    validatorsWithPositions: mockValidators,
  }
  const liveCacheFetchedAt = 2_000
  writeCachedLiveData(subjectA, liveCacheData, liveCacheFetchedAt)
  const liveCacheRaw = JSON.parse(storage.get(appStorageKeys.accountLiveCache))
  assert.equal(typeof liveCacheRaw[subjectA.toLowerCase()].payload.health.blockNumber, "string")
  const restoredLiveCache = readCachedLiveData(subjectA, liveCacheFetchedAt + 1_000)
  assert.equal(restoredLiveCache?.fetchedAt, liveCacheFetchedAt)
  assert.equal(restoredLiveCache?.data.health.blockNumber, 123n)
  assert.equal(restoredLiveCache?.data.rewardProofStatus, "available")
  assert.equal(restoredLiveCache?.data.snapshot.safeBalance, agentContext.liveSnapshot.safeBalance)
  assert.equal(restoredLiveCache?.data.validatorsWithPositions[0].userStake, mockValidators[0].userStake)
  assert.equal(readCachedLiveData(subjectA, liveCacheFetchedAt + 16 * 60 * 1000), null)
  removeStorageValue(appStorageKeys.walletSubjects)
  globalThis.window = originalWindow

  const forgedEligibleAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "hello",
        context: agentChatContext,
      }),
    }),
    {
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const forgedEligibleAgentJson = await forgedEligibleAgentResponse.json()
  assert.equal(forgedEligibleAgentResponse.status, 401)
  assert.equal(forgedEligibleAgentJson.code, "agent_auth_required")

  const disabledAuthAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "hello",
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const disabledAuthAgentJson = await disabledAuthAgentResponse.json()
  assert.equal(disabledAuthAgentJson.source, "llm")
  assert.equal(disabledAuthAgentJson.thinking, "")
  assert.equal(
    lastAgentMessages.some((message) => message.role === "system" && message.content.includes("Mission:")),
    true,
  )
  assert.equal(
    lastAgentMessages.some(
      (message) =>
        message.role === "system" && message.content.includes("Tool capabilities available through the app:"),
    ),
    true,
  )
  assert.equal(
    lastAgentMessages.some((message) => message.role === "system" && message.content.includes("Out-of-scope topics:")),
    true,
  )
  assert.equal(
    lastAgentMessages.some((message) => message.role === "system" && message.content.includes("redacted live SAFE")),
    false,
  )
  assert.equal(
    lastAgentMessages.some((message) => message.role === "system" && message.content.includes("hidden personal data")),
    false,
  )
  assert.equal(
    lastAgentMessages.some(
      (message) =>
        message.role === "system" &&
        message.content.includes("answer current-position questions directly with the provided SAFE balance"),
    ),
    true,
  )
  assert.equal(
    lastAgentMessages.some(
      (message) => message.role === "system" && message.content.includes('"signer": "verified-signer"'),
    ),
    true,
  )
  assert.equal(
    lastAgentMessages.some((message) => message.role === "system" && message.content.includes('"safeBalance": "1250"')),
    true,
  )
  assert.equal(
    lastAgentMessages.some((message) => message.role === "system" && message.content.includes('"userStake": "2000"')),
    true,
  )
  assert.equal(
    lastAgentTools.some(
      (tool) =>
        tool.type === "function" &&
        tool.function?.name === "get_staking_context" &&
        tool.function?.parameters?.type === "object",
    ),
    true,
  )

  const longHistoryAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "summarize my current staking options",
        messages: [
          { role: "user", content: `old user detail ${"u".repeat(700)}` },
          { role: "assistant", content: `old assistant detail ${"a".repeat(700)}` },
          { role: "tool", content: `wallet simulation dump ${"x".repeat(1500)}` },
          { role: "user", content: "recent user asks about rewards" },
          { role: "assistant", content: "recent assistant mentions claim rewards" },
          { role: "user", content: "latest user asks about restaking" },
        ],
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  assert.equal((await longHistoryAgentResponse.json()).source, "llm")
  const contextSummaryMessage = lastAgentMessages.find(
    (message) => message.role === "system" && message.content.includes("Managed conversation summary"),
  )
  assert.equal(Boolean(contextSummaryMessage), true)
  assert.equal(contextSummaryMessage.content.includes("old user detail"), true)
  assert.equal(contextSummaryMessage.content.includes("wallet simulation dump"), true)
  assert.equal(contextSummaryMessage.content.includes("x".repeat(500)), false)
  assert.equal(
    lastAgentMessages.some((message) => message.role === "tool" || message.content.includes("x".repeat(500))),
    false,
  )
  assert.deepEqual(
    lastAgentMessages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => message.content),
    [
      "recent user asks about rewards",
      "recent assistant mentions claim rewards",
      "latest user asks about restaking",
      "summarize my current staking options",
    ],
  )

  useToolCallJson = true
  lastAgentBodies = []
  const toolAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "What is my current SAFE staking situation?",
        tools: [
          {
            type: "function",
            function: { name: "malicious_browser_wallet_signer", parameters: { type: "object" } },
          },
        ],
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const toolAgentJson = await toolAgentResponse.json()
  assert.equal(toolAgentJson.source, "llm")
  assert.equal(toolAgentJson.content, "You have 1250 SAFE available and 8400 SAFE staked.")
  assert.equal(toolAgentJson.tools.length, 2)
  assert.equal(toolAgentJson.tools[0].name, "get_staking_context")
  assert.equal(toolAgentJson.tools[0].status, "running")
  assert.equal(toolAgentJson.tools[1].status, "completed")
  assert.equal(lastAgentBodies.length, 2)
  assert.equal(
    lastAgentBodies[0].tools.some((tool) => tool.function?.name === "malicious_browser_wallet_signer"),
    false,
  )
  assert.equal(
    lastAgentBodies[0].tools.some((tool) => tool.function?.name === "get_staking_context"),
    true,
  )
  assert.equal(
    lastAgentBodies[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_staking_context" &&
        message.content.includes('"safeBalance":"1250"'),
    ),
    true,
  )
  useToolCallJson = false

  useRefreshToolCallJson = true
  lastAgentBodies = []
  const refreshAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "Refresh my latest staking account data",
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const refreshAgentJson = await refreshAgentResponse.json()
  assert.equal(refreshAgentJson.source, "llm")
  assert.equal(refreshAgentJson.tools.length, 2)
  assert.equal(refreshAgentJson.tools[1].name, "refresh_live_staking_context")
  assert.equal(refreshAgentJson.tools[1].status, "completed")
  assert.equal(refreshAgentJson.tools[1].data.clientAction, "refresh-live-staking-context")
  assert.equal(refreshAgentJson.tools[1].data.reason, "User asked for latest staking data.")
  assert.equal(
    lastAgentBodies[0].tools.some((tool) => tool.function?.name === "refresh_live_staking_context"),
    true,
  )
  assert.equal(
    lastAgentBodies[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_refresh_context" &&
        message.content.includes('"clientAction":"refresh-live-staking-context"'),
    ),
    true,
  )
  useRefreshToolCallJson = false

  useFeedbackToolCallJson = true
  lastAgentBodies = []
  const feedbackWrites = []
  const feedbackKv = {
    async put(key, value) {
      feedbackWrites.push({ key, value })
    },
  }
  const feedbackAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "这个 Agent 交互太绕了，希望简化",
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
      SAFECAFE_AGENT_FEEDBACK_KV: feedbackKv,
    },
  )
  const feedbackAgentJson = await feedbackAgentResponse.json()
  assert.equal(feedbackAgentJson.source, "llm")
  assert.equal(feedbackAgentJson.tools.length, 2)
  assert.equal(feedbackAgentJson.tools[1].name, "collect_user_feedback")
  assert.equal(feedbackAgentJson.tools[1].status, "completed")
  assert.equal(feedbackAgentJson.tools[1].content, "Feedback recorded.")
  assert.equal(feedbackWrites.length, 1)
  assert.equal(feedbackWrites[0].key.startsWith("feedback:raw:"), true)
  const feedbackRecord = JSON.parse(feedbackWrites[0].value)
  assert.equal(feedbackRecord.category, "ux")
  assert.equal(feedbackRecord.area, "agent")
  assert.equal(feedbackRecord.originalText, "这个 Agent 交互太绕了，希望简化")
  assert.equal(feedbackRecord.signer.toLowerCase(), mockAccount.toLowerCase())
  assert.equal(
    lastAgentBodies[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_collect_feedback" &&
        message.content.includes('"recorded":true'),
    ),
    true,
  )
  useFeedbackToolCallJson = false

  const directFeedbackWrites = []
  const directFeedbackResponse = await handleAgentFeedbackRequest(
    new Request("http://localhost/api/agent/feedback", {
      method: "POST",
      body: JSON.stringify({
        area: "wallet",
        category: "bug",
        originalText: "钱包连接提示不清楚",
        severity: "low",
        summary: "Wallet connection copy is unclear.",
      }),
    }),
    {
      SAFECAFE_AGENT_FEEDBACK_KV: {
        async put(key, value) {
          directFeedbackWrites.push({ key, value })
        },
      },
    },
  )
  const directFeedbackJson = await directFeedbackResponse.json()
  assert.equal(directFeedbackResponse.status, 200)
  assert.equal(directFeedbackJson.recorded, true)
  assert.equal(directFeedbackWrites.length, 1)
  assert.equal(directFeedbackWrites[0].key.startsWith("feedback:raw:"), true)
  assert.equal(JSON.parse(directFeedbackWrites[0].value).summary, "Wallet connection copy is unclear.")
  let globalLimitPutCalled = false
  const globalLimitResponse = await handleAgentFeedbackRequest(
    new Request("http://localhost/api/agent/feedback", {
      method: "POST",
      body: JSON.stringify({
        category: "feature_request",
        originalText: "希望记录更多反馈",
        severity: "medium",
      }),
    }),
    {
      SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT: "0",
      SAFECAFE_AGENT_FEEDBACK_GLOBAL_DAILY_LIMIT: "1",
      SAFECAFE_AGENT_FEEDBACK_KV: {
        async list() {
          return { keys: [{ name: "feedback:raw:2026-07-10:existing" }], list_complete: true }
        },
        async put() {
          globalLimitPutCalled = true
        },
      },
    },
  )
  const globalLimitJson = await globalLimitResponse.json()
  assert.equal(globalLimitResponse.status, 429)
  assert.equal(globalLimitJson.code, "agent_feedback_global_daily_limit_exceeded")
  assert.equal(globalLimitJson.limit, 1)
  assert.equal(globalLimitPutCalled, false)
  const fallbackFeedbackResponse = await handleAgentFeedbackRequest(
    new Request("http://localhost/api/agent/feedback", {
      method: "POST",
      body: JSON.stringify({
        category: "complaint",
        originalText: "反馈记录也不能影响 Agent 对话",
        severity: "medium",
        summary: "Feedback collection should not break Agent chat.",
      }),
    }),
    {
      SAFECAFE_AGENT_FEEDBACK_KV: {
        async put() {
          throw new Error("kv unavailable")
        },
      },
    },
  )
  const fallbackFeedbackJson = await fallbackFeedbackResponse.json()
  assert.equal(fallbackFeedbackResponse.status, 200)
  assert.equal(fallbackFeedbackJson.recorded, true)
  assert.equal(fallbackFeedbackJson.storage, "log")

  usePrepareToolCallJson = true
  lastAgentBodies = []
  const prepareAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "Stake 100 SAFE",
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const prepareAgentJson = await prepareAgentResponse.json()
  assert.equal(prepareAgentJson.source, "llm")
  assert.equal(prepareAgentJson.tools.length, 2)
  assert.equal(prepareAgentJson.tools[1].name, "prepare_staking_action")
  assert.equal(prepareAgentJson.tools[1].status, "completed")
  assert.equal(prepareAgentJson.tools[1].content, "Prepared staking action for wallet review.")
  assert.deepEqual(prepareAgentJson.tools[1].data.intent, {
    kind: "stake",
    amount: { type: "safe", value: "100" },
    validator: { type: "label", value: "Core Contributors" },
  })
  assert.equal(
    lastAgentBodies[0].tools.some((tool) => tool.function?.name === "prepare_staking_action"),
    true,
  )
  assert.equal(
    lastAgentBodies[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_prepare_stake" &&
        message.content.includes('"requiresWalletConfirmation":true'),
    ),
    true,
  )
  usePrepareToolCallJson = false

  usePrepareToolCallJson = true
  const prepareStreamResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({
        message: "Stake 100 SAFE",
        stream: true,
        context: agentChatContext,
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const prepareStreamText = await prepareStreamResponse.text()
  const prepareStreamEvents = parseServerSentEvents(prepareStreamText)
  assert.equal(
    prepareStreamEvents.some((event) => event.type === "tool"),
    true,
  )
  assert.equal(
    prepareStreamEvents.some((event) => event.type === "tool" && event.name === "prepare_staking_action"),
    true,
  )
  assert.equal(
    prepareStreamEvents.some((event) => event.type === "tool" && event.data?.intent?.kind === "stake"),
    true,
  )
  assert.equal(
    prepareStreamEvents.some((event) => event.type === "final"),
    true,
  )
  usePrepareToolCallJson = false

  reasoningJson = true
  const reasoningJsonAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "hello",
        context: { account: mockAccount, agentAccess: "eligible", hasLiveSnapshot: true, validatorLabels: [] },
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const reasoningJsonAgentJson = await reasoningJsonAgentResponse.json()
  assert.equal(reasoningJsonAgentJson.source, "llm")
  assert.equal(reasoningJsonAgentJson.thinking, "Model considered the wallet-safe staking context.")
  reasoningJson = false

  const viteDisabledAuthAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({
        message: "hello",
        context: { account: mockAccount, agentAccess: "eligible", hasLiveSnapshot: true, validatorLabels: [] },
      }),
    }),
    {
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const viteDisabledAuthAgentJson = await viteDisabledAuthAgentResponse.json()
  assert.equal(viteDisabledAuthAgentJson.source, "llm")
  assert.equal(viteDisabledAuthAgentJson.thinking, "")

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
  unsafeStream = false

  const parserEvents = []
  let parserController = null
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          parserController = controller
          controller.enqueue(new TextEncoder().encode('data: {"type":"thinking","content":"first thought"}\n\n'))
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
    )
  const parserPromise = requestAgentReplyStream(
    { message: "hello", messages: [], context: { validatorLabels: [] } },
    (event) => parserEvents.push(event),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(parserEvents, [{ type: "thinking", content: "first thought" }])
  parserController.enqueue(
    new TextEncoder().encode(
      'data: {"type":"tool","callId":"call_1","name":"get_staking_context","status":"completed","content":"Loaded staking context"}\n\n',
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(parserEvents.at(-1), {
    type: "tool",
    callId: "call_1",
    name: "get_staking_context",
    status: "completed",
    content: "Loaded staking context",
  })
  parserController.enqueue(new TextEncoder().encode('data: {"type":"delta","content":"first chunk "}\n\n'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(parserEvents.at(-1), { type: "delta", content: "first chunk " })
  parserController.enqueue(new TextEncoder().encode('data: {"type":"delta","content":"second chunk"}\n\n'))
  parserController.enqueue(
    new TextEncoder().encode(
      'data: {"type":"final","content":"first chunk second chunk","source":"fallback"}\n\ndata: [DONE]\n\n',
    ),
  )
  parserController.close()
  await parserPromise
  assert.deepEqual(parserEvents.at(-1), {
    type: "final",
    content: "first chunk second chunk",
    source: "fallback",
  })

  const userLlmFeedbackEvents = []
  const userLlmFeedbackBodies = []
  const userLlmFeedbackRequests = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api/agent/feedback")) {
      userLlmFeedbackRequests.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response(JSON.stringify({ recorded: true, storage: "log" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    userLlmFeedbackBodies.push(JSON.parse(String(init?.body ?? "{}")))
    if (userLlmFeedbackBodies.length === 1) {
      const argumentsJson = JSON.stringify({
        area: "agent",
        category: "complaint",
        originalText: "这个 Agent 交互太绕了",
        severity: "medium",
        summary: "Agent interaction is too complicated.",
      })
      return new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_user_llm_feedback",
                    type: "function",
                    function: { name: "collect_user_feedback", arguments: argumentsJson },
                  },
                ],
              },
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response('data: {"choices":[{"delta":{"content":"已记录反馈。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  await requestAgentReplyStream(
    {
      authToken: "session-token",
      message: "这个 Agent 交互太绕了",
      messages: [],
      context: agentChatContext,
    },
    (event) => userLlmFeedbackEvents.push(event),
    undefined,
    {
      apiBase: "https://user-llm.example/v1",
      apiKey: "user-key",
      maxTokens: 512,
      model: "user-model",
    },
  )
  assert.equal(userLlmFeedbackRequests.length, 1)
  assert.equal(userLlmFeedbackRequests[0].category, "complaint")
  assert.equal(userLlmFeedbackRequests[0].context.account, mockAccount)
  assert.equal(
    userLlmFeedbackEvents.some((event) => event.type === "tool" && event.name === "collect_user_feedback"),
    true,
  )
  assert.deepEqual(userLlmFeedbackEvents.at(-1), { type: "final", content: "已记录反馈。", source: "llm" })
  globalThis.fetch = mockFetch

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
  const tamperedMessage = `${challenge.message}\nTampered: true`
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

  const ineligibleAccount = privateKeyToAccount(`0x${"22".repeat(32)}`)
  const ineligibleChallengeResponse = await handleRpcChallengeRequest(
    new Request("http://localhost/api/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: ineligibleAccount.address, chainId: 1 }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  const ineligibleChallenge = await ineligibleChallengeResponse.json()
  const ineligibleSignature = await ineligibleAccount.signMessage({ message: ineligibleChallenge.message })
  const ineligibleVerifyResponse = await handleRpcVerifyRequest(
    new Request("http://localhost/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        address: ineligibleAccount.address,
        challenge: ineligibleChallenge.challenge,
        message: ineligibleChallenge.message,
        signature: ineligibleSignature,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal(ineligibleVerifyResponse.status, 200)
  const ineligibleSession = await ineligibleVerifyResponse.json()

  const eligibleFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("chainid.network")) return mockFetch(url, init)
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (body.method === "eth_call") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"0".repeat(64)}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return mockFetch(url, init)
  }
  const ineligibleAgentResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${ineligibleSession.token}` },
      body: JSON.stringify({
        message: "hello",
        context: {
          account: ineligibleAccount.address,
          subjectAccount: ineligibleAccount.address,
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
  assert.equal(ineligibleAgentResponse.status, 403)
  assert.equal((await ineligibleAgentResponse.json()).code, "agent_access_denied")
  globalThis.fetch = eligibleFetch

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
  assert.equal(streamText.includes('"type":"thinking"'), false)
  assert.equal(streamText.includes('"type":"final"'), true)
  assert.equal((streamText.match(/"type":"delta"/g) ?? []).length >= 2, true)
  assert.equal(upstreamCalls - streamUpstreamCallsBefore, 1)

  useToolCallStream = true
  lastAgentBodies = []
  const toolStreamCallsBefore = upstreamCalls
  const toolStreamResponse = await handleAgentApiRequest(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { accept: "text/event-stream", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        message: "show my staking context",
        stream: true,
        context: agentChatContext,
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      VITE_AGENT_AUTH: "false",
      SAFECAFE_LLM_API_BASE: "https://llm.example",
      SAFECAFE_LLM_API_MODEL: "test",
      SAFECAFE_LLM_API_KEY: "secret",
    },
  )
  const toolStreamText = await toolStreamResponse.text()
  assert.equal(toolStreamText.includes('"type":"tool"'), true)
  assert.equal(toolStreamText.includes("Loaded current SAFE staking context."), true)
  assert.equal(toolStreamText.includes("Tool-backed answer."), true)
  assert.equal(upstreamCalls - toolStreamCallsBefore, 2)
  assert.equal(lastAgentBodies.length, 2)
  assert.equal(
    lastAgentBodies[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_stream_context" &&
        message.content.includes('"safeBalance":"1250"'),
    ),
    true,
  )
  useToolCallStream = false

  reasoningStream = true
  const reasoningStreamResponse = await handleAgentApiRequest(
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
  const reasoningStreamText = await reasoningStreamResponse.text()
  assert.equal(reasoningStreamText.includes('"type":"thinking"'), true)
  assert.equal(reasoningStreamText.includes("Model considered the staking context."), true)
  assert.equal(reasoningStreamText.includes('"type":"final"'), true)
  reasoningStream = false

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

  const retriedInternalRpc = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "eth_call",
        params: [{ to: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe", data: "0xfeedface" }, "latest"],
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_RPC_URLS: "https://rpc-one.example,https://rpc-two.example",
    },
  )
  const retriedInternalRpcJson = await retriedInternalRpc.json()
  assert.equal(retriedInternalRpcJson.result, "0x")
  assert.equal(rpcInternalErrorCalls, 2)

  for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) {
    const transactionLookupRpc = await handleEthereumRpcGatewayRequest(
      new Request("http://localhost/api/rpc/ethereum", {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method,
          params: [`0x${"44".repeat(32)}`],
        }),
      }),
      { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
    )
    const transactionLookupRpcJson = await transactionLookupRpc.json()
    assert.equal(transactionLookupRpcJson.result, null, method)
  }

  const retriedTransactionByHash = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "eth_getTransactionByHash",
        params: [`0x${"64".repeat(32)}`],
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_RPC_URLS: "https://rpc-null-one.example,https://rpc-null-two.example",
    },
  )
  const retriedTransactionByHashJson = await retriedTransactionByHash.json()
  assert.equal(retriedTransactionByHashJson.result.hash, `0x${"64".repeat(32)}`)
  assert.equal(transactionByHashNullRetryCalls, 2)

  const retriedTransactionReceipt = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 18,
        method: "eth_getTransactionReceipt",
        params: [`0x${"65".repeat(32)}`],
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_RPC_URLS: "https://rpc-null-one.example,https://rpc-null-two.example",
    },
  )
  const retriedTransactionReceiptJson = await retriedTransactionReceipt.json()
  assert.equal(retriedTransactionReceiptJson.result.transactionHash, `0x${"65".repeat(32)}`)
  assert.equal(transactionReceiptNullRetryCalls, 2)

  validatorMetadataTestHooks.resetCache()
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("validator-info.json")) {
      return new Response("service unavailable", { status: 503 })
    }
    return mockFetch(url, init)
  }
  const fallbackValidatorMetadata = await readValidatorMetadata(undefined, undefined, { fallback: true })
  assert.equal(fallbackValidatorMetadata.length > 0, true)
  const strictValidatorsAfterFallback = await handleValidatorsRequest(new Request("http://localhost/api/validators"))
  assert.equal(strictValidatorsAfterFallback.status, 502)
  assert.equal(strictValidatorsAfterFallback.headers.get("x-safecafe-cache"), null)
  assert.equal((await strictValidatorsAfterFallback.json()).code, "validators_metadata_failed")
  globalThis.fetch = mockFetch
  validatorMetadataTestHooks.resetCache()

  const validatorsResponse = await handleValidatorsRequest(
    new Request("http://localhost/api/validators"),
    {},
    {
      readProtocolData: async (validators) => ({
        validators: validators.map((validator) => ({ ...validator, totalStake: 10n ** 18n })),
        withdrawDelay: mockSummary.withdrawDelay,
      }),
    },
  )
  assert.equal(validatorsResponse.status, 200)
  assert.equal(validatorsResponse.headers.get("x-safecafe-cache"), "MISS")
  const validatorsJson = await validatorsResponse.json()
  assert.equal(validatorsJson.validators.length, 1)
  assert.equal(validatorsJson.validators[0].address, mockValidators[0].address)
  assert.equal(validatorsJson.validators[0].totalStake, (10n ** 18n).toString())
  assert.equal(validatorsJson.withdrawDelay, mockSummary.withdrawDelay.toString())
  assert.equal(validatorMetadataCalls, 1)

  const cachedValidatorsResponse = await handleValidatorsRequest(new Request("http://localhost/api/validators"))
  assert.equal(cachedValidatorsResponse.status, 200)
  assert.equal(cachedValidatorsResponse.headers.get("x-safecafe-cache"), "HIT")
  assert.equal((await cachedValidatorsResponse.json()).requestId.length > 0, true)
  assert.equal(validatorMetadataCalls, 1)

  const rewardProofResponse = await handleRewardProofRequest(
    new Request(`http://localhost/api/rewards/proof?account=${testAccount.address}`),
  )
  assert.equal(rewardProofResponse.status, 200)
  const rewardProofJson = await rewardProofResponse.json()
  assert.equal(rewardProofJson.proof.cumulativeAmount, mockSummary.claimableRewards.toString())
  assert.equal(rewardProofJson.proof.proof.length, 1)
  assert.equal(rewardProofCalls, 1)

  const cachedRewardProofResponse = await handleRewardProofRequest(
    new Request(`http://localhost/api/rewards/proof?account=${testAccount.address}`),
  )
  assert.equal(cachedRewardProofResponse.status, 200)
  assert.equal((await cachedRewardProofResponse.json()).proof.cumulativeAmount, mockSummary.claimableRewards.toString())
  assert.equal(rewardProofCalls, 1)

  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/proofs/")) {
      return new Response("service unavailable", { status: 503 })
    }
    return mockFetch(url, init)
  }
  const failedRewardProofResponse = await handleRewardProofRequest(
    new Request(`http://localhost/api/rewards/proof?account=${testAccount.address}&refresh=true`),
  )
  assert.equal(failedRewardProofResponse.status, 502)
  assert.equal((await failedRewardProofResponse.json()).code, "reward_proof_failed")
  assert.equal(
    await readRewardProof(testAccount.address, undefined, undefined, {
      bypassCache: true,
      throwOnFailure: false,
    }),
    null,
  )
  globalThis.fetch = mockFetch

  const accountLiveResponse = await handleAccountLiveRequest(
    new Request(`http://localhost/api/account/live?account=${testAccount.address}&refresh=true`),
    { SAFECAFE_MOCK_ACCOUNT_LIVE: "true" },
  )
  assert.equal(accountLiveResponse.status, 200)
  assert.equal(accountLiveResponse.headers.get("cache-control"), "no-store")
  const accountLiveJson = await accountLiveResponse.json()
  assert.equal(accountLiveJson.rewardProof.cumulativeAmount, mockSummary.claimableRewards.toString())
  assert.equal(accountLiveJson.rewards, mockSummary.claimableRewards.toString())

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

  const retryableForbiddenUpstreamFailure = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "x-request-id": "test-rpc-non-retryable-failure" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 15,
        method: "eth_getBalance",
        params: [testAccount.address, "latest"],
      }),
    }),
    {
      SAFECAFE_AUTH_SECRET: "test-secret",
      SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true",
      SAFECAFE_RPC_URLS: "https://rpc-forbidden-one.example,https://rpc-forbidden-two.example",
    },
  )
  const retryableForbiddenUpstreamFailureJson = await retryableForbiddenUpstreamFailure.json()
  assert.equal(retryableForbiddenUpstreamFailureJson.error.data.reason, "upstream_unavailable")
  assert.equal(retryableForbiddenUpstreamFailureJson.error.data.retryable, true)
  assert.equal(retryableForbiddenUpstreamFailureJson.error.data.attempts >= 2, true)
  assert.equal(rpcForbiddenCalls >= 2, true)

  rpcPoolTestHooks.resetCache()
  const chainListCallsBeforePoolCheck = chainListCalls
  const chainPool = await rpcUrls({})
  assert.equal(chainPool.includes("http://cleartext.example"), false)
  assert.equal(chainPool.includes("wss://ws.example"), false)
  assert.equal(chainPool.includes("https://chain-rpc.example"), true)
  assert.equal(chainPool.includes("https://chain-rpc-two.example"), true)
  assert.equal(chainPool.filter((url) => url === "https://chain-rpc.example").length, 1)
  await rpcUrls({})
  assert.equal(chainListCalls - chainListCallsBeforePoolCheck, 1)

  rpcPoolTestHooks.resetCache()
  let failedChainListCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("chainid.network")) {
      failedChainListCalls += 1
      return new Response("service unavailable", { status: 503 })
    }
    return mockFetch(url, init)
  }
  const fallbackPool = await rpcUrls({})
  assert.equal(fallbackPool.includes(DEFAULT_RPC_URLS[0]), true)
  await rpcUrls({})
  assert.equal(failedChainListCalls, 1)
  globalThis.fetch = mockFetch

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

  const authenticatedBlockedMulticall = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "eth_call",
        params: [{ to: CONTRACTS.multicall3, data: "0xdeadbeef" }, "latest"],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_ALLOW_ALL_WALLETS: "true" },
  )
  assert.equal((await authenticatedBlockedMulticall.json()).error.data.reason, "eth_call_target_not_allowed")

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
  assert.equal(safeChallenge.message.includes(`Staking Account: ${managedSafe}`), true)
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

  const safeTxHash = `0x${"66".repeat(32)}`
  const safeTxUnauthedResponse = await handleSafeTxServiceRequest(
    new Request("http://localhost/api/safe/transaction", {
      method: "POST",
      body: JSON.stringify({
        action: "get",
        safeAddress: managedSafe,
        safeTxHash,
        senderAddress: testAccount.address,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret" },
  )
  const safeTxUnauthedJson = await safeTxUnauthedResponse.json()
  assert.equal(safeTxUnauthedResponse.status, 401)
  assert.equal(safeTxUnauthedJson.error.code, "safe_tx_auth_required")

  const safeTxMismatchResponse = await handleSafeTxServiceRequest(
    new Request("http://localhost/api/safe/transaction", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        action: "get",
        safeAddress: `0x${"55".repeat(20)}`,
        safeTxHash,
        senderAddress: testAccount.address,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret" },
  )
  const safeTxMismatchJson = await safeTxMismatchResponse.json()
  assert.equal(safeTxMismatchResponse.status, 403)
  assert.equal(safeTxMismatchJson.error.code, "safe_tx_auth_mismatch")

  const safeTxMissingKeyResponse = await handleSafeTxServiceRequest(
    new Request("http://localhost/api/safe/transaction", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        action: "get",
        safeAddress: managedSafe,
        safeTxHash,
        senderAddress: testAccount.address,
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret" },
  )
  const safeTxMissingKeyJson = await safeTxMissingKeyResponse.json()
  assert.equal(safeTxMissingKeyResponse.status, 503)
  assert.equal(safeTxMissingKeyJson.error.code, "safe_api_key_missing")

  const safeSubjectCall = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "eth_call",
        params: [{ to: managedSafe, data: "0xe75235b8" }, "latest"],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  const safeSubjectCallJson = await safeSubjectCall.json()
  assert.equal(safeSubjectCallJson.result.startsWith("0x"), true)

  const unsafeSafeSubjectCall = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "eth_call",
        params: [{ to: managedSafe, data: "0xdeadbeef" }, "latest"],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  assert.equal((await unsafeSafeSubjectCall.json()).error.data.reason, "eth_call_target_not_allowed")

  const unsafeNestedSafeExecCall = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "eth_call",
        params: [
          {
            to: managedSafe,
            data: encodeFunctionData({
              abi: safeAccountAbi,
              functionName: "execTransaction",
              args: [
                `0x${"55".repeat(20)}`,
                0n,
                "0xdeadbeef",
                0,
                0n,
                0n,
                0n,
                `0x${"00".repeat(20)}`,
                `0x${"00".repeat(20)}`,
                "0x",
              ],
            }),
          },
          "latest",
        ],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  assert.equal((await unsafeNestedSafeExecCall.json()).error.data.reason, "eth_call_target_not_allowed")

  const unsafeNestedSafeExecMulticall = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 14,
        method: "eth_call",
        params: [
          {
            to: managedSafe,
            data: encodeFunctionData({
              abi: safeAccountAbi,
              functionName: "execTransaction",
              args: [
                CONTRACTS.multicall3,
                0n,
                "0xdeadbeef",
                0,
                0n,
                0n,
                0n,
                `0x${"00".repeat(20)}`,
                `0x${"00".repeat(20)}`,
                "0x",
              ],
            }),
          },
          "latest",
        ],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  assert.equal((await unsafeNestedSafeExecMulticall.json()).error.data.reason, "eth_call_target_not_allowed")

  const unsafeNestedSafeExecSelector = await handleEthereumRpcGatewayRequest(
    new Request("http://localhost/api/rpc/ethereum", {
      method: "POST",
      headers: { authorization: `Bearer ${safeSession.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 16,
        method: "eth_call",
        params: [
          {
            to: managedSafe,
            data: encodeFunctionData({
              abi: safeAccountAbi,
              functionName: "execTransaction",
              args: [
                CONTRACTS.safeToken,
                0n,
                "0x70a08231",
                0,
                0n,
                0n,
                0n,
                `0x${"00".repeat(20)}`,
                `0x${"00".repeat(20)}`,
                "0x",
              ],
            }),
          },
          "latest",
        ],
      }),
    }),
    { SAFECAFE_AUTH_SECRET: "test-secret", SAFECAFE_RPC_URL: "https://rpc.example" },
  )
  assert.equal((await unsafeNestedSafeExecSelector.json()).error.data.reason, "eth_call_target_not_allowed")
} finally {
  globalThis.fetch = originalFetch
}

console.log("Agent core tests passed")

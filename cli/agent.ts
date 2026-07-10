import { stdin as input, stdout as outputStream } from "node:process"
import { createInterface } from "node:readline/promises"
import type { Address } from "viem"
import { type AgentPlan, compileAgentPlan, flattenCurrentExecutableTxPlan, parseAgentInstruction } from "../src/agent"
import type { AccountSummary } from "../src/app/types"
import {
  type AccountSnapshot,
  CHAIN_ID,
  fetchRewardProof,
  fetchValidators,
  formatSafe,
  mockAccount,
  mockSummary,
  mockValidators,
  type RewardProof,
  readAccountSnapshot,
  readHealth,
  readValidatorPositions,
  type TxPlan,
  type ValidatorInfo,
} from "../src/protocol"
import { reconcileTxPlanForExecution } from "../src/shared/planReconcile"
import { totalAmount } from "../src/shared/utils"
import { type AgentSessionRecord, clearAgentSession, loadAgentSession, saveAgentSession } from "./agentSession"
import { createClient, type GlobalOptions, handlePlan, resolvePlanningAccount, type WriteOptions } from "./context"

export type AgentCommandOptions = WriteOptions & {
  cancel?: boolean
  continueRun?: boolean
  prompt?: string
  refresh?: boolean
}

type AgentCliContext = {
  account: Address | null
  liveBlock: bigint | null
  liveMerkleRoot: string | null
  planAccount: Address | null
  planSubjectKind: "self" | "safe"
  rewardProof: RewardProof | null
  snapshot: AccountSnapshot
  summary: AccountSummary
  validators: ValidatorInfo[]
}

const summaryPromptPattern =
  /\b(status|summary|overview|portfolio|position|positions|balance|balances|holdings?)\b|持仓|仓位|概况|情况|余额/

export async function runAgentCommand(globals: GlobalOptions, options: AgentCommandOptions) {
  if (globals.json && !options.prompt && !options.refresh && !options.continueRun && !options.cancel) {
    throw new Error("--json requires --prompt, --refresh, --resume, or --cancel for the agent command.")
  }
  const sessionId = "default"
  if (options.cancel) {
    clearAgentSession(sessionId, process.env)
    console.log("Last Agent conversation cleared.")
    return
  }
  if (options.prompt) {
    const session = loadAgentSession(sessionId, process.env)
    await processAgentPrompt(globals, options.prompt, options, session, sessionId)
    return
  }
  if (options.refresh || options.continueRun) {
    await rerunSavedAgentInstruction(globals, options, sessionId, options.continueRun === true)
    return
  }
  await startAgentRepl(globals, options, sessionId)
}

async function startAgentRepl(globals: GlobalOptions, options: AgentCommandOptions, sessionId: string) {
  if (!input.isTTY) throw new Error("Interactive agent REPL requires a terminal. Use --prompt for one-shot mode.")
  const rl = createInterface({ input, output: outputStream })
  let session = loadAgentSession(sessionId, process.env)

  console.log("Safecafe Agent is ready.")
  console.log("Ask about SAFE staking, or use resume / refresh / cancel / exit.")

  try {
    while (true) {
      const raw = (await rl.question("agent> ")).trim()
      if (!raw) continue
      if (/^(exit|quit|\/exit|\/quit)$/i.test(raw)) break

      if (/^(cancel|clear|取消)$/i.test(raw)) {
        clearAgentSession(sessionId, process.env)
        session = loadAgentSession(sessionId, process.env)
        console.log("Last Agent conversation cleared.")
        continue
      }

      if (/^(refresh|reload|更新|刷新)$/i.test(raw)) {
        session = await rerunSavedAgentInstruction(globals, options, sessionId, false)
        continue
      }

      if (/^(resume|continue|confirm|execute|run|执行|继续|恢复)$/i.test(raw)) {
        if (!session.latestInstruction) {
          console.log("No resumable Agent action is available yet.")
          continue
        }
        const confirmed = await confirmInteractive(rl, "Resume and execute the current Agent action now? [y/N] ")
        if (!confirmed) {
          console.log("Execution canceled.")
          continue
        }
        session = await rerunSavedAgentInstruction(globals, { ...options, send: true, yes: true }, sessionId, true)
        continue
      }

      session = await processAgentPrompt(globals, raw, options, session, sessionId)
    }
  } finally {
    rl.close()
  }
}

async function processAgentPrompt(
  globals: GlobalOptions,
  rawInput: string,
  options: AgentCommandOptions,
  session: AgentSessionRecord,
  sessionId: string,
) {
  const combinedInput = session.pendingInput ? `${session.pendingInput} ${rawInput}` : rawInput
  const context = await readAgentCliContext(globals, options)

  if (summaryPromptPattern.test(combinedInput.toLowerCase())) {
    printSummary(context)
    return persistSession(
      {
        ...session,
        account: context.planAccount,
        history: appendHistory(session.history, `summary:${combinedInput}`),
        pendingInput: "",
        subjectKind: context.planSubjectKind,
      },
      sessionId,
    )
  }

  const parsed = parseAgentInstruction(combinedInput, context.validators)
  if (parsed.status === "blocked") {
    for (const risk of parsed.risks) console.log(`Blocked: ${risk.message}`)
    return persistSession(
      {
        ...session,
        account: context.planAccount,
        history: appendHistory(session.history, `blocked:${combinedInput}`),
        pendingInput: "",
        subjectKind: context.planSubjectKind,
      },
      sessionId,
    )
  }

  if (parsed.status === "needs-clarification") {
    console.log(parsed.question)
    return persistSession(
      {
        ...session,
        account: context.planAccount,
        history: appendHistory(session.history, `clarify:${combinedInput}`),
        pendingInput: combinedInput,
        subjectKind: context.planSubjectKind,
      },
      sessionId,
    )
  }

  const compiledPlan = compileAgentPlan(combinedInput, parsed.intent, toCompilerContext(context))
  const executablePlan = toExecutablePlan(compiledPlan, context.snapshot)
  printCompiledPlan(compiledPlan, executablePlan, context)

  const nextSession = persistSession(
    {
      ...session,
      account: context.planAccount,
      history: appendHistory(session.history, `prompt:${combinedInput}`),
      latestInstruction: combinedInput,
      pendingInput: "",
      subjectKind: context.planSubjectKind,
    },
    sessionId,
  )

  if (options.send && executablePlan) {
    await handlePlan(globals, executablePlan, options)
  }
  return nextSession
}

async function rerunSavedAgentInstruction(
  globals: GlobalOptions,
  options: AgentCommandOptions,
  sessionId: string,
  requestedContinue: boolean,
) {
  const session = loadAgentSession(sessionId, process.env)
  if (!session.latestInstruction) throw new Error("No saved Agent action is available to resume.")
  if (session.pendingInput) {
    console.log("This Agent conversation still needs clarification before it can resume:")
    console.log(session.pendingInput)
  }
  const context = await readAgentCliContext(globals, options)
  const parsed = parseAgentInstruction(session.latestInstruction, context.validators)
  if (parsed.status !== "ok") {
    console.log("The saved instruction can no longer be compiled into an actionable plan.")
    return persistSession(
      {
        ...session,
        account: context.planAccount,
        history: appendHistory(session.history, `refresh-blocked:${session.latestInstruction}`),
        subjectKind: context.planSubjectKind,
      },
      sessionId,
    )
  }
  const compiledPlan = compileAgentPlan(session.latestInstruction, parsed.intent, toCompilerContext(context))
  const executablePlan = toExecutablePlan(compiledPlan, context.snapshot)
  printCompiledPlan(compiledPlan, executablePlan, context)
  const nextSession = persistSession(
    {
      ...session,
      account: context.planAccount,
      history: appendHistory(
        session.history,
        `${requestedContinue ? "continue" : "refresh"}:${session.latestInstruction}`,
      ),
      pendingInput: "",
      subjectKind: context.planSubjectKind,
    },
    sessionId,
  )
  if (options.send && executablePlan) {
    await handlePlan(globals, executablePlan, options)
  }
  return nextSession
}

async function readAgentCliContext(globals: GlobalOptions, options: AgentCommandOptions): Promise<AgentCliContext> {
  const planAccount = globals.mock ? mockAccount : resolvePlanningAccount(options, globals)
  if (globals.mock) {
    const snapshot = buildMockSnapshot()
    return {
      account: mockAccount,
      liveBlock: 19234221n,
      liveMerkleRoot: `0x${"0".repeat(64)}`,
      planAccount: mockAccount,
      planSubjectKind: "self",
      rewardProof: {
        cumulativeAmount: mockSummary.claimableRewards.toString(),
        merkleRoot: `0x${"0".repeat(64)}`,
        proof: [],
      },
      snapshot,
      summary: { ...mockSummary },
      validators: mockValidators,
    }
  }

  if (!planAccount) throw new Error("--account is required for the live Agent command.")
  const client = createClient(globals)
  const [snapshot, health, validatorMetadata, rewardProof, code] = await Promise.all([
    readAccountSnapshot(client, planAccount),
    readHealth(client),
    fetchValidators(),
    fetchRewardProof(planAccount),
    client.getCode({ address: planAccount }),
  ])
  const validators = await readValidatorPositions(client, planAccount, validatorMetadata)
  const claimableRewards = calculateClaimableRewards(rewardProof, snapshot.cumulativeClaimed)

  return {
    account: planAccount,
    liveBlock: health.blockNumber,
    liveMerkleRoot: health.merkleRoot,
    planAccount,
    planSubjectKind: code && code !== "0x" ? "safe" : "self",
    rewardProof,
    snapshot,
    summary: {
      claimableRewards,
      claimableWithdrawals: totalClaimableWithdrawals(snapshot.pendingWithdrawals),
      pendingWithdrawals: totalAmount(snapshot.pendingWithdrawals),
      safeBalance: snapshot.safeBalance,
      totalStaked: snapshot.totalStaked,
      withdrawDelay: snapshot.withdrawDelay,
    },
    validators,
  }
}

function printSummary(context: AgentCliContext) {
  console.log("Live staking summary")
  console.log(`SAFE balance:          ${formatSafe(context.summary.safeBalance)} SAFE`)
  console.log(`Total staked:          ${formatSafe(context.summary.totalStaked)} SAFE`)
  console.log(`Claimable rewards:     ${formatSafe(context.summary.claimableRewards)} SAFE`)
  console.log(`Claimable withdrawals: ${formatSafe(context.summary.claimableWithdrawals)} SAFE`)
  console.log("")
  const activePositions = context.validators.filter((validator) => validator.userStake > 0n)
  if (!activePositions.length) {
    console.log("No active validator stake was found.")
    return
  }
  console.log("Validator positions")
  for (const validator of activePositions) {
    console.log(`- ${validator.label}: ${formatSafe(validator.userStake)} SAFE (${validator.status})`)
  }
}

function printCompiledPlan(compiledPlan: AgentPlan, executablePlan: TxPlan | null, context: AgentCliContext) {
  console.log(`Agent intent: ${compiledPlan.intent.kind}`)
  if (compiledPlan.risks.length) {
    console.log("Checks and risks")
    for (const risk of compiledPlan.risks) {
      console.log(`- ${risk.severity}: ${risk.message}`)
    }
  }
  if (!compiledPlan.phases.length) return
  console.log("Prepared phases")
  for (const phase of compiledPlan.phases) {
    const tag = phase.executableNow ? "now" : "later"
    console.log(`- [${tag}] ${phase.title}`)
  }
  if (!executablePlan) {
    console.log("No executable action is ready yet.")
    return
  }
  console.log("")
  console.log(`Executable now for ${context.planSubjectKind === "safe" ? "Safe" : "EOA"} account:`)
  console.log(`- ${executablePlan.title}`)
  for (const tx of executablePlan.txs) {
    console.log(`  * ${tx.label}`)
  }
  console.log("Use --resume or type 'resume' in REPL to execute this action.")
}

function buildMockSnapshot(): AccountSnapshot {
  return {
    cumulativeClaimed: 0n,
    nextClaimableWithdrawal: { amount: mockSummary.claimableWithdrawals, claimableAt: 0n },
    pendingWithdrawals: [{ amount: mockSummary.pendingWithdrawals, claimableAt: 0n }],
    safeBalance: mockSummary.safeBalance,
    stakingAllowance: 0n,
    totalStaked: mockSummary.totalStaked,
    withdrawDelay: mockSummary.withdrawDelay,
  }
}

function calculateClaimableRewards(proof: RewardProof | null, cumulativeClaimed: bigint) {
  if (!proof) return 0n
  const cumulativeAmount = BigInt(proof.cumulativeAmount)
  return cumulativeAmount > cumulativeClaimed ? cumulativeAmount - cumulativeClaimed : 0n
}

function totalClaimableWithdrawals(items: readonly { amount: bigint; claimableAt: bigint }[]) {
  const now = BigInt(Math.floor(Date.now() / 1000))
  return items.reduce((sum, item) => (item.claimableAt <= now ? sum + item.amount : sum), 0n)
}

async function confirmInteractive(rl: ReturnType<typeof createInterface>, prompt: string) {
  const answer = (await rl.question(prompt)).trim().toLowerCase()
  return answer === "y" || answer === "yes"
}

function toCompilerContext(context: AgentCliContext) {
  return {
    account: context.account,
    subjectAccount: context.planAccount,
    subjectKind: context.planSubjectKind,
    chainId: CHAIN_ID,
    liveBlock: context.liveBlock,
    liveSnapshot: context.snapshot,
    summary: context.summary,
    validators: context.validators,
    rewardProof: context.rewardProof,
    liveMerkleRoot: context.liveMerkleRoot,
  }
}

function toExecutablePlan(compiledPlan: AgentPlan, snapshot: AccountSnapshot) {
  const basePlan = flattenCurrentExecutableTxPlan(compiledPlan)
  if (!basePlan) return null
  const reconciled = reconcileTxPlanForExecution(basePlan, {
    cumulativeClaimed: snapshot.cumulativeClaimed,
    stakingAllowance: snapshot.stakingAllowance,
  })
  return reconciled.plan
}

function persistSession(
  session: Omit<AgentSessionRecord, "id" | "updatedAt"> & { id?: string; updatedAt?: string },
  sessionId: string,
) {
  const nextSession: AgentSessionRecord = {
    ...session,
    id: sessionId,
    updatedAt: new Date().toISOString(),
  }
  saveAgentSession(nextSession, process.env)
  return nextSession
}

function appendHistory(history: string[], entry: string) {
  return [...history, entry].slice(-24)
}

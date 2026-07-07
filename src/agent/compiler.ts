import { CHAIN_ID, combineTxPlans, planClaimRewards, planClaimWithdrawal, planStake, planUnstake } from "../protocol"
import { resolveAgentAmount } from "./amounts"
import type { AgentContext, AgentIntent, AgentPlan, AgentPlanPhase, AgentRisk } from "./types"
import { resolveAgentValidator } from "./validators"

export function compileAgentPlan(instruction: string, intent: AgentIntent, context: AgentContext): AgentPlan {
  const baseRisks = validateContext(context)
  const subjectAccount = stakingSubject(context)
  const plan: AgentPlan = {
    id: `agent-${Date.now().toString(36)}`,
    instruction,
    intent,
    account: subjectAccount,
    signerAccount: context.account,
    subjectKind: context.subjectKind ?? "self",
    createdAtBlock: context.liveBlock,
    phases: [],
    risks: [...baseRisks],
  }

  if (baseRisks.some((risk) => risk.severity === "blocked")) return plan
  if (!subjectAccount || !context.liveSnapshot) return plan

  try {
    if (intent.kind === "stake" || intent.kind === "compound-liquid") {
      const { validator, reason } = resolveAgentValidator(intent.validator, context.validators)
      const amount = resolveAgentAmount(intent.amount, context, validator)
      const risks = validateStake(context, validator, amount.value)
      plan.risks.push({ severity: "info", code: "validator-selection", message: reason }, ...risks)
      if (!risks.some((risk) => risk.severity === "blocked")) {
        plan.phases.push({
          id: "stake",
          title: `Stake ${amount.text} SAFE to ${validator.label}`,
          executableNow: true,
          plans: [
            planStake({
              validator: validator.address,
              amount: amount.text,
              account: subjectAccount,
              allowance: context.liveSnapshot.stakingAllowance,
            }),
          ],
          risks,
        })
      }
    }

    if (intent.kind === "unstake") {
      const { validator } = resolveAgentValidator(intent.validator, context.validators)
      const amount = resolveAgentAmount(intent.amount, context, validator)
      const risks = validateUnstake(validator.userStake, amount.value)
      plan.risks.push(...risks)
      if (!risks.some((risk) => risk.severity === "blocked")) {
        plan.phases.push({
          id: "unstake",
          title: `Unstake ${amount.text} SAFE from ${validator.label}`,
          executableNow: true,
          plans: [planUnstake({ validator: validator.address, amount: amount.text, account: subjectAccount })],
          risks,
        })
      }
    }

    if (intent.kind === "claim-withdrawal") {
      const risks =
        context.summary.claimableWithdrawals > 0n
          ? []
          : [blocked("no-claimable-withdrawal", "No withdrawal is currently claimable.")]
      plan.risks.push(...risks)
      if (!risks.length) {
        plan.phases.push({
          id: "claim-withdrawal",
          title: "Claim available withdrawal",
          executableNow: true,
          plans: [planClaimWithdrawal(subjectAccount)],
          risks,
        })
      }
    }

    if (intent.kind === "claim-rewards") {
      const rewardsPlan = buildClaimRewardsPhase(context)
      plan.risks.push(...rewardsPlan.risks)
      if (!rewardsPlan.risks.some((risk) => risk.severity === "blocked")) plan.phases.push(rewardsPlan.phase)
    }

    if (intent.kind === "restake-rewards") {
      const { validator, reason } = resolveAgentValidator(intent.validator, context.validators)
      const amount = resolveAgentAmount(intent.amount, context, validator)
      const rewardsPlan = buildClaimRewardsPhase(context)
      const stakeRisks =
        validator.status === "active" ? [] : [blocked("inactive-validator", "Cannot stake to an inactive validator.")]
      plan.risks.push(
        { severity: "info", code: "validator-selection", message: reason },
        ...rewardsPlan.risks,
        ...stakeRisks,
      )
      if (![...rewardsPlan.risks, ...stakeRisks].some((risk) => risk.severity === "blocked")) {
        plan.phases.push(rewardsPlan.phase, {
          id: "restake",
          title: `Restake ${amount.text} SAFE to ${validator.label}`,
          executableNow: true,
          plans: [
            planStake({
              validator: validator.address,
              amount: amount.text,
              account: subjectAccount,
              allowance: context.liveSnapshot.stakingAllowance,
            }),
          ],
          risks: stakeRisks,
        })
      }
    }

    if (intent.kind === "rebalance") {
      const from = resolveAgentValidator(intent.from, context.validators).validator
      const to = resolveAgentValidator(intent.to, context.validators).validator
      const amount = resolveAgentAmount(intent.amount, context, from)
      const risks = validateUnstake(from.userStake, amount.value)
      plan.risks.push(...risks)
      if (!risks.some((risk) => risk.severity === "blocked")) {
        plan.phases.push(
          {
            id: "rebalance-withdraw",
            title: `Unstake ${amount.text} SAFE from ${from.label}`,
            executableNow: true,
            plans: [planUnstake({ validator: from.address, amount: amount.text, account: subjectAccount })],
            risks,
          },
          {
            id: "rebalance-restake",
            title: `After withdrawal delay, claim and stake ${amount.text} SAFE to ${to.label}`,
            executableNow: false,
            plans: [],
            risks: [
              {
                severity: "info",
                code: "delayed-phase",
                message: "This phase can only be rebuilt after the withdrawal becomes claimable.",
              },
            ],
          },
        )
      }
    }
  } catch (error) {
    plan.risks.push(blocked("compile-failed", error instanceof Error ? error.message : "Failed to compile agent plan."))
  }

  return plan
}

export function flattenExecutableTxPlan(plan: AgentPlan) {
  if (plan.risks.some((risk) => risk.severity === "blocked")) return null
  if (!plan.phases.length || plan.phases.some((phase) => !phase.executableNow)) return null
  const plans = plan.phases.flatMap((phase) => phase.plans)
  if (!plans.length) return null
  return combineTxPlans({
    title: plan.phases.length === 1 ? plan.phases[0].title : "Agent plan",
    account: plan.account ?? undefined,
    plans,
    warnings: plan.risks.filter((risk) => risk.severity === "warning").map((risk) => risk.message),
  })
}

export function flattenCurrentExecutableTxPlan(plan: AgentPlan) {
  if (plan.risks.some((risk) => risk.severity === "blocked")) return null
  const executablePhases = []
  for (const phase of plan.phases) {
    if (!phase.executableNow) break
    executablePhases.push(phase)
  }
  const plans = executablePhases.flatMap((phase) => phase.plans)
  if (!plans.length) return null
  return combineTxPlans({
    title: executablePhases.length === 1 ? executablePhases[0].title : "Current agent phase",
    account: plan.account ?? undefined,
    plans,
    warnings: [
      ...plan.risks.filter((risk) => risk.severity === "warning").map((risk) => risk.message),
      "Only the currently executable phase is included. Rebuild the plan after live data changes.",
    ],
  })
}

function validateContext(context: AgentContext): AgentRisk[] {
  const risks: AgentRisk[] = []
  if (!context.account)
    risks.push(blocked("wallet-required", "Connect wallet before drafting an executable agent plan."))
  if (!stakingSubject(context))
    risks.push(blocked("subject-required", "Choose the wallet or Safe account whose staking position should be used."))
  if (!context.liveSnapshot)
    risks.push(blocked("live-data-required", "Load live staking data before drafting an executable agent plan."))
  if (context.chainId !== null && context.chainId !== CHAIN_ID)
    risks.push(blocked("wrong-chain", "Switch to Ethereum mainnet before execution."))
  if (!context.validators.length) risks.push(blocked("validators-required", "Validator metadata is unavailable."))
  return risks
}

function validateStake(context: AgentContext, validator: { status: string }, amount: bigint): AgentRisk[] {
  const risks: AgentRisk[] = []
  if (validator.status !== "active") risks.push(blocked("inactive-validator", "Cannot stake to an inactive validator."))
  if (context.summary.safeBalance < amount)
    risks.push(blocked("insufficient-safe-balance", "SAFE balance is insufficient."))
  return risks
}

function validateUnstake(userStake: bigint, amount: bigint): AgentRisk[] {
  return userStake < amount ? [blocked("insufficient-validator-stake", "Validator stake is insufficient.")] : []
}

function buildClaimRewardsPhase(context: AgentContext): { phase: AgentPlanPhase; risks: AgentRisk[] } {
  const risks: AgentRisk[] = []
  const subjectAccount = stakingSubject(context)
  if (!context.account) risks.push(blocked("wallet-required", "Connect wallet before claiming rewards."))
  if (!subjectAccount) risks.push(blocked("subject-required", "Choose a staking account before claiming rewards."))
  if (!Array.isArray(context.rewardProof?.proof))
    risks.push(blocked("reward-proof-required", "No claimable reward proof is available."))
  if (
    context.liveMerkleRoot &&
    context.rewardProof?.merkleRoot.toLowerCase() !== context.liveMerkleRoot.toLowerCase()
  ) {
    risks.push(blocked("merkle-root-mismatch", "Reward proof Merkle root does not match the live contract root."))
  }
  if (context.summary.claimableRewards <= 0n)
    risks.push(blocked("no-claimable-rewards", "No staking rewards are currently claimable."))

  return {
    risks,
    phase: {
      id: "claim-rewards",
      title: "Claim staking rewards",
      executableNow: true,
      plans:
        subjectAccount && context.rewardProof?.proof
          ? [
              planClaimRewards({
                account: subjectAccount,
                cumulativeAmount: BigInt(context.rewardProof.cumulativeAmount),
                merkleRoot: context.rewardProof.merkleRoot,
                proof: context.rewardProof.proof,
              }),
            ]
          : [],
      risks,
    },
  }
}

function blocked(code: string, message: string): AgentRisk {
  return { severity: "blocked", code, message }
}

function stakingSubject(context: AgentContext) {
  return context.subjectAccount ?? context.account ?? null
}

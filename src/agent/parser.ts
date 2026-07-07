import { type Address, isAddress } from "viem"
import type { ValidatorInfo } from "../protocol"
import type { AgentAmount, AgentParseResult, AgentValidatorRef } from "./types"

export function parseAgentInstruction(input: string, validators: ValidatorInfo[]): AgentParseResult {
  const original = input.trim()
  const text = original.toLowerCase().replace(/\s+/g, " ")
  if (!text) {
    return { status: "needs-clarification", question: "What staking action should the Agent draft?", risks: [] }
  }
  const unsafeExecutionRisk = parseUnsafeExecutionRisk(text)
  if (unsafeExecutionRisk) {
    return {
      status: "blocked",
      risks: [unsafeExecutionRisk],
    }
  }
  if (/claim\s+(a\s+)?withdrawal|claim\s+withdrawals|领取提款|提取提款/.test(text)) {
    return { status: "ok", intent: { kind: "claim-withdrawal" }, risks: [] }
  }
  if (/claim\s+rewards?\s+and\s+restake|\brestake\b|复投奖励|领取奖励.*复投|复投/.test(text)) {
    const validator = parseValidatorRef(text, validators, "to") ?? parseValidatorRef(text, validators, "validator")
    if (!validator) {
      return {
        status: "needs-clarification",
        question: "Which validator should receive restaked rewards?",
        risks: [],
      }
    }
    return {
      status: "ok",
      intent: {
        kind: "restake-rewards",
        amount: { type: "all-claimable-rewards" },
        validator,
      },
      risks: [],
    }
  }
  if (/claim\s+rewards?|领取奖励/.test(text)) {
    return { status: "ok", intent: { kind: "claim-rewards" }, risks: [] }
  }
  if (/\b(move|rebalance)\b|移动质押|调仓/.test(text)) {
    const amount = parseAmount(text, "validator")
    const from = parseValidatorRef(text, validators, "from")
    const to = parseValidatorRef(text, validators, "to")
    if (!amount || !from || !to) {
      return {
        status: "needs-clarification",
        question: "Which amount and validators should be used for the rebalance?",
        risks: [],
      }
    }
    return { status: "ok", intent: { kind: "rebalance", from, to, amount }, risks: [] }
  }
  if (/\bunstake\b|取消质押|解除质押/.test(text)) {
    const amount = parseAmount(text, "validator")
    const validator = parseValidatorRef(text, validators, "from") ?? parseValidatorRef(text, validators, "validator")
    if (!amount || !validator) {
      if (amount && !validator) {
        return { status: "needs-clarification", question: "Which validator should be unstaked?", risks: [] }
      }
      return {
        status: "needs-clarification",
        question: "Which amount and validator should be unstaked?",
        risks: [],
      }
    }
    return { status: "ok", intent: { kind: "unstake", amount, validator }, risks: [] }
  }
  if (/\bstake\b|质押/.test(text)) {
    const amount = parseAmount(text, "wallet")
    const validator = parseValidatorRef(text, validators, "to") ?? parseValidatorRef(text, validators, "validator")
    if (!amount || !validator) {
      if (amount && !validator) {
        return { status: "needs-clarification", question: "Which validator should receive this stake?", risks: [] }
      }
      return {
        status: "needs-clarification",
        question: "Which amount and validator should be staked?",
        risks: [],
      }
    }
    return { status: "ok", intent: { kind: "stake", amount, validator }, risks: [] }
  }
  return {
    status: "needs-clarification",
    question: "I can draft stake, unstake, claim, restake, and rebalance plans. Which one do you want?",
    risks: [],
  }
}

function parseUnsafeExecutionRisk(text: string) {
  if (
    /\b(automatically|auto|scheduled?|recurring|daily|weekly|monthly|tomorrow)\b/.test(text) ||
    /\bevery\s+(day|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text) ||
    /\bin\s+\d+\s+(minutes?|hours?|days?|weeks?|months?)\b/.test(text) ||
    /\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/.test(text) ||
    /自动|定时|周期|每天|每日|每周|每月|明天|\d+\s*分钟后|\d+\s*小时后|\d+\s*天后/.test(text)
  ) {
    return {
      severity: "blocked" as const,
      code: "scheduled-execution-not-supported",
      message: "The Agent can draft SAFE staking actions, but it cannot schedule or automatically execute them.",
    }
  }
  if (/\b(submit|sign|approve|confirm)\s+for\s+me\b|帮我(提交|签名|授权|确认)|替我(提交|签名|授权|确认)/.test(text)) {
    return {
      severity: "blocked" as const,
      code: "wallet-confirmation-required",
      message: "The Agent cannot sign, approve, confirm, or submit wallet actions for you.",
    }
  }
  return null
}

function parseAmount(text: string, percentBase: "wallet" | "validator"): AgentAmount | null {
  if (/\ball\s+(wallet\s+)?safe\b|\bmax\b/.test(text)) {
    return { type: percentBase === "wallet" ? "all-wallet" : "all-validator-stake" }
  }
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (percent) {
    return {
      type: percentBase === "wallet" ? "percent-wallet" : "percent-validator-stake",
      value: Number(percent[1]),
    }
  }
  const safe = text.match(/(\d+(?:\.\d{1,18})?)\s*safe\b/)
  if (safe) return { type: "safe", value: safe[1] }
  return null
}

function parseValidatorRef(
  text: string,
  validators: ValidatorInfo[],
  marker: "to" | "from" | "validator",
): AgentValidatorRef | null {
  if (/best\s+(active\s+)?validator|best validator/.test(text)) return { type: "best-active" }
  const address = text.match(/0x[a-f0-9]{40}/i)?.[0]
  if (address && isAddress(address)) return { type: "address", value: address as Address }
  const segment = marker === "validator" ? text : segmentAfterMarker(text, marker)
  if (!segment) return null
  const matches = validators.filter((validator) => segment.includes(validator.label.toLowerCase()))
  if (matches.length === 1) return { type: "label", value: matches[0].label }
  return null
}

function segmentAfterMarker(text: string, marker: "to" | "from"): string | null {
  const markerText = marker === "to" ? findMarker(text, [" to ", " 到 ", " 给 "]) : findMarker(text, [" from ", " 从 "])
  if (!markerText) return null
  const [, afterMarker] = text.split(markerText)
  if (!afterMarker) return null
  if (marker === "from") return afterMarker.split(/ to | 到 | 给 /)[0]
  return afterMarker.split(/ from | 从 /)[0]
}

function findMarker(text: string, markers: string[]) {
  return markers.find((marker) => text.includes(marker)) ?? null
}

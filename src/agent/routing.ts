export const generalAgentQuestion =
  "I can prepare stake, unstake, claim, restake, and rebalance actions. Which one do you want?"

export function shouldRouteClarificationToAgentReply(question: string) {
  return question === generalAgentQuestion
}

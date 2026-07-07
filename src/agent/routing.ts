const generalAgentQuestion = "I can draft stake, unstake, claim, restake, and rebalance plans. Which one do you want?"

export function shouldRouteClarificationToAgentReply(question: string) {
  return question === generalAgentQuestion
}

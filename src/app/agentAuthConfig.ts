import { isAgentAuthRequiredValue } from "../shared/agentAuth"

export function isAgentAuthRequired(value = import.meta.env.VITE_AGENT_AUTH) {
  return isAgentAuthRequiredValue(value)
}

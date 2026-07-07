export function isAgentAuthRequiredValue(value?: string) {
  return value?.trim().toLowerCase() !== "false"
}

export function resolveAgentAuthRequired(input: { safecafeAgentAuth?: string; viteAgentAuth?: string }) {
  return isAgentAuthRequiredValue(input.safecafeAgentAuth ?? input.viteAgentAuth)
}

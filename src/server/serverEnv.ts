export type AgentFeedbackKv = {
  list?(options?: { cursor?: string; limit?: number; prefix?: string }): Promise<{
    cursor?: string
    keys: Array<{ name: string }>
    list_complete?: boolean
  }>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export type RpcGatewayEnv = {
  SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_API_ALLOWED_ORIGINS?: string
  SAFECAFE_RPC_ALLOW_ALL_WALLETS?: string
  SAFECAFE_AUTH_SECRET?: string
  SAFECAFE_MOCK_ACCOUNT?: string
  SAFECAFE_MOCK_ACCOUNT_LIVE?: string
  SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_RPC_URL?: string
  SAFECAFE_RPC_URLS?: string
  SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_SAFE_API_KEYS?: string
  SAFECAFE_SAFE_TX_SERVICE_URL?: string
  SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE?: string
  SAFECAFE_TRUST_PROXY_HEADERS?: string
  SAFECAFE_LLM_API_BASE?: string
  SAFECAFE_LLM_API_MODEL?: string
  SAFECAFE_LLM_API_KEY?: string
  SAFECAFE_LLM_TIMEOUT_MS?: string
  SAFECAFE_LLM_MAX_TOKENS?: string
  SAFECAFE_LLM_HEADER?: string
  SAFECAFE_AGENT_DAILY_LIMIT?: string
  SAFECAFE_AGENT_FEEDBACK_KV?: AgentFeedbackKv
  SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT?: string
  SAFECAFE_AGENT_FEEDBACK_GLOBAL_DAILY_LIMIT?: string
  VITE_AGENT_AUTH?: string
}

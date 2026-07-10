/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOAST_DURATION_MS?: string
  readonly VITE_AGENT_LAUNCHER_DRAGGABLE?: string
  readonly VITE_AGENT_AUTH?: string
  readonly VITE_MOCK_REWARD_PROOF?: string
}

interface EthereumProvider {
  request: (args: { method: string; params?: object | readonly unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (payload: unknown) => void) => void
  removeListener?: (event: string, handler: (payload: unknown) => void) => void
}

interface Window {
  ethereum?: EthereumProvider
  __safecafeSafeMultisigTestKit?: unknown
}

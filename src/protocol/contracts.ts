import type { Address } from "viem"

export const CHAIN_ID = 1

export const CONTRACTS = {
  safeToken: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe" as Address,
  staking: "0x115E78f160e1E3eF163B05C84562Fa16fA338509" as Address,
  merkleDrop: "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
}

export const DEFAULT_RPC_URLS = ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"]

export const DEFAULT_VALIDATOR_INFO_URL =
  "https://raw.githubusercontent.com/safe-fndn/safenet-beta-data/refs/heads/main/assets/validator-info.json"

export const DEFAULT_VALIDATOR_INFO_URLS = [
  DEFAULT_VALIDATOR_INFO_URL,
  "https://cdn.jsdelivr.net/gh/safe-fndn/safenet-beta-data@main/assets/validator-info.json",
]

export const DEFAULT_REWARDS_BASE_URL =
  "https://raw.githubusercontent.com/safe-fndn/safenet-beta-data/refs/heads/main/assets/rewards"

export const DEFAULT_REWARDS_BASE_URLS = [
  DEFAULT_REWARDS_BASE_URL,
  "https://cdn.jsdelivr.net/gh/safe-fndn/safenet-beta-data@main/assets/rewards",
]

export const EXPLORER_BASE_URL = "https://etherscan.io"

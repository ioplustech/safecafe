# Safecafe Resilience Model

Safecafe targets Track A of the Safenet Beta Staking UI RFP: permissionless, non-custodial staking access with resilient operation and no single proprietary UI dependency.

The frontend is statically distributable and verifiable through IPFS/ENS. Live convenience features can use hosted Pages Functions, but users and operators can also provide their own RPC, Safe Transaction Service API, and LLM API configuration.

## Goals

- Keep staking, unstaking, withdrawal claiming, and reward claiming available even if one hosted UI is unavailable.
- Avoid custody, wrapper tokens, account abstraction relayers, or backend-controlled transaction authority.
- Make every transaction inspectable before signing.
- Let users choose their own wallet, Safe, RPC endpoint, and distribution channel.
- Publish enough release metadata for users and reviewers to verify what they are using.

## Non-Custodial Model

Safecafe never takes custody of SAFE and does not introduce an intermediary contract. The product interacts directly with the Safenet staking contracts:

- SAFE token: `0x5aFE3855358E112B5647B952709E6165e1c1eEEe`
- Staking: `0x115E78f160e1E3eF163B05C84562Fa16fA338509`
- Rewards: `0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2`

Supported signing paths:

- Browser wallet signing for normal EOA use.
- Safe account proposal, confirmation, and execution through Safe Transaction Service.
- CLI transaction preview and live execution for EOAs or Safe owner accounts.
- Optional CLI automation for trusted CI, gated by explicit `--send --yes`, signer selection, and private-key source checks.

For Safe accounts, the signing key must belong to a Safe owner. A `1/1` Safe can execute immediately after signing; an `n/m` Safe is proposed to the Safe Transaction Service, confirmed by available owners, and executed once the threshold is met.

## Distribution

The web app is a static client-side application. It should be published to multiple independent channels:

- Primary hosted build, such as Cloudflare Pages.
- Secondary hosted build, such as Vercel.
- IPFS build with a Filebase-pinned CID.
- Optional ENS contenthash pointing to the latest stable IPFS build.
- GitHub Releases with built assets and checksums.
- npm CLI package exposing the `safecafe` binary.
- Optional Bun-compiled standalone CLI binaries.

This lets users keep operating through the web app, mirrored static hosts, IPFS, Safe wallets, or the CLI.

## Data Availability

Safecafe should not depend on one metadata endpoint:

- Ethereum reads use multiple public RPC endpoints by default.
- Users can override RPC with `VITE_RPC_URL`, `SAFECAFE_RPC_URL`, or `--rpc`.
- Validator metadata is fetched from multiple public mirrors.
- Reward proofs are fetched from multiple public mirrors.
- Reward proofs are schema-validated before use.
- Reward proof Merkle roots are compared against the live rewards contract before claim planning.

The next hardening step is to add a release-time snapshot of validator metadata and reward manifest checksums so reviewers can verify mirror consistency.

## Transaction Safety

Every write path should expose the same safety contract:

- Show contract addresses and calldata before signing.
- Show approval transactions separately from staking transactions.
- Detect inactive validators and insufficient balances before planning.
- Detect unclaimable withdrawals and already-claimed rewards before planning.
- For Safe accounts, require the selected signer to be an owner before proposal or execution.
- Require `--account`, `--send`, and `--yes` before CLI live submission.
- Rebuild Agent-generated multi-step actions from fresh live chain state before execution.
- Reject private keys passed as process arguments.

Future improvements:

- Add decoded calldata tables to CLI output.
- Add simulation results where public RPC support is available.
- Add transaction hash and receipt verification instructions to each release.

## Uptime Plan

The 95% target should be met by removing single points of failure rather than relying on one server:

- Static hosting across at least two independent providers.
- IPFS/ENS distribution for fallback access.
- Static frontend access remains independently distributable; hosted APIs are convenience layers that can be replaced by user/operator configuration where supported.
- Multiple RPC fallback endpoints.
- User-configurable RPC.
- CLI and Safe wallet flows as non-web fallback paths.
- Release artifacts that can be independently mirrored.

## Release Verification

Each public release should include:

- Git commit hash.
- Build command and package manager version.
- Contract address list.
- Web deployment URLs.
- IPFS CID, if published through Filebase.
- npm package version and integrity.
- CLI binary checksums, if binaries are published.
- Manual smoke-test results for stake planning, unstake planning, withdrawal claim planning, reward proof validation, Safe multisig execution, and Staking Agent action preparation.

## Open Questions

- Whether to package Safecafe as a Safe App in addition to the standalone web app.
- Whether WalletConnect should be added as a milestone for non-injected wallet users.
- Whether validator metadata should be mirrored by Safecafe-owned infrastructure, IPFS, or both.
- Whether reward proof manifests should be signed by release keys for stronger mirror verification.

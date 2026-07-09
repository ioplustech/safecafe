# Safecafe

**Live:** [safe-staking.eth.limo](https://safe-staking.eth.limo/)

Safecafe is a standalone non-custodial interface for Safenet staking. It includes a web app, CLI, protocol reads, transaction planning, Safe Transaction Builder payload export, and shared utilities in one project.

Safecafe never takes custody of funds. Users review and sign transactions from their own wallet or Safe.

## Features

- Wallet-aware Safenet staking dashboard
- Validator discovery, filtering, and stake distribution views
- Stake, unstake, withdrawal claim, and reward claim transaction planning
- Reward proof loading and Merkle root comparison
- Safe Transaction Builder JSON export
- Scriptable CLI for protocol status, validators, staking, withdrawals, rewards, and contract addresses
- CLI transaction planning, Safe payload export, and explicit EOA hot-wallet sending
- English and Chinese UI copy
- Static frontend deployment with no proprietary backend requirement

## Structure

- `src/app`: React application surface
- `src/protocol`: contract addresses, reads, rewards, validators, formatting, and transaction plans
- `src/shared`: browser and CLI helpers shared by the app entrypoints
- `cli`: command-line entrypoint and CLI build config
- `public`: deploy-time static assets and routing files

## Development

Requirements:

- Node.js 22 or newer
- pnpm through Corepack

```bash
corepack enable
pnpm install
pnpm dev
```

Common checks:

```bash
pnpm check
pnpm build
pnpm test:integration
pnpm test:system
```

## Configuration

Copy `.env.example` to `.env` and fill in the values you need. Variables are grouped by purpose below.

### RPC Endpoints

| Variable | Description |
| --- | --- |
| `VITE_RPC_URL` | Ethereum RPC endpoint used by the **web app** (e.g. `/api/rpc/ethereum` for the built-in gateway, or an external URL). |
| `SAFECAFE_RPC_URL` | Ethereum RPC endpoint used by the **CLI** and server-side reads. |

### RPC Gateway Auth

The built-in RPC gateway (`/api/rpc/ethereum`) supports wallet-based session auth. These are required when deploying the gateway in production.

| Variable | Description |
| --- | --- |
| `SAFECAFE_AUTH_SECRET` | HMAC-SHA256 key for signing and verifying session tokens. **Required in production.** A fixed fallback is used automatically on `localhost`. |
| `SAFECAFE_RPC_ALLOW_ALL_WALLETS` | Access policy for the RPC gateway. `false` (default) = only wallets holding SAFE tokens or staking positions can connect. `true` = any wallet that signs a challenge can connect. |

### Staking Agent (LLM)

The Staking Agent (`/api/agent`) uses an OpenAI-compatible LLM upstream for AI-powered staking guidance.

| Variable | Description |
| --- | --- |
| `SAFECAFE_LLM_API_BASE` | Base URL of the upstream LLM API (OpenAI-compatible, e.g. `https://api.openai.com/v1`). |
| `SAFECAFE_LLM_API_MODEL` | Model name to use (e.g. `gpt-4o-mini`). |
| `SAFECAFE_LLM_API_KEY` | API key for the upstream LLM service. |
| `SAFECAFE_LLM_TIMEOUT_MS` | Request timeout in milliseconds. Default: `30000`. |
| `SAFECAFE_LLM_MAX_TOKENS` | Max response tokens per LLM call. Default: `512`. |
| `SAFECAFE_LLM_HEADER` | Optional identifier sent as `X-Service-Id` header to the upstream LLM for usage tracking. Leave empty to omit. |

### Filebase / IPFS

Used by the release publishing scripts to upload builds to IPFS via Filebase.

| Variable | Description |
| --- | --- |
| `FILEBASE_ACCESS_TOKEN` | Filebase API access token. |
| `FILEBASE_SECRET_KEY` | Filebase S3-compatible secret key. |
| `FILEBASE_BUCKET` | Filebase IPFS bucket name. Default: `safecafe`. |
| `FILEBASE_RELEASE_KEY_PREFIX` | Key prefix for release objects in the bucket. Default: `releases`. |
| `FILEBASE_IPFS_MAX_BYTES` | Maximum upload size in bytes for IPFS publishes. Default: `1500000`. |

### Web App UI

| Variable | Description |
| --- | --- |
| `VITE_AGENT_AUTH` | Enable wallet-based auth for the Agent UI and server-side Agent access checks. Set to `true` in production. |
| `VITE_TOAST_DURATION_MS` | Toast notification display duration in milliseconds. Default: `3600`. |
| `VITE_AGENT_LAUNCHER_DRAGGABLE` | Allow dragging the agent launcher button. Default: `false`. |

### Testing / Mock

These are for local development and integration tests only. Never enable in production.

| Variable | Description |
| --- | --- |
| `SAFECAFE_MOCK_ACCOUNT` | Mock wallet address for local testing. |
| `SAFECAFE_MOCK_ACCOUNT_LIVE` | Use a mock live account. Default: `false`. |
| `VITE_MOCK_REWARD_PROOF` | Return mock reward proof data instead of live queries. Default: `false`. |

Never commit `.env` files. `.env.example` is the only environment file intended for git.

## CLI

```bash
pnpm cli --help
pnpm cli status --mock
pnpm cli validators --mock --active
pnpm build:cli
pnpm cli:packed status --mock
```

After building, the package exposes the `safecafe` binary from `cli/dist/index.js`.

The CLI is safest as a read-only planning and Safe Transaction Builder export tool. Advanced EOA users can submit transactions with `--send --private-key-prompt --yes` or pipe a key with `--private-key-stdin`; raw private keys are never accepted as command-line arguments.

## Testing

See [TESTING.md](TESTING.md) for the integration and system smoke-test strategy.

## Deployment

Safecafe builds to a static frontend:

```bash
pnpm build:web
```

The output in `dist/` can be deployed to Cloudflare Pages, IPFS-style static hosting, or any static host that supports SPA fallback routing.

Cloudflare Pages is the recommended primary public host. Filebase/IPFS is used for immutable release snapshots, and `safe-staking.eth` is configured to resolve through `https://safe-staking.eth.limo/` after its ENS contenthash points to the current `ipfs://<CID>`. See [CLOUDFLARE.md](CLOUDFLARE.md) for the full development, Cloudflare deployment, IPFS publishing, ENS update, and verification flow.

<!-- ipfs-latest:start -->
## Latest IPFS Release

- CID: `bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq`
- ENS contenthash: `ipfs://bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq`
- Filebase: https://ipfs.filebase.io/ipfs/bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq/
- Release record: [releases/ipfs/latest.json](releases/ipfs/latest.json)

<!-- ipfs-latest:end -->

## Resilience

Safecafe is designed for Track A: permissionless, non-custodial access with no proprietary backend requirement. See [RESILIENCE.md](RESILIENCE.md) for the decentralization, uptime, signing, data-source, and release-verification model.

## Security

- Safecafe is non-custodial and prepares transactions for user review and signing.
- Keep `.env` files local. `.env.example` is the only environment file intended for git.
- Treat any exposed private key as compromised and replace it immediately.
- Prefer Safe payload export or hidden/private stdin signing over environment variables.
- Report security issues privately before opening public issues.

## License

MIT. See [LICENSE](LICENSE).

# Safecafe

**Live:** [safe-staking.eth.limo](https://safe-staking.eth.limo/)

Safecafe is a standalone non-custodial interface for Safenet staking. It includes a web app, CLI, protocol reads, transaction planning, Safe multisig execution support, and shared utilities in one project.

Safecafe never takes custody of funds. Users review and sign transactions from their own wallet or Safe.

## Features

- Wallet-aware Safenet staking dashboard
- Validator discovery, filtering, and stake distribution views
- Stake, unstake, withdrawal claim, and reward claim transaction planning
- Reward proof loading and Merkle root comparison
- Staking Agent for natural-language SAFE staking workflows
- Safe multisig proposal, confirmation, and execution support through Safe Transaction Service
- Scriptable CLI for protocol status, validators, staking, withdrawals, rewards, Agent workflows, and contract addresses
- CLI transaction preview and explicit live sending for EOAs or Safe owner accounts
- English, Chinese, German, and Korean UI copy
- Static frontend distribution with optional user-configurable RPC, Safe API, and LLM API paths

## Structure

- `src/app`: React application surface
- `src/protocol`: contract addresses, reads, rewards, validators, formatting, and transaction plans
- `src/shared`: browser and CLI helpers shared by the app entrypoints
- `cli`: command-line entrypoint and CLI build config
- `public`: deploy-time static assets and routing files

## Development

Requirements:

- Node.js 22.12 or newer
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
| `VITE_API_BASE_URL` | Optional Safecafe API origin for static/IPFS frontends. Leave empty for same-origin Pages Functions. ENS/IPFS gateway frontends fall back to `https://safecafe.baserun.link`. This is a build-time browser setting. |
| `SAFECAFE_RPC_URL` | Ethereum RPC endpoint used by the **CLI** and server-side reads. |

### RPC Gateway Auth

The built-in RPC gateway (`/api/rpc/ethereum`) supports wallet-based session auth. These are required when deploying the gateway in production.

| Variable | Description |
| --- | --- |
| `SAFECAFE_AUTH_SECRET` | HMAC-SHA256 key for signing and verifying session tokens. **Required in production.** A fixed fallback is used automatically on `localhost`. |
| `SAFECAFE_API_ALLOWED_ORIGINS` | Optional comma-separated CORS origin allowlist for `/api/*`, e.g. `https://safe-staking.eth.limo,https://safecafe.baserun.link`. Defaults include Safecafe, `safe-staking.eth.limo`, and the current release CID on dweb.link. Add shared path gateways such as `https://ipfs.filebase.io` explicitly if you want them to call the hosted API. |
| `SAFECAFE_RPC_ALLOW_ALL_WALLETS` | Access policy for the RPC gateway. `false` (default) = only wallets holding SAFE tokens or staking positions can connect. `true` = any wallet that signs a challenge can connect. |

### Server IP Rate Limits

All built-in API limits use the private `@safecafe/rate-limit` workspace package. Counters are bounded, fixed-window, in-memory values scoped to one process or Cloudflare isolate, so they may reset when an isolate restarts and are not globally strict. Each isolate retains at most 10,000 active route/client buckets. Set any limit to `0` to disable it.

| Variable | Default | Applies to |
| --- | ---: | --- |
| `SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE` | `120` | Global fallback for routes without a more specific limit. |
| `SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE` | `20` | `/api/agent` |
| `SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE` | `20` | `/api/agent/feedback` |
| `SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE` | `30` | `/api/auth/challenge`, `/api/auth/verify` |
| `SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE` | `60` | `/api/account/live`, `/api/safes`, `/api/validators`, `/api/rewards/proof`, `/api/price/safe` |
| `SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE` | `120` | `/api/rpc/ethereum` |
| `SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE` | `30` | `/api/safe/transaction` |
| `SAFECAFE_TRUST_PROXY_HEADERS` | `false` | Trust `x-forwarded-for` and `x-real-ip` when running behind a trusted non-Cloudflare proxy. |

`cf-connecting-ip` is trusted by default on Cloudflare. Forwarded proxy headers are ignored unless `SAFECAFE_TRUST_PROXY_HEADERS=true`, because clients can forge them when no trusted reverse proxy overwrites the incoming values.

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
| `SAFECAFE_AGENT_DAILY_LIMIT` | Daily `/api/agent` quota per signer wallet address, counted after wallet access is eligible. Default: `100`; set `0` to disable. |
| `SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT` | Optional daily `/api/agent/feedback` quota per signer or client IP. Default: `20`; set `0` to disable. |
| `SAFECAFE_AGENT_FEEDBACK_GLOBAL_DAILY_LIMIT` | Daily global accepted feedback cap. Default: `100`; set `0` to disable. |

The Agent quota is intentionally lightweight and in-memory. It is enough for basic abuse control, but counters can reset when a local server or Cloudflare isolate restarts.

The Staking Agent can also collect user feedback when users report bugs, complain about UX, or suggest improvements. Bind an optional KV namespace named `SAFECAFE_AGENT_FEEDBACK_KV` to store feedback records. Without this binding, feedback is written to structured server logs only. Raw feedback records use `feedback:raw:YYYY-MM-DD:<uuid>` keys; future offline summaries can use `feedback:summary:YYYY-MM-DD` without adding LLM work to the user request path.

### Safe Transaction Service

Used for Safe multisig proposal and confirmation management. Keep these values server-side or CLI-only; do not expose deployer Safe API keys as `VITE_*` browser variables.

The web app calls `/api/safe/transaction` for deployer-managed Safe Transaction Service access. Users who do not want to rely on the deployer's key can add their own Safe API key in Settings; that key is stored only in their browser local storage and used directly from the browser.

| Variable | Description |
| --- | --- |
| `SAFECAFE_SAFE_API_KEYS` | Server-side Safe Developer API keys for the Transaction Service. Supports multiple keys separated by commas, e.g. `key_a,key_b`. The server proxy will try the configured keys without exposing them to the browser; the CLI uses the first non-empty key. |
| `SAFECAFE_SAFE_TX_SERVICE_URL` | Optional custom server-side Safe Transaction Service base URL. Leave empty to use `https://api.safe.global/tx-service/eth/api`. |

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

The CLI can preview actions, execute from an EOA, or manage a Safe directly with an owner key. Live execution is always explicit: use `--send --yes` plus a hidden/private-key source such as `--private-key-prompt`, `--private-key-stdin`, or a configured environment/file secret. Raw private keys are never accepted as command-line arguments.

## Testing

See [TESTING.md](TESTING.md) for the integration and system smoke-test strategy.

## Deployment

Safecafe builds to a static frontend:

```bash
pnpm build:web
```

The output in `dist/` can be deployed to Cloudflare Pages, IPFS-style static hosting, or any static host that supports SPA fallback routing. Full server-side features under `/api/*` require Cloudflare Pages Functions. Pure static hosts can still run the core staking UI with wallet/public-RPC reads; Agent, hosted Safe Transaction Service sync, and server-side read APIs are enhanced features. On ENS/IPFS frontends, configure `VITE_API_BASE_URL` or use the built-in hosted fallback at `https://safecafe.baserun.link`.

Cloudflare Pages is the recommended primary public host. Filebase/IPFS is used for immutable release snapshots, and `safe-staking.eth` is configured to resolve through `https://safe-staking.eth.limo/` after its ENS contenthash points to the current `ipfs://<CID>`. See [CLOUDFLARE.md](CLOUDFLARE.md) for the full development, Cloudflare deployment, IPFS publishing, ENS update, and verification flow.

Maintainers can run the interactive production release wizard with:

```bash
pnpm release
```

If the current version is already published, the first run prepares the next patch version across the root package, safe-lite package, and frontend/CLI version constant, then stops for review and a manual commit. Run `pnpm release` again after committing to publish one build to IPFS and Cloudflare. Use `--bump=minor` or `--bump=major` when needed. When `.env` exists, the wizard uses it as the source of truth for Safecafe, Vite, and Filebase release configuration; shell values for missing release keys are ignored. Without `.env`, it uses the current shell environment. `VITE_*` values are consumed during build, and non-empty server runtime secrets are synchronized to Cloudflare Pages. Empty values do not delete existing Cloudflare secrets. Interrupted sessions can continue with `pnpm release --resume`; the wizard never updates ENS or commits release records automatically.

<!-- ipfs-latest:start -->
## Latest IPFS Release

- CID: `bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq`
- ENS contenthash: `ipfs://bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq`
- Filebase: https://ipfs.filebase.io/ipfs/bafybeidm3vzcww42dzwvqrmdxcbup4zlhvsvdi6gvazg7xsrygwbaqvptq/
- Release record: [releases/ipfs/latest.json](releases/ipfs/latest.json)

<!-- ipfs-latest:end -->

## Resilience

Safecafe is designed for Track A: permissionless, non-custodial access with verifiable static releases and user-configurable data/service endpoints. See [RESILIENCE.md](RESILIENCE.md) for the decentralization, uptime, signing, data-source, and release-verification model.

## Security

- Safecafe is non-custodial and prepares transactions for user review and signing.
- Keep `.env` files local. `.env.example` is the only environment file intended for git.
- Treat any exposed private key as compromised and replace it immediately.
- Prefer wallet/Safe review flows or hidden/private stdin signing over long-lived environment secrets.
- Report security issues privately before opening public issues.

## License

MIT. See [LICENSE](LICENSE).

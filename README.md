# Safecafe

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

Create a local `.env` file when you need custom RPC endpoints:

```bash
VITE_RPC_URL=https://your-ethereum-rpc.example
SAFECAFE_RPC_URL=https://your-ethereum-rpc.example
```

`VITE_RPC_URL` is used by the web app. `SAFECAFE_RPC_URL` is used by the CLI. Never commit private keys or wallet secrets.

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

The output in `dist/` can be deployed to Vercel, Cloudflare Pages, IPFS-style static hosting, or any static host that supports SPA fallback routing.

Cloudflare Pages is the recommended primary static host. See [CLOUDFLARE.md](CLOUDFLARE.md) for Git-connected deployments, direct Wrangler uploads, headers, routing, and release checks.

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

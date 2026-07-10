# Safecafe CLI

CLI entrypoint for Safecafe, a non-custodial Safenet staking toolkit.

The CLI is designed to actually manage Safenet staking. It can preview actions, execute them from an EOA, or manage a Safe directly with an owner key. It also includes a staking Agent mode for natural-language workflows.

## Development

```bash
pnpm cli --help
pnpm cli status --mock
pnpm build:cli
pnpm cli:packed status --mock
```

## Use

```bash
safecafe guide
safecafe status --account 0xYourAddress
safecafe validators --active
safecafe stake --account 0xYourAddress --validator "Core Contributors" --amount 100 --dry-run
safecafe stake --account 0xYourAddress --validator "Core Contributors" --amount 100 --send --private-key-prompt --yes
safecafe unstake --account 0xYourAddress --validator "Core Contributors" --amount 25 --dry-run
safecafe withdrawals --account 0xYourAddress
safecafe rewards --account 0xYourAddress
safecafe claim-withdrawal --account 0xYourAddress --dry-run
safecafe claim-rewards --account 0xYourAddress --dry-run
safecafe claim-rewards --account 0xYourSafe --send --signer 0xOwnerAddress --yes
safecafe agent --account 0xYourSafe -p "restake rewards to Core Contributors"
safecafe agent --account 0xYourSafe --resume --send --yes
safecafe agent --account 0xYourSafe
```

`--mock` is available only for local samples and documentation screenshots.

## Signing Model

Safecafe supports two execution models:

1. EOA accounts: use `--send --private-key-prompt --yes` for interactive execution. The private key is hidden while typed and used in memory for that run only.
2. Safe accounts: use the same `--send` flow with an owner key. For `1/1` Safes, the CLI executes immediately. For `n/m` Safes, the CLI proposes the Safe transaction, adds the current owner's confirmation, and executes it automatically once the threshold is met.

Live sending is intentionally explicit:

- `--account` is required.
- For EOAs, `--account` must match the provided private key.
- For Safes, the signing key must belong to a Safe owner.
- If multiple configured keys can operate the same Safe, pass `--signer <owner-address>` or set `SAFECAFE_CLI_SIGNER_ADDRESS`.
- `--yes` is required before any live transaction is submitted.
- Do not pass private keys as command-line arguments. Process arguments are commonly visible to other local tools.

For Safe multisig proposal and confirmation management, you can optionally provide:

- `SAFECAFE_SAFE_API_KEYS`
- `SAFECAFE_SAFE_TX_SERVICE_URL`

When using Safe's official Transaction Service, provide `SAFECAFE_SAFE_API_KEYS`. `SAFECAFE_SAFE_TX_SERVICE_URL` is only needed for a custom or self-hosted Transaction Service.

## Agent

The CLI Agent reuses the same supported staking actions as the web app:

- stake
- unstake
- claim rewards
- claim withdrawal
- restake rewards
- rebalance between validators

Examples:

```bash
safecafe agent --account 0xYourSafe -p "show my staking status"
safecafe agent --account 0xYourSafe -p "claim rewards"
safecafe agent --account 0xYourSafe -p "restake rewards to Core Contributors"
safecafe agent --account 0xYourSafe
safecafe agent --account 0xYourSafe -p "move 100 SAFE from Gnosis to Core Contributors"
safecafe agent --account 0xYourSafe --refresh
safecafe agent --account 0xYourSafe --resume --send --yes
safecafe agent --account 0xYourSafe --cancel
```

In REPL mode, type `resume`, `refresh`, or `cancel`.

The Agent persists the latest conversation state locally, then rebuilds the action from live chain state before execution. That makes interrupted multi-step flows more robust, because already-claimed rewards and already-sufficient allowance can be skipped automatically on the next run.

## CI / Automation

For CI or controlled automation, the CLI can read defaults from `.env` or environment variables without repeating the signing flags every run:

```bash
SAFECAFE_RPC_URL=...
SAFECAFE_SAFE_API_KEYS=key_a,key_b
SAFECAFE_SAFE_TX_SERVICE_URL=...
SAFECAFE_CLI_PRIVATE_KEY=0x...
SAFECAFE_CLI_PRIVATE_KEYS=0xOwnerA...,0xOwnerB...
SAFECAFE_CLI_SIGNER_ADDRESS=0xOwnerA...
SAFECAFE_CLI_SESSION_DIR=/tmp/safecafe-agent-sessions
```

You can also mount the signer secret as a file:

```bash
SAFECAFE_CLI_PRIVATE_KEY_FILE=/run/secrets/safecafe_owner_key
SAFECAFE_CLI_PRIVATE_KEY_FILES=/run/secrets/owner_a,/run/secrets/owner_b
```

When any of `SAFECAFE_CLI_PRIVATE_KEY`, `SAFECAFE_CLI_PRIVATE_KEYS`, `SAFECAFE_CLI_PRIVATE_KEY_FILE`, or `SAFECAFE_CLI_PRIVATE_KEY_FILES` is present, `--send` can run without explicitly passing `--private-key-env` / `--private-key-stdin` / `--private-key-prompt`.

For multi-owner Safe automation, the recommended setup is:

1. Put all candidate owner keys into `SAFECAFE_CLI_PRIVATE_KEYS` or `SAFECAFE_CLI_PRIVATE_KEY_FILES`.
2. Set `SAFECAFE_CLI_SIGNER_ADDRESS` for the default owner you want CI to use.
3. Override per run with `--signer <address>` when a different owner should confirm the Safe transaction.

This is intended for trusted local automation and CI only. Avoid committing private keys to the repo or sharing them through shell history or build logs.

## Bun

The source CLI supports Bun:

```bash
pnpm cli:bun status --mock
```

The root project also includes a build script for Bun single-file binaries. It first builds the CLI entrypoint, then compiles that entrypoint into a platform-specific executable:

```bash
pnpm build:cli:bun
./cli/dist-bin/safecafe status --mock
```

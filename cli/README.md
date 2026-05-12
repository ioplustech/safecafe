# Safecafe CLI

CLI entrypoint for Safecafe, a non-custodial Safenet staking toolkit.

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
safecafe operators --active
safecafe stake --account 0xYourAddress --validator "Core Contributors" --amount 100 --dry-run
safecafe unstake --account 0xYourAddress --validator "Core Contributors" --amount 25 --dry-run
safecafe withdrawals --account 0xYourAddress
safecafe rewards --account 0xYourAddress
safecafe claim-withdrawal --account 0xYourAddress --dry-run
safecafe claim-rewards --account 0xYourAddress --dry-run
safecafe stake --account 0xYourSafe --validator "Core Contributors" --amount 100 --safe-payload ./safecafe-safe.json
```

`--mock` is available only for local samples and documentation screenshots.

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

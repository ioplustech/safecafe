# Testing

Safecafe uses targeted tests for changed features, plus broader smoke tests before release.

## Targeted Agent Tests

Run:

```bash
pnpm test:agent:core
```

This exercises the deterministic Agent parser/compiler, server-side Agent tool calls, streaming events, feedback collection, RPC auth behavior, and core protocol helpers.

For the browser Agent stream UI, run:

```bash
pnpm test:agent:stream-ui
```

The combined Agent check is:

```bash
pnpm test:agent
```

## Safe Multisig CLI Tests

Run:

```bash
pnpm test:cli:safe
```

This verifies the CLI Safe execution path: owner-key selection, `n/m` proposal flow, second-owner confirmation, threshold handling, and execution once the Safe transaction has enough confirmations.

## Integration Tests

Run:

```bash
pnpm test:integration
```

This builds the CLI and exercises the packaged `safecafe` command in mock mode. It verifies the semantic command set:

- `status`
- `validators`
- `stake`
- `unstake`
- `withdrawals`
- `rewards`
- `claim-withdrawal`
- `claim-rewards`
- `agent`
- `contracts`
- `guide`

It also checks that old command names such as `brew`, `cool`, `tab`, and `beans` are no longer exposed.

The CLI test checks that live sending is exposed only through explicit advanced flags, raw private keys are not accepted as command-line arguments, and legacy payload/session flags are not exposed.

## System Smoke Tests

Run:

```bash
pnpm test:system
```

This builds the full project, starts the production preview server, checks key SPA routes, and confirms the packaged CLI exposes the expected command surface.

For a full browser system test pass, add Playwright coverage around:

- Logged-out dashboard state.
- Wallet connection with an injected wallet fixture.
- Live-read success and failure states.
- Stake, unstake, withdrawal claim, and reward claim review panels.
- Safe multisig proposal and confirmation states.
- Staking Agent action cards, feedback collection, and user-configured LLM mode.
- Mobile navigation and responsive layout.

## Live-Mock Browser Flow

Run:

```bash
pnpm test:e2e:live-mock
```

This builds the web app and runs a pseudo-live browser flow against mocked Pages Function responses. It is the preferred broad UI check when changing wallet connection, live account data, staking actions, Safe multisig behavior, or Staking Agent UI.

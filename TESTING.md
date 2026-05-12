# Testing

Safecafe uses two smoke-test layers before release.

## Integration Tests

Run:

```bash
pnpm test:integration
```

This builds the CLI and exercises the packaged `safecafe` command in mock mode. It verifies the semantic command set:

- `status`
- `operators`
- `stake`
- `unstake`
- `withdrawals`
- `rewards`
- `claim-withdrawal`
- `claim-rewards`
- `contracts`
- `guide`

It also verifies Safe Transaction Builder payload export and checks that old command names such as `brew`, `cool`, `tab`, and `beans` are no longer exposed.

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
- Safe Transaction Builder payload export.
- Mobile navigation and responsive layout.

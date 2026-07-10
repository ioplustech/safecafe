# Security Policy

Safecafe is a non-custodial staking interface. Users sign transactions from their own wallet, Safe, or explicitly selected CLI hot-wallet flow. The web app should never require private keys.

## Reporting

Please report security issues privately to the maintainers before opening a public issue. Include:

- Affected component or command
- Reproduction steps
- Expected impact
- Suggested mitigation, if known

## Secret Handling

- Do not commit `.env` files, private keys, mnemonics, API tokens, or wallet exports.
- Use `.env.example` for public configuration examples.
- If a private key is exposed, consider it compromised and rotate it immediately.
- For Safe accounts, prefer wallet/Safe review flows or the CLI Safe owner flow backed by Safe Transaction Service.
- For CLI live sending, prefer `--private-key-prompt`, `--private-key-stdin`, or mounted secret files. Avoid storing signing keys in `.env` or shell history unless the environment is controlled CI.

## Agent and API Keys

- Keep `SAFECAFE_LLM_API_KEY`, `SAFECAFE_SAFE_API_KEYS`, and RPC provider credentials server-side.
- User-provided LLM or Safe API keys are intended to stay in the user's browser storage and should not be committed or shared.
- The Staking Agent cannot sign or submit transactions by itself. Every on-chain operation must still go through explicit wallet or Safe owner confirmation.

## Supported Version

Security fixes are expected to target the latest `main` branch until tagged releases are introduced.

# Security Policy

Safecafe is a non-custodial staking interface. Users sign transactions from their own wallet or Safe, and the project should never require private keys in the web app.

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

## Supported Version

Security fixes are expected to target the latest `main` branch until tagged releases are introduced.

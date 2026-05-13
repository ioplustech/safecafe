# Cloudflare Deployment

Safecafe is a static Vite app, so the recommended Cloudflare target is Cloudflare Pages. This keeps the web app client-side, non-custodial, and independent of a proprietary backend.

## Recommended Setup

Create a Cloudflare Pages project connected to the GitHub repository:

- Project name: `safecafe`
- Production branch: `main`
- Framework preset: `Vite`
- Build command: `pnpm build:web`
- Build output directory: `dist`
- Node version: `22`

No Cloudflare secrets are required for normal builds. Add `VITE_RPC_URL` only if you want the deployed web app to use a specific RPC endpoint instead of the bundled public fallback endpoints.

## Direct Upload

For a manual deployment from a local machine:

```bash
pnpm cloudflare:deploy
```

This builds the web app and uploads `dist/` with Wrangler:

```bash
pnpm build:web
pnpm dlx wrangler@latest pages deploy dist --project-name safecafe
```

You must be authenticated first:

```bash
pnpm dlx wrangler@latest whoami
pnpm dlx wrangler@latest login
```

## Local Cloudflare Preview

```bash
pnpm cloudflare:preview
```

This serves the built `dist/` directory with Wrangler Pages locally.

## SPA Routing

Safecafe uses [public/_redirects](public/_redirects) so deep links such as `/validators` or `/rewards` resolve to `index.html` on Cloudflare Pages.

## Headers

Safecafe ships [public/_headers](public/_headers) for Cloudflare Pages:

- Basic browser hardening headers.
- Immutable caching for Vite fingerprinted assets under `/assets/*`.
- Shorter caching for `manifest.json`.

The project intentionally does not set a strict Content Security Policy yet because wallet providers and RPC endpoints can vary by user environment. Add a CSP only after testing injected wallets, custom RPC endpoints, and any future WalletConnect/Safe App integrations.

## Custom Domain

After the first successful Pages deployment:

1. Open the Cloudflare dashboard.
2. Go to Workers & Pages.
3. Select the `safecafe` Pages project.
4. Add a custom domain, for example `safecafe.example`.
5. Keep Vercel/IPFS deployments as independent fallback channels.

## Release Checklist

Before marking a Cloudflare deployment as production:

```bash
pnpm check
pnpm test:integration
pnpm test:system
pnpm audit --prod
```

Record the Cloudflare deployment URL in release notes together with:

- Git commit hash.
- Build command.
- Contract addresses.
- Cloudflare Pages URL.
- Secondary deployment URL, if available.
- IPFS CID, if available.
- CLI package version and checksums, if published.

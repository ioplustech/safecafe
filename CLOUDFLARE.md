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

Configure these environment variables before enabling the Staking Agent:

- `VITE_RPC_URL` (optional): browser-safe Ethereum RPC endpoint for live wallet reads. If omitted, the app uses bundled public fallback RPC endpoints.
- `SAFECAFE_RPC_URL`: server-side Ethereum RPC endpoint used by `/api/agent` to verify that the connected account has SAFE or a SAFE staking position before any remote LLM call.
- `SAFECAFE_LLM_API_BASE`: OpenAI-compatible chat completions base URL, kept server-side.
- `SAFECAFE_LLM_API_MODEL`: model name for the Staking Agent.
- `SAFECAFE_LLM_API_KEY`: server-side API key for the Agent proxy.

`SAFECAFE_LLM_API_KEY` must not be exposed as a `VITE_*` variable. The web app calls the Cloudflare Pages Function at `/api/agent`; the function reads the server-side `SAFECAFE_LLM_*` variables and returns only the Agent response.
Do not set `SAFECAFE_AGENT_TEST_VERIFIED_ACCESS` in production. It is reserved for automated tests that need to bypass the server-side wallet eligibility check.

For production, put `/api/agent` behind Cloudflare abuse controls such as Rate Limiting Rules and, if traffic grows, Turnstile or a Durable Object quota. The function also performs a server-side SAFE/staking eligibility check before any LLM call, but edge-level rate limits are still the cost-control layer.

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

## IPFS Release Via Filebase

Cloudflare Pages remains the fast hosted mirror. For immutable IPFS releases, use Filebase as the pinning/storage layer and keep Cloudflare Web3 IPFS Gateway as an optional read gateway only.

Configure local secrets in `.env`:

```bash
FILEBASE_ACCESS_TOKEN=...
FILEBASE_SECRET_KEY=...
FILEBASE_BUCKET=safecafe
FILEBASE_RELEASE_KEY_PREFIX=releases
FILEBASE_IPFS_MAX_BYTES=1500000
```

The Filebase SDK uses the Filebase S3 endpoint by default.

Publish a verified web build to Filebase:

```bash
pnpm check
pnpm test:integration
pnpm test:system
pnpm build:web
pnpm ipfs:size
pnpm ipfs:publish
```

The script builds `dist/`, writes `dist/release-manifest.json`, packs the files as an IPFS directory CAR through the Filebase SDK, uploads the CAR to the Filebase IPFS bucket, and prints:

```text
ipfs://<CID>
https://ipfs.filebase.io/ipfs/<CID>/
https://<CID>.ipfs.dweb.link/
```

Set the ENS `contenthash` for `safe-staking.eth` to the printed immutable URI:

```text
ipfs://<CID>
```

After the ENS transaction confirms, verify:

```text
https://safe-staking.eth.limo
```

Every content change creates a new CID. Keep old release CIDs pinned in Filebase if you want historical builds to remain retrievable.

The IPFS payload is intentionally lean:

- `index.html`, `manifest.json`, and other entry files use short caching so ENS contenthash updates are visible quickly.
- Vite fingerprinted files under `/assets/*` are immutable and can be cached for one year.
- `release-manifest.json` is immutable because it is inside a content-addressed CID.
- Large social-preview source images are excluded from the IPFS payload by default; publish with `--include-heavy-assets --allow-large` only when you explicitly want the larger archive.
- `FILEBASE_IPFS_MAX_BYTES` fails the publish if the final upload payload grows past the budget.
- `pnpm ipfs:size` prints the payload size and largest files without uploading or updating release records.

Do not treat Filebase's public IPFS gateway as the primary traffic endpoint. Filebase IPFS bandwidth is account-limited and can be exhausted by abusive traffic. Use Cloudflare Pages as the normal public mirror, use `safe-staking.eth.limo` as the ENS/IPFS fallback, and keep the raw Filebase gateway URL mainly for verification and release records. If Filebase gateway bandwidth is exhausted, the pinned CID can still be fetched through other IPFS gateways or native IPFS nodes as long as the content remains available on the IPFS network.

After a successful upload, the script also updates release records in git:

- [IPFS_RELEASES.md](IPFS_RELEASES.md): append-only human-readable release table.
- [releases/ipfs/latest.json](releases/ipfs/latest.json): machine-readable latest release record.
- `releases/ipfs/<CID>.json`: machine-readable immutable release snapshot.
- `README.md` and this document: latest CID blocks.

`dist/release-manifest.json` is included inside the IPFS directory and records build inputs, file hashes, commit, and contract addresses. The final root CID is recorded outside that IPFS directory in `releases/ipfs/*.json`, because writing the final CID into a file inside the directory would change the directory CID.

<!-- ipfs-latest:start -->
## Latest IPFS Release

- Version: `0.1.0`
- Commit: `4c87b8db92c32178df0cc61d3d747264ad99e86d`
- Dirty build: `yes`
- CID: `bafybeid5igerevatkm46z45thxssenbkeyfbikkip7v5n7mpubvlsst7ji`
- ENS contenthash: `ipfs://bafybeid5igerevatkm46z45thxssenbkeyfbikkip7v5n7mpubvlsst7ji`
- Filebase: https://ipfs.filebase.io/ipfs/bafybeid5igerevatkm46z45thxssenbkeyfbikkip7v5n7mpubvlsst7ji/
- dweb.link: https://bafybeid5igerevatkm46z45thxssenbkeyfbikkip7v5n7mpubvlsst7ji.ipfs.dweb.link/
- Build manifest: https://ipfs.filebase.io/ipfs/bafybeid5igerevatkm46z45thxssenbkeyfbikkip7v5n7mpubvlsst7ji/release-manifest.json
- Release record: [releases/ipfs/latest.json](releases/ipfs/latest.json)

After verifying the links, set `safe-staking.eth` contenthash to the ENS contenthash above.
<!-- ipfs-latest:end -->

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

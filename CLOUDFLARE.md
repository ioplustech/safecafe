# Cloudflare, IPFS, and ENS Deployment

Safecafe is a Vite app deployed primarily on Cloudflare Pages. The frontend remains non-custodial, while Pages Functions provide server-side API routes for authenticated RPC access, live account reads, Safe discovery, reward proofs, price data, and the Staking Agent.

The project has three deployment surfaces:

- Cloudflare Pages: primary public mirror for normal user traffic, fast caching, SPA routing, and Pages Functions under `/api/*`.
- Filebase/IPFS: immutable release snapshot. Each published build gets a content-addressed CID and release records.
- `safe-staking.eth`: ENS name whose contenthash points to the current IPFS release. It is already configured and can be checked through `https://safe-staking.eth.limo/`.

The operational rule is: ship normal traffic through Cloudflare Pages, publish every production release to IPFS, then update `safe-staking.eth` only after the new CID is verified.

## Day-to-Day Development

```bash
corepack enable
pnpm install
pnpm dev
```

Before deployment, run the checks that match the release scope:

```bash
pnpm check
pnpm build:web
pnpm test:agent
pnpm test:integration
pnpm test:system
```

For UI or Pages Function changes, prefer the Wrangler-backed browser smoke because it exercises `dist/` plus the root `functions/` directory:

```bash
pnpm test:e2e:live-mock
```

## Release Order

Use this order for a production release:

1. Finish code changes and review `git status --short`.
2. Run checks and build.
3. Deploy Cloudflare Pages as the primary mirror.
4. Publish the same release to Filebase/IPFS.
5. Verify the CID through at least two gateways.
6. Update the ENS contenthash for `safe-staking.eth` to `ipfs://<CID>`.
7. Verify `https://safe-staking.eth.limo/`.
8. Commit the generated release records and documentation updates.

Cloudflare deploy and IPFS publish are separate by design. Cloudflare may serve a mutable latest deployment, while IPFS/ENS is the immutable release anchor users can verify.

## Cloudflare Pages Setup

Create a Cloudflare Pages project connected to the GitHub repository:

- Project name: `safecafe`
- Production branch: `main`
- Framework preset: `Vite`
- Build command: `pnpm build:web`
- Build output directory: `dist`
- Node version: `22`

Configure these environment variables before enabling live account reads, authenticated RPC, or the Staking Agent:

- `VITE_RPC_URL` (optional): browser-safe Ethereum RPC endpoint for live wallet reads. If omitted, the app uses bundled public fallback RPC endpoints.
- `SAFECAFE_RPC_URL` or `SAFECAFE_RPC_URLS`: server-side Ethereum RPC endpoint(s) used by Pages Functions for authenticated RPC, live account data, Safe discovery, and Agent eligibility checks.
- `SAFECAFE_SAFE_API_KEYS`: server-side Safe Developer API key(s) for Safe Transaction Service operations. Use comma-separated values for multiple keys, for example `key_a,key_b`. The browser never receives this value; web multisig flows call `/api/safe/transaction`.
- `SAFECAFE_SAFE_TX_SERVICE_URL` (optional): custom server-side Safe Transaction Service base URL. Leave empty to use `https://api.safe.global/tx-service/eth/api`.
- `SAFECAFE_AUTH_SECRET`: server-side secret used to sign wallet-auth sessions for `/api/rpc/*` and Agent access.
- `SAFECAFE_RPC_ALLOW_ALL_WALLETS`: set to `false` in production unless you intentionally want signed wallet access without the SAFE/staking eligibility gate.
- `VITE_AGENT_AUTH`: set to `true` in production so live Agent calls require the signed wallet session.
- `SAFECAFE_LLM_API_BASE`: OpenAI-compatible chat completions base URL, kept server-side.
- `SAFECAFE_LLM_API_MODEL`: model name for the Staking Agent.
- `SAFECAFE_LLM_API_KEY`: server-side API key for the Agent proxy.
- `SAFECAFE_LLM_TIMEOUT_MS` and `SAFECAFE_LLM_MAX_TOKENS` (optional): server-side Agent request bounds.
- `SAFECAFE_AGENT_DAILY_LIMIT` (optional): daily `/api/agent` quota per signer wallet address. Default: `100`; `0` disables the quota.
- `SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT` (optional): daily `/api/agent/feedback` quota per signer or client IP. Default: `20`; `0` disables the quota.
- `SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE` (optional): global fallback IP limit for Pages Functions. Default: `120`; `0` disables this fallback.
- `SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE` (optional): IP limit for `/api/agent`. Default: `20`; `0` disables it.
- `SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE` (optional): IP limit for `/api/agent/feedback`. Default: `20`; `0` disables it.
- `SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE` (optional): IP limit for `/api/auth/challenge` and `/api/auth/verify`. Default: `30`; `0` disables it.
- `SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE` (optional): IP limit for read APIs such as `/api/account/live`, `/api/safes`, `/api/validators`, `/api/rewards/proof`, and `/api/price/safe`. Default: `60`; `0` disables it.
- `SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE` (optional): IP limit for `/api/rpc/ethereum`. Default: `120`; `0` disables it.
- `SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE` (optional): IP limit for `/api/safe/transaction`. Default: `30`; `0` disables it.

`SAFECAFE_LLM_API_KEY` must not be exposed as a `VITE_*` variable. The web app calls the Cloudflare Pages Function at `/api/agent`; the function reads the server-side `SAFECAFE_LLM_*` variables and returns only the Agent response.

The Agent daily quota is intentionally lightweight and in-memory. It is enough for basic abuse control, but counters can reset when Cloudflare starts a new isolate.

For Staking Agent feedback collection, optionally bind a KV namespace named `SAFECAFE_AGENT_FEEDBACK_KV`. Feedback collection is available even before Agent wallet eligibility is unlocked, so users can report blocked or confusing states. If the binding is not configured, feedback is recorded only in structured Pages Function logs. You can also set `SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT` to cap feedback submissions per signer or client IP.

Cloudflare Workers KV has a Free plan tier that is enough for initial Safecafe feedback collection: Cloudflare currently documents 100,000 reads/day, 1,000 writes/day, and 1 GB stored data on the Free plan. Feedback collection writes one small record per submitted feedback item, so it is safe to start on the free tier and watch usage before considering paid storage.

To deploy the optional feedback KV binding:

1. Create a Workers KV namespace named `SAFECAFE_AGENT_FEEDBACK_KV` in the Cloudflare dashboard, or with Wrangler:

   ```bash
   pnpm exec wrangler kv namespace create SAFECAFE_AGENT_FEEDBACK_KV
   ```

2. In the Cloudflare dashboard, open `Workers & Pages` -> `safecafe` -> `Settings` -> `Bindings` -> `Add` -> `KV namespace`.
3. Set `Variable name` to `SAFECAFE_AGENT_FEEDBACK_KV`, select the namespace created above, and save it for both Production and Preview if needed.
4. Redeploy the Pages project so the binding is available to `/api/agent` and `/api/agent/feedback`.

`SAFECAFE_SAFE_API_KEYS` must also stay server-side. Configure it in Cloudflare Pages as a secret or encrypted environment variable for each environment that needs Safe multisig proposal sync. With Wrangler, set it with:

```bash
pnpm exec wrangler pages secret put SAFECAFE_SAFE_API_KEYS --project-name safecafe
```

If you use the Cloudflare dashboard instead, add it under Pages -> safecafe -> Settings -> Environment variables, and configure Production and Preview separately as needed. Do not create a `VITE_SAFE_API_KEY` variable. Users can optionally add their own Safe API key in the app Settings page; that user key is stored in their browser and bypasses the deployer's server-side key.

Do not set `SAFECAFE_AGENT_TEST_VERIFIED_ACCESS` in production. It is reserved for automated tests that need to bypass the server-side wallet eligibility check.

For production, put `/api/agent` behind Cloudflare abuse controls such as Rate Limiting Rules and, if traffic grows, Turnstile or a Durable Object quota. The function also performs a server-side SAFE/staking eligibility check before any LLM call, but edge-level rate limits are still the cost-control layer.

## Pages Functions

This repo uses Cloudflare Pages Functions from the root [functions](functions) directory for API routes such as:

- `/api/agent`
- `/api/agent/feedback`
- `/api/rpc/ethereum`
- `/api/account/live`
- `/api/auth/challenge`
- `/api/auth/verify`
- `/api/safe/transaction`
- `/api/safes`
- `/api/validators`
- `/api/rewards/proof`
- `/api/price/safe`

When deploying with Wrangler from the project root, the `functions/` directory is deployed with the Pages project. Do not deploy by dragging only `dist/` into the Cloudflare dashboard if you need these API routes; dashboard drag-and-drop is only suitable for static assets.

## Direct Cloudflare Upload

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

After deployment, verify the primary mirror:

```bash
curl -I https://safecafe.pages.dev/
curl -I https://safecafe.pages.dev/api/agent
```

`/api/agent` should reject unsupported methods with a controlled error, not a static 404.

## Local Cloudflare Preview

```bash
pnpm cloudflare:preview
```

This builds `dist/` and serves the Pages app locally through Wrangler.

## IPFS Release Via Filebase

Cloudflare Pages remains the fast hosted mirror. For immutable IPFS releases, use Filebase as the pinning/storage layer.

Configure local secrets in `.env`:

```bash
FILEBASE_ACCESS_TOKEN=...
FILEBASE_SECRET_KEY=...
FILEBASE_BUCKET=safecafe
FILEBASE_RELEASE_KEY_PREFIX=releases
FILEBASE_IPFS_MAX_BYTES=1500000
```

The Filebase SDK uses the Filebase S3 endpoint by default.

Check the IPFS payload size before uploading:

```bash
pnpm check
pnpm build:web
pnpm ipfs:size
```

Publish a verified web build to Filebase:

```bash
pnpm check
pnpm test:agent
pnpm test:integration
pnpm test:system
pnpm ipfs:publish
```

If `dist/` is already the exact build you want to publish, use:

```bash
pnpm ipfs:publish:dist
```

The script builds `dist/` unless `--skip-build` is used, writes `dist/release-manifest.json`, packs the files as an IPFS directory CAR through the Filebase SDK, uploads the CAR to the Filebase IPFS bucket, and prints:

```text
ipfs://<CID>
https://ipfs.filebase.io/ipfs/<CID>/
https://<CID>.ipfs.dweb.link/
https://safe-staking.eth.limo/
```

The script also updates release records in git:

- [IPFS_RELEASES.md](IPFS_RELEASES.md): append-only human-readable release table.
- [releases/ipfs/latest.json](releases/ipfs/latest.json): machine-readable latest release record.
- `releases/ipfs/<CID>.json`: machine-readable immutable release snapshot.
- `README.md` and this document: latest CID blocks.

`dist/release-manifest.json` is included inside the IPFS directory and records build inputs, file hashes, commit, and contract addresses. The final root CID is recorded outside that IPFS directory in `releases/ipfs/*.json`, because writing the final CID into a file inside the directory would change the directory CID.

## `safe-staking.eth` ENS/IPFS Flow

`safe-staking.eth` is already configured to resolve through:

```text
https://safe-staking.eth.limo/
```

For each new immutable release:

1. Run `pnpm ipfs:publish` and copy the printed `ipfs://<CID>`.
2. Verify the raw CID before touching ENS:

```text
https://ipfs.filebase.io/ipfs/<CID>/
https://<CID>.ipfs.dweb.link/
https://ipfs.io/ipfs/<CID>/
```

3. Update the ENS `contenthash` for `safe-staking.eth` to:

```text
ipfs://<CID>
```

4. Wait for the ENS transaction and gateway cache to settle, then verify:

```text
https://safe-staking.eth.limo/
https://safe-staking.eth.limo/release-manifest.json
```

5. Compare the manifest and release record:

```bash
cat releases/ipfs/latest.json
```

The `eth.limo` URL is not a separate deployment. It resolves the ENS contenthash and serves the currently pointed IPFS CID. If users see older content there, first check whether ENS was updated to the new CID and whether the gateway cache has refreshed.

Every content change creates a new CID. Keep old release CIDs pinned in Filebase if you want historical builds to remain retrievable.

The IPFS payload is intentionally lean:

- `index.html`, `manifest.json`, and other entry files use short caching so ENS contenthash updates are visible quickly.
- Vite fingerprinted files under `/assets/*` are immutable and can be cached for one year.
- `release-manifest.json` is immutable because it is inside a content-addressed CID.
- Large social-preview source images are excluded from the IPFS payload by default; publish with `--include-heavy-assets --allow-large` only when you explicitly want the larger archive.
- `FILEBASE_IPFS_MAX_BYTES` fails the publish if the final upload payload grows past the budget.
- `pnpm ipfs:size` prints the payload size and largest files without uploading or updating release records.

Do not treat Filebase's public IPFS gateway as the primary traffic endpoint. Filebase IPFS bandwidth is account-limited and can be exhausted by abusive traffic. Use Cloudflare Pages as the normal public mirror, use `safe-staking.eth.limo` as the ENS/IPFS verification and fallback route, and keep the raw Filebase gateway URL mainly for verification and release records. If Filebase gateway bandwidth is exhausted, the pinned CID can still be fetched through other IPFS gateways or native IPFS nodes as long as the content remains available on the IPFS network.

## Release Records Sync

If a release was already published and only the generated docs or records need to be restored from the latest available record, run:

```bash
pnpm ipfs:sync-records
```

This reads the latest IPFS release record and rewrites the managed release sections without uploading new content.

## Rollback Model

Cloudflare and IPFS rollbacks are different:

- Cloudflare Pages can roll back to a previous deployment in the Cloudflare dashboard or by re-running `pnpm cloudflare:deploy` from a known-good commit.
- IPFS cannot mutate a CID. To roll back `safe-staking.eth`, update its ENS contenthash back to a previous known-good `ipfs://<CID>` from [IPFS_RELEASES.md](IPFS_RELEASES.md) or `releases/ipfs/*.json`.
- Keep release notes clear about which Cloudflare deployment URL and which IPFS CID represent the production release.

## SPA Routing

Safecafe uses [public/_redirects](public/_redirects) so deep links resolve to `index.html` on Cloudflare Pages.

## Headers

Safecafe ships [public/_headers](public/_headers) for Cloudflare Pages:

- Basic browser hardening headers.
- Immutable caching for Vite fingerprinted assets under `/assets/*`.
- Shorter caching for `manifest.json`.

The project intentionally does not set a strict Content Security Policy yet because wallet providers and RPC endpoints can vary by user environment. Add a CSP only after testing injected wallets, custom RPC endpoints, and any future WalletConnect/Safe App integrations.

<!-- ipfs-latest:start -->
## Latest IPFS Release

- Version: `0.1.0`
- Commit: `e2d6bb02cd6643b32c762d392a3220c78a27cb16`
- Dirty build: `yes`
- CID: `bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq`
- ENS contenthash: `ipfs://bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq`
- Filebase: https://ipfs.filebase.io/ipfs/bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq/
- dweb.link: https://bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq.ipfs.dweb.link/
- Build manifest: https://ipfs.filebase.io/ipfs/bafybeifp7i3jbrmmd2tuastqgydqtwoqkiivet6c4wz3mleallmfcqtkwq/release-manifest.json
- Release record: [releases/ipfs/latest.json](releases/ipfs/latest.json)

After verifying the links, set `safe-staking.eth` contenthash to the ENS contenthash above.
<!-- ipfs-latest:end -->

## Custom Domain

After the first successful Pages deployment:

1. Open the Cloudflare dashboard.
2. Go to Workers & Pages.
3. Select the `safecafe` Pages project.
4. Add a custom domain, for example `safecafe.example`.
5. Keep Cloudflare Pages and IPFS/ENS as independent release channels.

## Release Checklist

Before marking a Cloudflare deployment as production:

```bash
pnpm check
pnpm test:agent
pnpm test:integration
pnpm test:system
pnpm audit --prod
```

Record release notes with:

- Git commit hash.
- Build command.
- Contract addresses.
- Cloudflare Pages URL.
- IPFS CID and `ipfs://<CID>`, if published.
- `safe-staking.eth.limo` verification status.
- Release manifest URL.
- CLI package version and checksums, if published.

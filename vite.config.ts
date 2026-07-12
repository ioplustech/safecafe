import type { IncomingMessage, ServerResponse } from "node:http"
import react from "@vitejs/plugin-react"
import { config as loadEnv } from "dotenv"
import { defineConfig } from "vite"
import { handleAccountLiveRequest } from "./src/server/accountLive"
import { handleAgentApiRequest } from "./src/server/agentApi"
import { handleAgentFeedbackRequest } from "./src/server/agentFeedback"
import { handleRewardProofRequest } from "./src/server/rewardsProof"
import {
  handleEthereumRpcGatewayRequest,
  handleRpcChallengeRequest,
  handleRpcVerifyRequest,
} from "./src/server/rpcGateway"
import { handleSafeDiscoveryRequest } from "./src/server/safeDiscovery"
import { handleSafePriceRequest } from "./src/server/safePrice"
import { handleSafeTxServiceRequest } from "./src/server/safeTxService"
import { handleValidatorsRequest } from "./src/server/validators"

loadEnv()

export default defineConfig({
  plugins: [
    react(),
    {
      name: "safecafe-agent-api",
      configureServer(server) {
        const handleApi = async (
          req: IncomingMessage,
          res: ServerResponse,
          path: string,
          handler: (request: Request) => Promise<Response>,
        ) => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          const incomingUrl = new URL(req.url ?? "/", "http://localhost")
          const request = new Request(`http://localhost${path}${incomingUrl.search}`, {
            method: req.method,
            headers: req.headers as HeadersInit,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
          })
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => {
            res.setHeader(key, value)
          })
          if (response.body) {
            const reader = response.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(Buffer.from(value))
            }
            res.end()
            return
          }
          res.end()
        }
        const env = {
          SAFECAFE_RPC_ALLOW_ALL_WALLETS: process.env.SAFECAFE_RPC_ALLOW_ALL_WALLETS,
          SAFECAFE_AUTH_SECRET: process.env.SAFECAFE_AUTH_SECRET,
          SAFECAFE_MOCK_ACCOUNT: process.env.SAFECAFE_MOCK_ACCOUNT,
          SAFECAFE_MOCK_ACCOUNT_LIVE: process.env.SAFECAFE_MOCK_ACCOUNT_LIVE,
          SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT: process.env.SAFECAFE_AGENT_FEEDBACK_DAILY_LIMIT,
          SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE:
            process.env.SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE: process.env.SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: process.env.SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE: process.env.SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: process.env.SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_RPC_URL: process.env.SAFECAFE_RPC_URL,
          SAFECAFE_RPC_URLS: process.env.SAFECAFE_RPC_URLS,
          SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE: process.env.SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_SAFE_API_KEYS: process.env.SAFECAFE_SAFE_API_KEYS,
          SAFECAFE_SAFE_TX_SERVICE_URL: process.env.SAFECAFE_SAFE_TX_SERVICE_URL,
          SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE: process.env.SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE,
          SAFECAFE_LLM_API_BASE: process.env.SAFECAFE_LLM_API_BASE,
          SAFECAFE_LLM_API_MODEL: process.env.SAFECAFE_LLM_API_MODEL,
          SAFECAFE_LLM_API_KEY: process.env.SAFECAFE_LLM_API_KEY,
          SAFECAFE_LLM_TIMEOUT_MS: process.env.SAFECAFE_LLM_TIMEOUT_MS,
          SAFECAFE_LLM_MAX_TOKENS: process.env.SAFECAFE_LLM_MAX_TOKENS,
          SAFECAFE_LLM_HEADER: process.env.SAFECAFE_LLM_HEADER,
          SAFECAFE_AGENT_DAILY_LIMIT: process.env.SAFECAFE_AGENT_DAILY_LIMIT,
          VITE_AGENT_AUTH: process.env.VITE_AGENT_AUTH,
        }
        server.middlewares.use("/api/agent/feedback", async (req, res) => {
          await handleApi(req, res, "/api/agent/feedback", (request) => handleAgentFeedbackRequest(request, env))
        })
        server.middlewares.use("/api/agent", async (req, res) => {
          await handleApi(req, res, "/api/agent", (request) => handleAgentApiRequest(request, env))
        })
        server.middlewares.use("/api/account/live", async (req, res) => {
          await handleApi(req, res, "/api/account/live", (request) => handleAccountLiveRequest(request, env))
        })
        server.middlewares.use("/api/validators", async (req, res) => {
          await handleApi(req, res, "/api/validators", (request) => handleValidatorsRequest(request, env))
        })
        server.middlewares.use("/api/rewards/proof", async (req, res) => {
          await handleApi(req, res, "/api/rewards/proof", (request) => handleRewardProofRequest(request, env))
        })
        server.middlewares.use("/api/price/safe", async (req, res) => {
          await handleApi(req, res, "/api/price/safe", (request) => handleSafePriceRequest(request, env))
        })
        server.middlewares.use("/api/safes", async (req, res) => {
          await handleApi(req, res, "/api/safes", (request) => handleSafeDiscoveryRequest(request, env))
        })
        server.middlewares.use("/api/safe/transaction", async (req, res) => {
          await handleApi(req, res, "/api/safe/transaction", (request) => handleSafeTxServiceRequest(request, env))
        })
        server.middlewares.use("/api/auth/challenge", async (req, res) => {
          await handleApi(req, res, "/api/auth/challenge", (request) => handleRpcChallengeRequest(request, env))
        })
        server.middlewares.use("/api/auth/verify", async (req, res) => {
          await handleApi(req, res, "/api/auth/verify", (request) => handleRpcVerifyRequest(request, env))
        })
        server.middlewares.use("/api/rpc/ethereum", async (req, res) => {
          await handleApi(req, res, "/api/rpc/ethereum", (request) => handleEthereumRpcGatewayRequest(request, env))
        })
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react"
          if (id.includes("node_modules/viem")) return "viem"
          if (id.includes("node_modules/lucide-react")) return "icons"
        },
      },
    },
  },
  server: {
    port: 5175,
  },
})

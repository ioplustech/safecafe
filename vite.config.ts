import type { IncomingMessage, ServerResponse } from "node:http"
import react from "@vitejs/plugin-react"
import { config as loadEnv } from "dotenv"
import { defineConfig } from "vite"
import { handleAccountLiveRequest } from "./src/server/accountLive"
import { handleAgentApiRequest } from "./src/server/agentApi"
import {
  handleEthereumRpcGatewayRequest,
  handleRpcChallengeRequest,
  handleRpcVerifyRequest,
} from "./src/server/rpcGateway"
import { handleSafeDiscoveryRequest } from "./src/server/safeDiscovery"
import { handleSafePriceRequest } from "./src/server/safePrice"

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
          SAFECAFE_AGENT_AUTH: process.env.SAFECAFE_AGENT_AUTH,
          SAFECAFE_MOCK_ACCOUNT: process.env.SAFECAFE_MOCK_ACCOUNT,
          SAFECAFE_MOCK_ACCOUNT_LIVE: process.env.SAFECAFE_MOCK_ACCOUNT_LIVE,
          SAFECAFE_RPC_URL: process.env.SAFECAFE_RPC_URL,
          SAFECAFE_RPC_URLS: process.env.SAFECAFE_RPC_URLS,
          SAFECAFE_LLM_API_BASE: process.env.SAFECAFE_LLM_API_BASE,
          SAFECAFE_LLM_API_MODEL: process.env.SAFECAFE_LLM_API_MODEL,
          SAFECAFE_LLM_API_KEY: process.env.SAFECAFE_LLM_API_KEY,
          SAFECAFE_LLM_TIMEOUT_MS: process.env.SAFECAFE_LLM_TIMEOUT_MS,
          SAFECAFE_LLM_MAX_TOKENS: process.env.SAFECAFE_LLM_MAX_TOKENS,
          VITE_AGENT_AUTH: process.env.VITE_AGENT_AUTH,
        }
        server.middlewares.use("/api/agent", async (req, res) => {
          await handleApi(req, res, "/api/agent", (request) => handleAgentApiRequest(request, env))
        })
        server.middlewares.use("/api/account/live", async (req, res) => {
          await handleApi(req, res, "/api/account/live", (request) => handleAccountLiveRequest(request, env))
        })
        server.middlewares.use("/api/price/safe", async (req, res) => {
          await handleApi(req, res, "/api/price/safe", handleSafePriceRequest)
        })
        server.middlewares.use("/api/safes", async (req, res) => {
          await handleApi(req, res, "/api/safes", (request) => handleSafeDiscoveryRequest(request, env))
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
        manualChunks: {
          react: ["react", "react-dom"],
          viem: ["viem"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    port: 5175,
  },
})

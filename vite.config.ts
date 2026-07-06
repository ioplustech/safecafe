import react from "@vitejs/plugin-react"
import { config as loadEnv } from "dotenv"
import { defineConfig } from "vite"
import { handleAgentApiRequest } from "./src/server/agentApi"

loadEnv()

export default defineConfig({
  plugins: [
    react(),
    {
      name: "safecafe-agent-api",
      configureServer(server) {
        server.middlewares.use("/api/agent", async (req, res) => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          const request = new Request("http://localhost/api/agent", {
            method: req.method,
            headers: req.headers as HeadersInit,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
          })
          const response = await handleAgentApiRequest(request, {
            SAFECAFE_RPC_URL: process.env.SAFECAFE_RPC_URL,
            SAFECAFE_LLM_API_BASE: process.env.SAFECAFE_LLM_API_BASE,
            SAFECAFE_LLM_API_MODEL: process.env.SAFECAFE_LLM_API_MODEL,
            SAFECAFE_LLM_API_KEY: process.env.SAFECAFE_LLM_API_KEY,
          })
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

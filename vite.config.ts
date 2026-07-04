import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          viem: ["viem", "viem/chains"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    port: 5175,
  },
})

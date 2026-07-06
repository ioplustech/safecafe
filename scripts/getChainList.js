import fs from "node:fs"
import https from "node:https"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TIMEOUT_MS = 15_000

const chainlistTask = async () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "chainid.network",
      path: "/chains.json",
      method: "GET",
      timeout: TIMEOUT_MS,
    }

    console.log("Starting fetch chainid.network/chains.json")

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        res.resume()
        return
      }

      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        try {
          const chains = JSON.parse(Buffer.concat(chunks).toString())
          const outputPath = path.join(__dirname, "getChainList.json")
          fs.writeFileSync(outputPath, JSON.stringify({ chains }, null, 2))
          console.log(`Successfully saved ${chains.length} chains to getChainList.json`)
          resolve({ chains })
        } catch (error) {
          reject(error)
        }
      })
    })

    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Request timed out"))
    })

    req.on("error", (error) => {
      reject(error)
    })

    req.end()
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  chainlistTask().catch((error) => {
    console.error("Error:", error.message)
    process.exit(1)
  })
}

export default chainlistTask

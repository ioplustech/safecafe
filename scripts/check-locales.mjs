import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const localeDir = new URL("../src/app/locales/", import.meta.url)
const files = readdirSync(localeDir)
  .filter((file) => file.endsWith(".json"))
  .sort()

if (!files.includes("en.json")) {
  throw new Error("Missing base locale: en.json")
}

const base = readLocale("en.json")
const baseKeys = Object.keys(base)
  .filter((key) => key !== "_meta")
  .sort()

for (const file of files) {
  const locale = readLocale(file)
  const code = basename(file, ".json")
  const meta = locale._meta
  if (!meta || typeof meta !== "object") throw new Error(`${file}: missing _meta object`)
  for (const key of ["code", "label", "nativeLabel", "shortLabel"]) {
    if (typeof meta[key] !== "string" || meta[key].trim() === "") throw new Error(`${file}: invalid _meta.${key}`)
  }
  if (meta.code !== code) throw new Error(`${file}: _meta.code must match filename`)
  if (!Array.isArray(meta.detect) || meta.detect.length === 0) throw new Error(`${file}: invalid _meta.detect`)

  const keys = Object.keys(locale)
    .filter((key) => key !== "_meta")
    .sort()
  const missing = baseKeys.filter((key) => !keys.includes(key))
  const extra = keys.filter((key) => !baseKeys.includes(key))
  if (missing.length || extra.length) {
    throw new Error(`${file}: locale keys mismatch. missing=${missing.join(",")} extra=${extra.join(",")}`)
  }
}

console.log(
  `Locale check passed for ${files.length} locales: ${files.map((file) => basename(file, ".json")).join(", ")}`,
)

function readLocale(file) {
  return JSON.parse(readFileSync(join(localeDir.pathname, file), "utf8"))
}

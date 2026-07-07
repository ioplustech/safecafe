import enJson from "./locales/en.json"

type LocaleMeta = {
  code: string
  detect: string[]
  label: string
  nativeLabel: string
  shortLabel: string
}

type LocaleSource = {
  _meta: LocaleMeta
} & Record<string, string | LocaleMeta | string[]>

type EnglishMessages = Omit<typeof enJson, "_meta">

export type MessageKey = keyof EnglishMessages
export type MessageBundle = Record<MessageKey, string>
export type Locale = string
export type LocaleOption = LocaleMeta

const localeModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, LocaleSource>

const defaultLocale = "en"
const defaultMessages = stripMeta(enJson as LocaleSource)
const messageKeys = Object.keys(defaultMessages) as MessageKey[]

export const messages = Object.fromEntries(
  Object.entries(localeModules)
    .map(([path, source]) => normalizeLocale(path, source))
    .sort(([a], [b]) => (a === defaultLocale ? -1 : b === defaultLocale ? 1 : a.localeCompare(b))),
) as Record<Locale, MessageBundle>

export const localeOptions = Object.values(localeModules)
  .map((source) => source._meta)
  .sort((a, b) => (a.code === defaultLocale ? -1 : b.code === defaultLocale ? 1 : a.label.localeCompare(b.label)))

export function isLocale(value: string | null | undefined): value is Locale {
  return Boolean(value && messages[value])
}

export function detectLocale(language: string): Locale {
  const normalized = language.toLowerCase()
  const matched = localeOptions.find((option) =>
    option.detect.some((tag) => normalized === tag.toLowerCase() || normalized.startsWith(`${tag.toLowerCase()}-`)),
  )
  return matched?.code ?? defaultLocale
}

export function getMessages(locale: Locale): MessageBundle {
  return messages[locale] ?? messages[defaultLocale]
}

function normalizeLocale(path: string, source: LocaleSource): [Locale, MessageBundle] {
  const code = source._meta.code || path.replace(/^.*\/([^/]+)\.json$/, "$1")
  return [code, fillMissingMessages(stripMeta(source))]
}

function stripMeta(source: LocaleSource): Partial<MessageBundle> {
  const { _meta, ...bundle } = source
  return bundle as Partial<MessageBundle>
}

function fillMissingMessages(source: Partial<MessageBundle>): MessageBundle {
  return Object.fromEntries(messageKeys.map((key) => [key, source[key] ?? defaultMessages[key]])) as MessageBundle
}

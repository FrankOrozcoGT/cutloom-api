import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const templatesDir = dirname(fileURLToPath(import.meta.url))

/**
 * Carga un template de prompt (.md, junto a este archivo) e interpola sus
 * placeholders {{variable}} — los prompts de LLM no viven embebidos como
 * template literals en el código TypeScript, viven como markdown editable
 * por separado. El archivo se lee una sola vez y se cachea en memoria.
 */
const cache = new Map<string, string>()

function readTemplate(fileName: string): string {
  const cached = cache.get(fileName)
  if (cached !== undefined) {
    return cached
  }
  const content = readFileSync(join(templatesDir, fileName), 'utf-8')
  cache.set(fileName, content)
  return content
}

export function renderPromptTemplate(fileName: string, variables: Record<string, string>): string {
  const template = readTemplate(fileName)
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key]
    if (value === undefined) {
      throw new Error(`Missing variable "${key}" for prompt template "${fileName}"`)
    }
    return value
  })
}

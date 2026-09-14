import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Carga un template de prompt (.md) e interpola sus placeholders {{variable}} —
 * los prompts de LLM no viven embebidos como template literals en el código
 * TypeScript, viven como markdown editable por separado. El archivo se lee una
 * sola vez y se cachea en memoria. Cada bounded context que consume LLM tiene
 * su propia carpeta de templates; `templatesDir` la fija ese caller.
 */
export function createPromptTemplateLoader(templatesDir: string) {
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

  return function renderPromptTemplate(fileName: string, variables: Record<string, string>): string {
    const template = readTemplate(fileName)
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = variables[key]
      if (value === undefined) {
        throw new Error(`Missing variable "${key}" for prompt template "${fileName}"`)
      }
      return value
    })
  }
}

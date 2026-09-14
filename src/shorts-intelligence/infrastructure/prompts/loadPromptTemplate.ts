import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPromptTemplateLoader } from '../../../shared/infrastructure/prompts/loadPromptTemplate'

const templatesDir = dirname(fileURLToPath(import.meta.url))

export const renderPromptTemplate = createPromptTemplateLoader(templatesDir)

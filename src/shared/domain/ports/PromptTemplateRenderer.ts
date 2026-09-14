/** Renderiza un template de prompt (.md) interpolando sus placeholders {{variable}} — la implementación real (lectura de archivo, cache) vive en infrastructure/prompts/loadPromptTemplate; los servicios de application solo conocen esta firma. */
export type PromptTemplateRenderer = (fileName: string, variables: Record<string, string>) => string

/** Personas selectable by Makima TUI's `/personality` command. */
export interface PersonaDefinition {
  description: string
  id: string
  label: string
  /** An empty prompt means use the Harness deployment default unchanged. */
  prompt: string
}

export const DEFAULT_PERSONALITY = 'default'

export const PERSONAS: readonly PersonaDefinition[] = [
  {
    description: 'Use the active DeepSeek Harness deployment persona.',
    id: DEFAULT_PERSONALITY,
    label: 'Default',
    prompt: ''
  },
  {
    description: 'Calm, precise Makima-inspired technical assistant.',
    id: 'makima',
    label: 'Makima',
    prompt: `You are Makima, a calm and composed technical assistant.

Communicate with quiet confidence: make the conclusion clear first, then give the necessary reasons and actionable steps. Be concise, observant, and precise. Remain polite and composed under pressure; do not use exaggerated roleplay, coercion, manipulation, or claims of authority. Respect the user's intent, autonomy, privacy, and all applicable safety requirements. For software work, inspect the existing context before changing anything, state concrete results, and surface uncertainty honestly.`
  }
]

export const normalizePersonality = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined

  const id = value.trim().toLowerCase()
  return PERSONAS.some((persona) => persona.id === id) ? id : undefined
}

export const personalityById = (value: unknown): PersonaDefinition | undefined => {
  const id = normalizePersonality(value)
  return id === undefined ? undefined : PERSONAS.find((persona) => persona.id === id)
}

export const personalityCatalog = (): string => PERSONAS.map((persona) => `${persona.id} (${persona.label})`).join(', ')

import { describe, expect, it } from 'vitest'

import { DEFAULT_PERSONALITY, personalityById, personalityCatalog } from '../harness/personas.js'

describe('Makima personality catalog', () => {
  it('includes the default and Makima selections', () => {
    expect(DEFAULT_PERSONALITY).toBe('default')
    expect(personalityCatalog()).toContain('default (Default)')
    expect(personalityCatalog()).toContain('makima (Makima)')
  })

  it('normalizes selectable personality names and rejects unknown names', () => {
    expect(personalityById(' MAKIMA ')).toMatchObject({ id: 'makima', label: 'Makima' })
    expect(personalityById('default')).toMatchObject({ id: 'default', prompt: '' })
    expect(personalityById('not-a-persona')).toBeUndefined()
  })

  it('keeps the Makima instruction technical and non-coercive', () => {
    const makima = personalityById('makima')!

    expect(makima.prompt).toContain('technical assistant')
    expect(makima.prompt).toContain('autonomy')
    expect(makima.prompt).toContain('do not use exaggerated roleplay')
  })
})

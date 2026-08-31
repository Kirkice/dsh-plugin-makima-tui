import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SkillsMcpManager, validateMcpServer } from '../domain/skillsMcpManager.js'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'makima-skills-mcp-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  const home = join(root, 'home')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  return { dshHome, home, manager: new SkillsMcpManager({ dshHome, home, workspace }), workspace }
}

function writeSkill(path: string, name = 'example-skill') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `---\nname: ${name}\ndescription: Useful test skill\nwhenToUse: Testing\n---\n# ${name}\n`, 'utf8')
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { force: true, recursive: true })
})

describe('SkillsMcpManager', () => {
  it('lists and toggles only skills from managed roots', () => {
    const { manager, workspace } = fixture()
    const path = join(workspace, '.dsh', 'skills', 'sample', 'SKILL.md')
    writeSkill(path, 'sample')

    expect(manager.listSkills()).toMatchObject([{ enabled: true, kind: 'bundle', name: 'sample', path }])
    manager.setSkillEnabled(path, false)

    expect(manager.readSkill(path)).toMatchObject({ enabled: false, name: 'sample' })
    expect(readFileSync(path, 'utf8')).toContain('disable-model-invocation: true')
    expect(() => manager.setSkillEnabled(join(workspace, 'outside.md'), true)).toThrow('outside managed roots')
  })

  it('imports valid selected skill files into the shared DSH root', () => {
    const { dshHome, manager, workspace } = fixture()
    const source = join(workspace, 'incoming.md')
    writeSkill(source, 'incoming')

    expect(manager.importSkills([{ kind: 'file', sourcePath: source }])).toEqual([{ name: 'incoming.md', ok: true }])
    expect(readFileSync(join(dshHome, 'skills', 'incoming.md'), 'utf8')).toContain('name: incoming')
  })

  it('persists normalized shared MCP configuration and updates enabled state', () => {
    const { dshHome, manager } = fixture()
    const server = manager.saveMcpServer({ args: ['server.js'], command: 'node', name: 'local', transport: 'stdio' })

    expect(server).toMatchObject({ enabled: true, name: 'local', transport: 'stdio' })
    expect(manager.setMcpEnabled('local', false)).toMatchObject({ enabled: false, name: 'local' })
    expect(manager.listMcpServers()).toMatchObject([{ enabled: false, name: 'local', transport: 'stdio' }])
    expect(readFileSync(join(dshHome, 'mcp.json'), 'utf8')).toContain('"local"')
  })

  it('validates MCP transport requirements', () => {
    expect(validateMcpServer({ name: 'bad name', transport: 'stdio' })).toContain('invalid name')
    expect(validateMcpServer({ name: 'remote', transport: 'streamable-http' })).toContain('requires url')
    expect(validateMcpServer({ name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.test' })).toBeNull()
  })
})

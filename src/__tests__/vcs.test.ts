import { describe, expect, it } from 'vitest'

import { parseGitStatus, parseP4Opened, parseSvnStatus } from '../lib/vcs.js'

describe('VCS status parsers', () => {
  it('preserves Git staged, modified, untracked, and renamed paths', () => {
    expect(parseGitStatus(' M src/a.ts\nA  src/new.ts\n?? notes.md\nR  old.ts -> new.ts')).toEqual([
      { kind: 'modified', path: 'src/a.ts', status: ' M' },
      { kind: 'added', path: 'src/new.ts', status: 'A ' },
      { kind: 'added', path: 'notes.md', status: '??' },
      { kind: 'modified', path: 'new.ts', status: 'R ' }
    ])
  })

  it('keeps Perforce actions rather than forcing Git terminology', () => {
    expect(parseP4Opened('//depot/app.ts#3 - edit default change (text)\n//depot/old.ts#1 - delete default change (text)')).toEqual([
      { kind: 'modified', path: '//depot/app.ts', status: 'edit' },
      { kind: 'deleted', path: '//depot/old.ts', status: 'delete' }
    ])
  })

  it('recognizes Subversion status columns', () => {
    expect(parseSvnStatus('M       src/a.ts\n?       scratch.txt\nD       src/old.ts')).toEqual([
      { kind: 'modified', path: 'src/a.ts', status: 'M' },
      { kind: 'added', path: 'scratch.txt', status: '?' },
      { kind: 'deleted', path: 'src/old.ts', status: 'D' }
    ])
  })
})

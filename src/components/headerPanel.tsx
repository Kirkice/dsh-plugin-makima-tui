import { Box, Text } from '@makima-tui/ink'
import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { $uiState } from '../app/uiStore.js'
import type { AppLayoutProps } from '../app/interfaces.js'
import { shortCwd } from '../domain/paths.js'
import type { Theme } from '../theme.js'

export const HeaderPanel = memo(function HeaderPanel({ cols, cwdLabel, status }: { cols: number; cwdLabel: string; status: string }) {
  const ui = useStore($uiState)
  const t: Theme = ui.theme
  const model = ui.info?.model?.split('/').pop() || 'model pending'
  const permission = ui.permissionMode || 'default'
  const title = ui.sessionTitle || 'new session'
  const compact = cols < 78
  const narrow = cols < 52
  const path = cwdLabel || shortCwd(process.cwd())

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1} paddingTop={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text bold color={t.color.primary}>
          makima tui
        </Text>
        <Text color={ui.busy ? t.color.warn : t.color.ok}>{ui.busy ? '● working' : '○ ready'}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" width="100%">
        <Text color={t.color.accent}>{model}</Text>
        {!narrow && <Text color={t.color.muted}> · {permission}</Text>}
        {!compact && <Text color={t.color.muted}> · {path}</Text>}
        {!narrow && title !== 'new session' && <Text color={t.color.muted}> · {title}</Text>}
      </Box>
      {status && ui.busy && (
        <Text color={t.color.muted} wrap="truncate-end">
          {status}
        </Text>
      )}
    </Box>
  )
})

export type HeaderPanelProps = Pick<AppLayoutProps, 'status'>

export type QualityGateStatus = 'failed' | 'passed' | 'pending' | 'running' | 'skipped'

export interface QualityGateCheck {
  command: string
  durationMs?: number
  name: string
  status: QualityGateStatus
  summary?: string
}

export interface QualityGateSummary {
  failed: number
  passed: number
  pending: number
  running: number
  status: QualityGateStatus
  total: number
}

/** Derives a conservative release signal from independently reported checks. */
export const qualityGateSummary = (checks: readonly QualityGateCheck[]): QualityGateSummary => {
  const counts = checks.reduce((acc, check) => ({ ...acc, [check.status]: acc[check.status] + 1 }), {
    failed: 0,
    passed: 0,
    pending: 0,
    running: 0,
    skipped: 0
  } as Record<QualityGateStatus, number>)
  const status: QualityGateStatus = counts.failed
    ? 'failed'
    : counts.running
      ? 'running'
      : counts.pending
        ? 'pending'
        : checks.length && counts.passed
          ? 'passed'
          : 'skipped'

  return { failed: counts.failed, passed: counts.passed, pending: counts.pending, running: counts.running, status, total: checks.length }
}

export const qualityGateStatusLabel = (status: QualityGateStatus): string => {
  switch (status) {
    case 'failed':
      return 'FAILED'
    case 'passed':
      return 'PASSED'
    case 'pending':
      return 'PENDING'
    case 'running':
      return 'RUNNING'
    default:
      return 'NO CHECKS'
  }
}

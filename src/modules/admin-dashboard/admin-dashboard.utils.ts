import { getKolkataDateString } from '../tasks/task-time.utils';

export { getKolkataDateString };

export const ONLINE_THRESHOLD_MINUTES = 20;
export const ONLINE_THRESHOLD_MS = ONLINE_THRESHOLD_MINUTES * 60 * 1000;
export const ASIA_KOLKATA_TIMEZONE = 'Asia/Kolkata';

/**
 * Resolves calendar date range boundaries in Asia/Kolkata (+05:30) timezone.
 * Defaults to the last 30 calendar days if dates are omitted.
 */
export function resolveAdminDateRange(fromStr?: string, toStr?: string): { from: Date; to: Date } {
  const now = new Date();
  let to: Date;
  let from: Date;

  if (toStr) {
    const toYmd = toStr.trim().split('T')[0];
    to = new Date(`${toYmd}T23:59:59.999+05:30`);
  } else {
    to = now;
  }

  if (fromStr) {
    const fromYmd = fromStr.trim().split('T')[0];
    from = new Date(`${fromYmd}T00:00:00.000+05:30`);
  } else {
    // Exactly 30 days prior to 'to'
    from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  return { from, to };
}

/**
 * Calculates session duration strictly according to:
 * Session duration = (revokedAt ?? lastUsedAt) - createdAt.
 * Never use the current time. Treat EXPIRED sessions as ended at lastUsedAt.
 */
export function calculateSessionDurationSeconds(session: {
  createdAt: Date;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  status?: string | null;
}): number {
  if (!session || !session.createdAt) return 0;
  const end = session.revokedAt ?? session.lastUsedAt;
  if (!end) return 0;

  const diffMs = end.getTime() - session.createdAt.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

/**
 * Formats duration in seconds to a human-readable string (e.g. "4h 25m", "15m", "0m").
 */
export function formatDurationHuman(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Determines whether an employee is online:
 * Online status = ACTIVE session with lastUsedAt within the last 20 minutes (ONLINE_THRESHOLD_MS),
 * or createdAt within the last 20 minutes if lastUsedAt is null.
 */
export function computeIsOnline(
  sessions: Array<{
    status: string;
    lastUsedAt?: Date | null;
    createdAt: Date;
  }>,
  now = new Date(),
): boolean {
  if (!sessions || sessions.length === 0) return false;
  const cutoff = new Date(now.getTime() - ONLINE_THRESHOLD_MS);

  return sessions.some((s) => {
    if (s.status !== 'ACTIVE') return false;
    if (s.lastUsedAt) {
      return s.lastUsedAt >= cutoff;
    }
    return s.createdAt >= cutoff;
  });
}

/**
 * Checks if a task is overdue:
 * Overdue = dueDate < now AND status not in (COMPLETED, CANCELLED).
 */
export function computeIsOverdue(
  task: {
    dueDate?: Date | null;
    status: string;
  },
  now = new Date(),
): boolean {
  if (!task.dueDate) return false;
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') return false;
  return task.dueDate < now;
}

/**
 * Calculates completion percentage rate excluding CANCELLED tasks:
 * completion rate % = (completed / (total - cancelled)) * 100
 */
export function calculateCompletionRate(completed: number, eligible: number): number {
  if (eligible <= 0) return 0;
  return Number(((completed / eligible) * 100).toFixed(2));
}

/**
 * Calculates conversion rate percentage:
 * (converted / total) * 100
 */
export function calculateConversionRate(converted: number, total: number): number {
  if (total <= 0) return 0;
  return Number(((converted / total) * 100).toFixed(2));
}

import { InfraError } from '../core/infraError.ts';
import { infraProviderDescriptor } from '../core/providers.ts';
import { defaultWorkloadLifecyclePolicy } from './lifecyclePolicy.ts';
import type {
  WorkingHoursSchedule,
  WorkloadLifecycleDecision,
  WorkloadLifecyclePolicy,
  WorkloadLifecycleSnapshot,
} from './lifecycleTypes.ts';

const TRANSITIONAL_POLL_MS = 15_000;
const ACTIVE_WORK_POLL_MS = 30_000;
const ARCHIVE_FLUSH_POLL_MS = 10_000;
const SUSPENDED_POLL_MS = 300_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const assertFiniteNumber = (value: number, name: string): void => {
  if (!Number.isFinite(value)) {
    throw new InfraError('invalid_request', `${name} must be a finite number (got ${value})`);
  }
};

const assertNonNegativeFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new InfraError('invalid_request', `${name} must be a finite number >= 0 (got ${value})`);
  }
};

const assertNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new InfraError('invalid_request', `${name} must be an integer >= 0 (got ${value})`);
  }
};

const assertPositiveOptional = (value: number | null | undefined, name: string): void => {
  if (value === null || value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new InfraError('invalid_request', `${name} must be a finite number > 0 (got ${value})`);
  }
};

const validateWorkingHoursSchedule = (schedule: WorkingHoursSchedule): void => {
  assertFiniteNumber(schedule.timezoneOffsetMinutes, 'workingHoursPrewarm.timezoneOffsetMinutes');
  if (!Number.isFinite(schedule.startHour) || schedule.startHour < 0 || schedule.startHour >= 24) {
    throw new InfraError(
      'invalid_request',
      `workingHoursPrewarm.startHour must be in [0, 24) (got ${schedule.startHour})`,
    );
  }
  if (!Number.isFinite(schedule.endHour) || schedule.endHour < 0 || schedule.endHour > 24) {
    throw new InfraError(
      'invalid_request',
      `workingHoursPrewarm.endHour must be in [0, 24] (got ${schedule.endHour})`,
    );
  }
  assertNonNegativeFinite(schedule.prewarmLeadMs, 'workingHoursPrewarm.prewarmLeadMs');
};

const validateSnapshotAndPolicy = (
  snapshot: WorkloadLifecycleSnapshot,
  nowMs: number,
  policy: WorkloadLifecyclePolicy,
): void => {
  assertFiniteNumber(nowMs, 'nowMs');
  assertFiniteNumber(snapshot.createdAtMs, 'snapshot.createdAtMs');
  assertFiniteNumber(snapshot.lastActivityAtMs, 'snapshot.lastActivityAtMs');
  assertFiniteNumber(snapshot.stateEnteredAtMs, 'snapshot.stateEnteredAtMs');
  assertNonNegativeInteger(snapshot.inFlightTurns, 'snapshot.inFlightTurns');
  assertNonNegativeInteger(snapshot.activeBackgroundShells, 'snapshot.activeBackgroundShells');
  if (snapshot.pendingApprovals !== undefined) {
    assertNonNegativeInteger(snapshot.pendingApprovals, 'snapshot.pendingApprovals');
  }
  assertPositiveOptional(snapshot.provisionedMemoryMb, 'snapshot.provisionedMemoryMb');
  assertPositiveOptional(snapshot.rssMemoryMb, 'snapshot.rssMemoryMb');

  if (policy.idleSuspendMs !== null) {
    assertNonNegativeFinite(policy.idleSuspendMs, 'policy.idleSuspendMs');
  }
  if (policy.idleStopMs !== null) {
    assertNonNegativeFinite(policy.idleStopMs, 'policy.idleStopMs');
  }
  assertNonNegativeFinite(policy.drainGraceMs, 'policy.drainGraceMs');
  assertNonNegativeFinite(policy.pendingApprovalGraceMs, 'policy.pendingApprovalGraceMs');
  if (policy.maxLifetimeMs !== null) {
    assertPositiveOptional(policy.maxLifetimeMs, 'policy.maxLifetimeMs');
  }
  if (policy.maxSuspendedMs !== null) {
    assertPositiveOptional(policy.maxSuspendedMs, 'policy.maxSuspendedMs');
  }
  assertPositiveOptional(policy.softMemoryRecycleMb, 'policy.softMemoryRecycleMb');
  assertPositiveOptional(policy.hardMemoryCapMb, 'policy.hardMemoryCapMb');
  if (policy.workingHoursPrewarm) {
    validateWorkingHoursSchedule(policy.workingHoursPrewarm);
  }
};

type WorkingWindowBounds = {
  readonly prewarmStartMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
};

const workingWindowForDayDelta = (
  nowMs: number,
  schedule: WorkingHoursSchedule,
  dayDelta: number,
): WorkingWindowBounds | null => {
  const offsetMs = schedule.timezoneOffsetMinutes * 60_000;
  const shifted = new Date(nowMs + offsetMs + dayDelta * DAY_MS);
  const dayOfWeek = shifted.getUTCDay();
  if (schedule.weekdaysOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return null;
  }
  const localMidnightUtcMs =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs;
  const windowStartMs = localMidnightUtcMs + schedule.startHour * HOUR_MS;
  const isOvernight = schedule.endHour <= schedule.startHour;
  const windowEndMs = localMidnightUtcMs + schedule.endHour * HOUR_MS + (isOvernight ? DAY_MS : 0);
  const prewarmStartMs = windowStartMs - schedule.prewarmLeadMs;
  return { prewarmStartMs, windowStartMs, windowEndMs };
};

const activeWorkingWindowAt = (
  nowMs: number,
  schedule: WorkingHoursSchedule,
): WorkingWindowBounds | null => {
  for (const dayDelta of [-1, 0, 1]) {
    const bounds = workingWindowForDayDelta(nowMs, schedule, dayDelta);
    if (!bounds) continue;
    if (nowMs >= bounds.prewarmStartMs && nowMs < bounds.windowEndMs) {
      return bounds;
    }
  }
  return null;
};

const nextWorkingHoursPrewarmAtMs = (
  nowMs: number,
  schedule: WorkingHoursSchedule,
): number | null => {
  let next: number | null = null;
  for (let dayDelta = 0; dayDelta <= 8; dayDelta += 1) {
    const bounds = workingWindowForDayDelta(nowMs, schedule, dayDelta);
    if (!bounds) continue;
    if (bounds.prewarmStartMs > nowMs) {
      next = next === null ? bounds.prewarmStartMs : Math.min(next, bounds.prewarmStartMs);
    }
  }
  return next;
};

const earliestCheckTime = (...candidates: Array<number | null | undefined>): number | null => {
  let earliest: number | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    earliest = earliest === null ? candidate : Math.min(earliest, candidate);
  }
  return earliest;
};

export const evaluateWorkloadLifecycle = (
  snapshot: WorkloadLifecycleSnapshot,
  nowMs: number,
  policy: WorkloadLifecyclePolicy = defaultWorkloadLifecyclePolicy(snapshot.workloadClass, {
    warmRetentionMode: snapshot.warmRetentionMode,
  }),
): WorkloadLifecycleDecision => {
  validateSnapshotAndPolicy(snapshot, nowMs, policy);

  const descriptor = infraProviderDescriptor(snapshot.provider);
  const hasActiveWork = snapshot.inFlightTurns > 0 || snapshot.activeBackgroundShells > 0;
  const hasPendingApprovals = (snapshot.pendingApprovals ?? 0) > 0;
  const ageMs = Math.max(0, nowMs - snapshot.createdAtMs);
  const maxLifetimeReached = policy.maxLifetimeMs !== null && ageMs >= policy.maxLifetimeMs;
  const lifetimeDeadlineMs =
    policy.maxLifetimeMs !== null ? snapshot.createdAtMs + policy.maxLifetimeMs : null;

  if (snapshot.state === 'destroyed') {
    return { action: 'none', reason: 'workload_already_destroyed', nextCheckAtMs: null };
  }

  if (snapshot.state === 'failed' || snapshot.state === 'orphaned') {
    return {
      action: 'terminate',
      reason: `reap_${snapshot.state}_workload`,
      nextCheckAtMs: null,
    };
  }

  if (
    snapshot.state === 'provisioning' ||
    snapshot.state === 'booting' ||
    snapshot.state === 'suspending' ||
    snapshot.state === 'terminating'
  ) {
    return {
      action: 'none',
      reason: `workload_${snapshot.state}`,
      nextCheckAtMs: nowMs + TRANSITIONAL_POLL_MS,
    };
  }

  if (snapshot.state === 'suspended') {
    const suspendedElapsedMs = Math.max(0, nowMs - snapshot.stateEnteredAtMs);
    if (policy.maxSuspendedMs !== null && suspendedElapsedMs >= policy.maxSuspendedMs) {
      return {
        action: 'terminate',
        reason: 'suspended_retention_expired',
        nextCheckAtMs: null,
      };
    }

    if (policy.workingHoursPrewarm) {
      if (activeWorkingWindowAt(nowMs, policy.workingHoursPrewarm)) {
        return {
          action: 'prewarm',
          reason: 'working_hours_prewarm_window',
          nextCheckAtMs: null,
        };
      }
    }

    const expiryAtMs =
      policy.maxSuspendedMs !== null ? snapshot.stateEnteredAtMs + policy.maxSuspendedMs : null;
    const nextPrewarmAtMs = policy.workingHoursPrewarm
      ? nextWorkingHoursPrewarmAtMs(nowMs, policy.workingHoursPrewarm)
      : null;
    return {
      action: 'none',
      reason: 'suspended_within_retention',
      nextCheckAtMs: earliestCheckTime(expiryAtMs, nextPrewarmAtMs, nowMs + SUSPENDED_POLL_MS),
    };
  }

  if (snapshot.state === 'draining') {
    const drainElapsedMs = Math.max(0, nowMs - snapshot.stateEnteredAtMs);
    const drainDeadlineMs = snapshot.stateEnteredAtMs + policy.drainGraceMs;

    if (hasActiveWork) {
      if (!maxLifetimeReached) {
        return {
          action: 'none',
          reason: 'active_work_blocks_idle_drain',
          nextCheckAtMs: earliestCheckTime(lifetimeDeadlineMs, nowMs + ACTIVE_WORK_POLL_MS),
        };
      }
      if (drainElapsedMs < policy.drainGraceMs) {
        return {
          action: 'none',
          reason: 'waiting_for_in_flight_work_to_drain',
          nextCheckAtMs: drainDeadlineMs,
        };
      }
      return {
        action: 'terminate',
        reason: 'max_lifetime_exceeded_with_active_work',
        nextCheckAtMs: null,
      };
    }

    if (policy.requireArchiveFlushBeforeWindDown && !snapshot.archiveFlushed) {
      if (!maxLifetimeReached || drainElapsedMs < policy.drainGraceMs) {
        return {
          action: 'none',
          reason: 'waiting_for_archive_flush',
          nextCheckAtMs: nowMs + ARCHIVE_FLUSH_POLL_MS,
        };
      }
      return {
        action: 'terminate',
        reason: 'max_lifetime_exceeded_without_archive_flush',
        nextCheckAtMs: null,
      };
    }

    if (maxLifetimeReached) {
      return {
        action: 'terminate',
        reason: 'max_lifetime_reached_after_drain',
        nextCheckAtMs: null,
      };
    }

    if (policy.idleAction === 'terminate') {
      return {
        action: 'terminate',
        reason: 'drain_complete_ready_to_terminate',
        nextCheckAtMs: null,
      };
    }

    const suspendMemoryMb = snapshot.provisionedMemoryMb ?? snapshot.rssMemoryMb;
    if (
      descriptor.supportsSuspend &&
      descriptor.suspendMaxMemoryMb !== undefined &&
      suspendMemoryMb !== undefined &&
      suspendMemoryMb > descriptor.suspendMaxMemoryMb
    ) {
      return policy.hardMemoryCapMb !== null
        ? {
            action: 'recycle',
            reason: 'memory_exceeds_provider_suspend_cap',
            nextCheckAtMs: null,
          }
        : {
            action: 'terminate',
            reason: 'cannot_suspend_above_provider_memory_cap',
            nextCheckAtMs: null,
          };
    }

    return {
      action: 'suspend',
      reason: descriptor.supportsSuspend
        ? 'drain_complete_ready_to_suspend'
        : 'drain_complete_ready_to_stop',
      nextCheckAtMs: null,
    };
  }

  // States: 'warm' | 'active'
  if (maxLifetimeReached) {
    if (hasActiveWork || (policy.requireArchiveFlushBeforeWindDown && !snapshot.archiveFlushed)) {
      return {
        action: 'drain',
        reason: 'max_lifetime_reached_draining',
        nextCheckAtMs: nowMs + policy.drainGraceMs,
      };
    }
    return {
      action: 'terminate',
      reason: 'max_lifetime_reached',
      nextCheckAtMs: null,
    };
  }

  if (
    policy.hardMemoryCapMb !== null &&
    snapshot.rssMemoryMb !== undefined &&
    snapshot.rssMemoryMb >
      (descriptor.suspendMaxMemoryMb !== undefined
        ? Math.min(policy.hardMemoryCapMb, descriptor.suspendMaxMemoryMb)
        : policy.hardMemoryCapMb)
  ) {
    return {
      action: 'recycle',
      reason: 'rss_exceeds_hard_cap',
      nextCheckAtMs: null,
    };
  }

  if (
    policy.softMemoryRecycleMb !== null &&
    snapshot.rssMemoryMb !== undefined &&
    snapshot.rssMemoryMb >= policy.softMemoryRecycleMb &&
    !hasActiveWork
  ) {
    return {
      action: 'recycle',
      reason: 'rss_exceeds_soft_recycle_threshold',
      nextCheckAtMs: null,
    };
  }

  if (snapshot.pinnedWarm || policy.idleAction === 'keep_warm') {
    return {
      action: 'none',
      reason: 'workload_pinned_warm',
      nextCheckAtMs: lifetimeDeadlineMs,
    };
  }

  if (policy.workingHoursPrewarm) {
    const activeWindow = activeWorkingWindowAt(nowMs, policy.workingHoursPrewarm);
    if (activeWindow) {
      return {
        action: 'none',
        reason: 'within_working_hours_window',
        nextCheckAtMs: earliestCheckTime(lifetimeDeadlineMs, activeWindow.windowEndMs),
      };
    }
  }

  if (hasActiveWork) {
    return {
      action: 'none',
      reason: 'active_work_in_progress',
      nextCheckAtMs: earliestCheckTime(lifetimeDeadlineMs, nowMs + ACTIVE_WORK_POLL_MS),
    };
  }

  const idleLimitMs = descriptor.supportsSuspend ? policy.idleSuspendMs : policy.idleStopMs;
  if (idleLimitMs === null) {
    return {
      action: 'none',
      reason: 'no_idle_timeout_configured',
      nextCheckAtMs: lifetimeDeadlineMs,
    };
  }

  const idleElapsedMs = Math.max(0, nowMs - snapshot.lastActivityAtMs);
  if (hasPendingApprovals && policy.pendingApprovalGraceMs > 0) {
    const approvalLimitMs = Math.max(idleLimitMs, policy.pendingApprovalGraceMs);
    if (idleElapsedMs < approvalLimitMs) {
      return {
        action: 'none',
        reason: 'waiting_for_pending_approval',
        nextCheckAtMs: earliestCheckTime(
          lifetimeDeadlineMs,
          snapshot.lastActivityAtMs + approvalLimitMs,
        ),
      };
    }
  }

  if (idleElapsedMs >= idleLimitMs) {
    return {
      action: 'drain',
      reason: 'idle_timeout_reached',
      nextCheckAtMs: nowMs + policy.drainGraceMs,
    };
  }

  return {
    action: 'none',
    reason: 'within_idle_window',
    nextCheckAtMs: earliestCheckTime(lifetimeDeadlineMs, snapshot.lastActivityAtMs + idleLimitMs),
  };
};

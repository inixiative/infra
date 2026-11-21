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
const DAY_MS = 24 * 60 * 60 * 1000;

const isWithinWorkingHoursPrewarm = (nowMs: number, schedule: WorkingHoursSchedule): boolean => {
  const offsetMs = schedule.timezoneOffsetMinutes * 60_000;
  for (const dayDelta of [0, 1]) {
    const shifted = new Date(nowMs + offsetMs + dayDelta * DAY_MS);
    const dayOfWeek = shifted.getUTCDay();
    if (schedule.weekdaysOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
      continue;
    }
    const localMidnightUtcMs =
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs;
    const prewarmStartMs =
      localMidnightUtcMs + schedule.startHour * 3_600_000 - schedule.prewarmLeadMs;
    const windowEndMs = localMidnightUtcMs + schedule.endHour * 3_600_000;
    if (nowMs >= prewarmStartMs && nowMs < windowEndMs) {
      return true;
    }
  }
  return false;
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
    chorusL2Mode: snapshot.chorusL2Mode,
  }),
): WorkloadLifecycleDecision => {
  const descriptor = infraProviderDescriptor(snapshot.provider);
  const hasActiveWork = snapshot.inFlightTurns > 0 || snapshot.activeBackgroundShells > 0;
  const maxLifetimeReached =
    policy.maxLifetimeMs !== null && nowMs - snapshot.createdAtMs >= policy.maxLifetimeMs;
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

    if (
      policy.workingHoursPrewarm &&
      isWithinWorkingHoursPrewarm(nowMs, policy.workingHoursPrewarm)
    ) {
      return {
        action: 'prewarm',
        reason: 'working_hours_prewarm_window',
        nextCheckAtMs: null,
      };
    }

    const expiryAtMs =
      policy.maxSuspendedMs !== null ? snapshot.stateEnteredAtMs + policy.maxSuspendedMs : null;
    return {
      action: 'none',
      reason: 'suspended_within_retention',
      nextCheckAtMs: earliestCheckTime(expiryAtMs, nowMs + SUSPENDED_POLL_MS),
    };
  }

  if (snapshot.state === 'draining') {
    const drainElapsedMs = Math.max(0, nowMs - snapshot.stateEnteredAtMs);
    const drainDeadlineMs = snapshot.stateEnteredAtMs + policy.drainGraceMs;

    if (hasActiveWork && drainElapsedMs < policy.drainGraceMs) {
      return {
        action: 'none',
        reason: 'waiting_for_in_flight_work_to_drain',
        nextCheckAtMs: drainDeadlineMs,
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

    if (
      descriptor.supportsSuspend &&
      descriptor.suspendMaxMemoryMb !== undefined &&
      snapshot.memoryMb !== undefined &&
      snapshot.memoryMb > descriptor.suspendMaxMemoryMb
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
    snapshot.memoryMb !== undefined &&
    snapshot.memoryMb >
      (descriptor.suspendMaxMemoryMb !== undefined
        ? Math.min(policy.hardMemoryCapMb, descriptor.suspendMaxMemoryMb)
        : policy.hardMemoryCapMb)
  ) {
    return {
      action: 'recycle',
      reason: 'memory_exceeds_hard_cap',
      nextCheckAtMs: null,
    };
  }

  if (
    policy.softMemoryRecycleMb !== null &&
    snapshot.memoryMb !== undefined &&
    snapshot.memoryMb >= policy.softMemoryRecycleMb &&
    !hasActiveWork
  ) {
    return {
      action: 'recycle',
      reason: 'memory_exceeds_soft_recycle_threshold',
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

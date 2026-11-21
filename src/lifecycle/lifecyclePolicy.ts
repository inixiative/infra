import type {
  WarmRetentionMode,
  WorkingHoursSchedule,
  WorkloadClass,
  WorkloadLifecyclePolicy,
} from './lifecycleTypes.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type WorkloadLifecyclePolicyOptions = {
  readonly warmRetentionMode?: WarmRetentionMode;
  readonly workingHoursPrewarm?: WorkingHoursSchedule;
};

export const defaultWorkloadLifecyclePolicy = (
  workloadClass: WorkloadClass,
  options: WorkloadLifecyclePolicyOptions = {},
): WorkloadLifecyclePolicy => {
  switch (workloadClass) {
    case 'warm-interactive':
      return {
        workloadClass,
        idleSuspendMs: 8 * MINUTE_MS,
        idleStopMs: 3 * HOUR_MS,
        drainGraceMs: 60_000,
        pendingApprovalGraceMs: 0,
        maxLifetimeMs: 24 * HOUR_MS,
        maxSuspendedMs: 14 * DAY_MS,
        softMemoryRecycleMb: 1536,
        hardMemoryCapMb: 2048,
        requireArchiveFlushBeforeWindDown: false,
        workingHoursPrewarm: options.workingHoursPrewarm,
        idleAction: 'suspend',
      };
    case 'warm-pool':
      return {
        workloadClass,
        idleSuspendMs: options.warmRetentionMode === 'extended' ? 60 * MINUTE_MS : 5 * MINUTE_MS,
        idleStopMs: 3 * HOUR_MS,
        drainGraceMs: 60_000,
        pendingApprovalGraceMs: 0,
        maxLifetimeMs: 24 * HOUR_MS,
        maxSuspendedMs: 7 * DAY_MS,
        softMemoryRecycleMb: 1536,
        hardMemoryCapMb: 2048,
        requireArchiveFlushBeforeWindDown: false,
        workingHoursPrewarm: options.workingHoursPrewarm,
        idleAction: 'suspend',
      };
    case 'batch-worker':
      return {
        workloadClass,
        idleSuspendMs: 5 * MINUTE_MS,
        idleStopMs: 5 * MINUTE_MS,
        drainGraceMs: 120_000,
        pendingApprovalGraceMs: 0,
        maxLifetimeMs: 4 * HOUR_MS,
        maxSuspendedMs: 24 * HOUR_MS,
        softMemoryRecycleMb: 1536,
        hardMemoryCapMb: 2048,
        requireArchiveFlushBeforeWindDown: false,
        idleAction: 'terminate',
      };
    case 'ephemeral-session':
      return {
        workloadClass,
        idleSuspendMs: 15 * MINUTE_MS,
        idleStopMs: 15 * MINUTE_MS,
        drainGraceMs: 60_000,
        pendingApprovalGraceMs: 30 * MINUTE_MS,
        maxLifetimeMs: 24 * HOUR_MS,
        maxSuspendedMs: 7 * DAY_MS,
        softMemoryRecycleMb: null,
        hardMemoryCapMb: null,
        requireArchiveFlushBeforeWindDown: true,
        idleAction: 'suspend',
      };
    case 'always-on':
      return {
        workloadClass,
        idleSuspendMs: null,
        idleStopMs: null,
        drainGraceMs: 60_000,
        pendingApprovalGraceMs: 0,
        maxLifetimeMs: null,
        maxSuspendedMs: null,
        softMemoryRecycleMb: null,
        hardMemoryCapMb: null,
        requireArchiveFlushBeforeWindDown: false,
        idleAction: 'keep_warm',
      };
  }
};

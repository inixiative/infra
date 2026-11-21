import type {
  WorkingHoursSchedule,
  WorkloadClass,
  WorkloadLifecyclePolicy,
} from './lifecycleTypes.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type WorkloadLifecyclePolicyOptions = {
  readonly chorusL2Mode?: 'subset' | 'full_warm';
  readonly workingHoursPrewarm?: WorkingHoursSchedule;
};

export const defaultWorkloadLifecyclePolicy = (
  workloadClass: WorkloadClass,
  options: WorkloadLifecyclePolicyOptions = {},
): WorkloadLifecyclePolicy => {
  switch (workloadClass) {
    case 'chorus-l1':
      return {
        workloadClass,
        idleSuspendMs: 10 * MINUTE_MS,
        idleStopMs: 3 * HOUR_MS,
        drainGraceMs: 60_000,
        maxLifetimeMs: null,
        maxSuspendedMs: 14 * DAY_MS,
        softMemoryRecycleMb: 1536,
        hardMemoryCapMb: 2048,
        requireArchiveFlushBeforeWindDown: false,
        workingHoursPrewarm: options.workingHoursPrewarm,
        idleAction: 'suspend',
      };
    case 'chorus-l2':
      return {
        workloadClass,
        idleSuspendMs: options.chorusL2Mode === 'full_warm' ? 60 * MINUTE_MS : 10 * MINUTE_MS,
        idleStopMs: 3 * HOUR_MS,
        drainGraceMs: 60_000,
        maxLifetimeMs: null,
        maxSuspendedMs: 14 * DAY_MS,
        softMemoryRecycleMb: 1536,
        hardMemoryCapMb: 2048,
        requireArchiveFlushBeforeWindDown: false,
        workingHoursPrewarm: options.workingHoursPrewarm,
        idleAction: 'suspend',
      };
    case 'oracle-worker':
      return {
        workloadClass,
        idleSuspendMs: 5 * MINUTE_MS,
        idleStopMs: 5 * MINUTE_MS,
        drainGraceMs: 120_000,
        maxLifetimeMs: 4 * HOUR_MS,
        maxSuspendedMs: 24 * HOUR_MS,
        softMemoryRecycleMb: 1536,
        hardMemoryCapMb: 2048,
        requireArchiveFlushBeforeWindDown: false,
        idleAction: 'terminate',
      };
    case 'adhoc-foundry':
      return {
        workloadClass,
        idleSuspendMs: 15 * MINUTE_MS,
        idleStopMs: 15 * MINUTE_MS,
        drainGraceMs: 60_000,
        maxLifetimeMs: 24 * HOUR_MS,
        maxSuspendedMs: 7 * DAY_MS,
        softMemoryRecycleMb: null,
        hardMemoryCapMb: null,
        requireArchiveFlushBeforeWindDown: true,
        idleAction: 'suspend',
      };
    case 'archive':
      return {
        workloadClass,
        idleSuspendMs: null,
        idleStopMs: null,
        drainGraceMs: 60_000,
        maxLifetimeMs: null,
        maxSuspendedMs: null,
        softMemoryRecycleMb: null,
        hardMemoryCapMb: null,
        requireArchiveFlushBeforeWindDown: false,
        idleAction: 'keep_warm',
      };
  }
};

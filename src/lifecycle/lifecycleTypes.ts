import type { InfraProviderId } from '../core/providers.ts';

export const WORKLOAD_LIFECYCLE_STATES = [
  'provisioning',
  'booting',
  'warm',
  'active',
  'draining',
  'suspending',
  'suspended',
  'terminating',
  'destroyed',
  'failed',
  'orphaned',
] as const;

export type WorkloadLifecycleState = (typeof WORKLOAD_LIFECYCLE_STATES)[number];

export const WORKLOAD_CLASSES = [
  'chorus-l1',
  'chorus-l2',
  'oracle-worker',
  'adhoc-foundry',
  'archive',
] as const;

export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export type WorkingHoursSchedule = {
  readonly timezoneOffsetMinutes: number;
  readonly startHour: number;
  readonly endHour: number;
  readonly weekdaysOnly: boolean;
  readonly prewarmLeadMs: number;
};

export type WorkloadIdleAction = 'suspend' | 'terminate' | 'keep_warm';

export type WorkloadLifecyclePolicy = {
  readonly workloadClass: WorkloadClass;
  readonly idleSuspendMs: number | null;
  readonly idleStopMs: number | null;
  readonly drainGraceMs: number;
  readonly maxLifetimeMs: number | null;
  readonly maxSuspendedMs: number | null;
  readonly softMemoryRecycleMb: number | null;
  readonly hardMemoryCapMb: number | null;
  readonly requireArchiveFlushBeforeWindDown: boolean;
  readonly workingHoursPrewarm?: WorkingHoursSchedule;
  readonly idleAction: WorkloadIdleAction;
};

export type WorkloadLifecycleSnapshot = {
  readonly workloadId: string;
  readonly workloadClass: WorkloadClass;
  readonly provider: InfraProviderId;
  readonly state: WorkloadLifecycleState;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  readonly stateEnteredAtMs: number;
  readonly inFlightTurns: number;
  readonly activeBackgroundShells: number;
  readonly archiveFlushed: boolean;
  readonly memoryMb?: number;
  readonly pinnedWarm?: boolean;
  readonly chorusL2Mode?: 'subset' | 'full_warm';
};

export type WorkloadLifecycleAction =
  | 'none'
  | 'prewarm'
  | 'drain'
  | 'suspend'
  | 'terminate'
  | 'recycle';

export type WorkloadLifecycleDecision = {
  readonly action: WorkloadLifecycleAction;
  readonly reason: string;
  readonly nextCheckAtMs: number | null;
};

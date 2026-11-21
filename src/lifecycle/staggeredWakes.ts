import { InfraError } from '../core/infraError.ts';

export type StaggeredWakeRequest = {
  readonly workloadId: string;
  readonly priority?: number;
  readonly requestedAtMs: number;
};

export type StaggeredWakeOptions = {
  readonly maxConcurrentWakes: number;
  readonly minSpacingMs: number;
  readonly inFlightWakeCount?: number;
  readonly lastWakeLaunchedAtMs?: number | null;
};

export type DeferredWakeReason = 'concurrency_limit' | 'spacing_interval';

export type DeferredWake = {
  readonly request: StaggeredWakeRequest;
  readonly earliestLaunchAtMs: number;
  readonly reason: DeferredWakeReason;
};

export type StaggeredWakePlan = {
  readonly launchNow: readonly StaggeredWakeRequest[];
  readonly defer: readonly DeferredWake[];
};

export const planStaggeredWakes = (
  requests: readonly StaggeredWakeRequest[],
  nowMs: number,
  options: StaggeredWakeOptions,
): StaggeredWakePlan => {
  if (!Number.isInteger(options.maxConcurrentWakes) || options.maxConcurrentWakes < 1) {
    throw new InfraError(
      'invalid_request',
      `maxConcurrentWakes must be an integer >= 1 (got ${options.maxConcurrentWakes})`,
    );
  }
  if (!Number.isFinite(options.minSpacingMs) || options.minSpacingMs < 0) {
    throw new InfraError(
      'invalid_request',
      `minSpacingMs must be a finite number >= 0 (got ${options.minSpacingMs})`,
    );
  }

  const sorted = [...requests].sort((left, right) => {
    const priorityDiff = (right.priority ?? 0) - (left.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    const requestedDiff = left.requestedAtMs - right.requestedAtMs;
    if (requestedDiff !== 0) return requestedDiff;
    return left.workloadId.localeCompare(right.workloadId);
  });

  const inFlight = Math.max(0, options.inFlightWakeCount ?? 0);
  const availableSlots = Math.max(0, options.maxConcurrentWakes - inFlight);
  const launchNow: StaggeredWakeRequest[] = [];
  const defer: DeferredWake[] = [];

  let nextEligibleAtMs =
    options.lastWakeLaunchedAtMs !== null && options.lastWakeLaunchedAtMs !== undefined
      ? Math.max(nowMs, options.lastWakeLaunchedAtMs + options.minSpacingMs)
      : nowMs;
  let scheduledWithinConcurrency = 0;

  for (const request of sorted) {
    if (scheduledWithinConcurrency >= availableSlots) {
      defer.push({
        request,
        earliestLaunchAtMs: Math.max(nextEligibleAtMs, nowMs + options.minSpacingMs),
        reason: 'concurrency_limit',
      });
      nextEligibleAtMs = Math.max(nextEligibleAtMs, nowMs) + options.minSpacingMs;
      continue;
    }

    if (nextEligibleAtMs > nowMs) {
      defer.push({
        request,
        earliestLaunchAtMs: nextEligibleAtMs,
        reason: 'spacing_interval',
      });
      scheduledWithinConcurrency += 1;
      nextEligibleAtMs += options.minSpacingMs;
      continue;
    }

    launchNow.push(request);
    scheduledWithinConcurrency += 1;
    if (options.minSpacingMs > 0) {
      nextEligibleAtMs = nowMs + options.minSpacingMs;
    }
  }

  return { launchNow, defer };
};

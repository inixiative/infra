import { InfraError } from '../core/infraError.ts';

const DEFAULT_CONCURRENCY_RETRY_FLOOR_MS = 1_000;

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

const compareWakeRequests = (left: StaggeredWakeRequest, right: StaggeredWakeRequest): number => {
  const priorityDiff = (right.priority ?? 0) - (left.priority ?? 0);
  if (priorityDiff !== 0) return priorityDiff;
  const requestedDiff = left.requestedAtMs - right.requestedAtMs;
  if (requestedDiff !== 0) return requestedDiff;
  return left.workloadId < right.workloadId ? -1 : left.workloadId > right.workloadId ? 1 : 0;
};

const deduplicateRequests = (requests: readonly StaggeredWakeRequest[]): StaggeredWakeRequest[] => {
  const byWorkloadId = new Map<string, StaggeredWakeRequest>();
  for (const request of requests) {
    if (!request.workloadId) {
      throw new InfraError('invalid_request', 'StaggeredWakeRequest.workloadId must be non-empty');
    }
    if (!Number.isFinite(request.requestedAtMs)) {
      throw new InfraError(
        'invalid_request',
        `requestedAtMs must be finite (got ${request.requestedAtMs})`,
      );
    }
    if (request.priority !== undefined && !Number.isFinite(request.priority)) {
      throw new InfraError('invalid_request', `priority must be finite (got ${request.priority})`);
    }

    const existing = byWorkloadId.get(request.workloadId);
    if (!existing || compareWakeRequests(request, existing) < 0) {
      byWorkloadId.set(request.workloadId, request);
    }
  }
  return [...byWorkloadId.values()];
};

export const planStaggeredWakes = (
  requests: readonly StaggeredWakeRequest[],
  nowMs: number,
  options: StaggeredWakeOptions,
): StaggeredWakePlan => {
  if (!Number.isFinite(nowMs)) {
    throw new InfraError('invalid_request', `nowMs must be finite (got ${nowMs})`);
  }
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
  if (
    options.inFlightWakeCount !== undefined &&
    (!Number.isInteger(options.inFlightWakeCount) || options.inFlightWakeCount < 0)
  ) {
    throw new InfraError(
      'invalid_request',
      `inFlightWakeCount must be an integer >= 0 (got ${options.inFlightWakeCount})`,
    );
  }
  if (
    options.lastWakeLaunchedAtMs !== undefined &&
    options.lastWakeLaunchedAtMs !== null &&
    !Number.isFinite(options.lastWakeLaunchedAtMs)
  ) {
    throw new InfraError(
      'invalid_request',
      `lastWakeLaunchedAtMs must be finite or null (got ${options.lastWakeLaunchedAtMs})`,
    );
  }

  const sorted = deduplicateRequests(requests).sort(compareWakeRequests);
  const inFlight = options.inFlightWakeCount ?? 0;
  const availableSlots = Math.max(0, options.maxConcurrentWakes - inFlight);
  const launchNow: StaggeredWakeRequest[] = [];
  const defer: DeferredWake[] = [];

  const retryStepMs =
    options.minSpacingMs > 0 ? options.minSpacingMs : DEFAULT_CONCURRENCY_RETRY_FLOOR_MS;

  let nextEligibleAtMs =
    options.lastWakeLaunchedAtMs !== null && options.lastWakeLaunchedAtMs !== undefined
      ? Math.max(nowMs, options.lastWakeLaunchedAtMs + options.minSpacingMs)
      : nowMs;
  let scheduledWithinConcurrency = 0;

  for (const request of sorted) {
    if (scheduledWithinConcurrency >= availableSlots) {
      const earliestLaunchAtMs = Math.max(nextEligibleAtMs, nowMs + retryStepMs);
      defer.push({
        request,
        earliestLaunchAtMs,
        reason: 'concurrency_limit',
      });
      nextEligibleAtMs = earliestLaunchAtMs + retryStepMs;
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

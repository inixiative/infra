import { describe, expect, it } from 'bun:test';
import {
  defaultWorkloadLifecyclePolicy,
  evaluateWorkloadLifecycle,
  planStaggeredWakes,
  projectHostingMonthlyCost,
  type WorkloadLifecycleSnapshot,
} from '../src/index.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_TIME = Date.UTC(2026, 10, 23, 14, 0, 0); // Monday 14:00 UTC

const baseSnapshot = (
  overrides: Partial<WorkloadLifecycleSnapshot> = {},
): WorkloadLifecycleSnapshot => ({
  workloadId: 'wk-1',
  workloadClass: 'warm-interactive',
  provider: 'fly',
  state: 'warm',
  createdAtMs: BASE_TIME - 30 * MINUTE,
  lastActivityAtMs: BASE_TIME,
  stateEnteredAtMs: BASE_TIME - 30 * MINUTE,
  inFlightTurns: 0,
  activeBackgroundShells: 0,
  archiveFlushed: true,
  provisionedMemoryMb: 2048,
  rssMemoryMb: 1024,
  ...overrides,
});

describe('defaultWorkloadLifecyclePolicy and evaluateWorkloadLifecycle', () => {
  it('drains and suspends warm-interactive after 8 min on Fly, vs 3h stop on Railway', () => {
    const policy = defaultWorkloadLifecyclePolicy('warm-interactive');
    expect(policy.idleSuspendMs).toBe(8 * MINUTE);
    expect(policy.idleStopMs).toBe(3 * HOUR);
    expect(policy.maxLifetimeMs).toBe(24 * HOUR);

    const beforeIdle = evaluateWorkloadLifecycle(
      baseSnapshot({ lastActivityAtMs: BASE_TIME - 7 * MINUTE }),
      BASE_TIME,
    );
    expect(beforeIdle.action).toBe('none');
    expect(beforeIdle.nextCheckAtMs).toBe(BASE_TIME + 1 * MINUTE);

    const atIdle = evaluateWorkloadLifecycle(
      baseSnapshot({ lastActivityAtMs: BASE_TIME - 8 * MINUTE }),
      BASE_TIME,
    );
    expect(atIdle.action).toBe('drain');

    const railwayAt2h = evaluateWorkloadLifecycle(
      baseSnapshot({ provider: 'railway', lastActivityAtMs: BASE_TIME - 2 * HOUR }),
      BASE_TIME,
    );
    expect(railwayAt2h.action).toBe('none');

    const railwayAt3h = evaluateWorkloadLifecycle(
      baseSnapshot({ provider: 'railway', lastActivityAtMs: BASE_TIME - 3 * HOUR }),
      BASE_TIME,
    );
    expect(railwayAt3h.action).toBe('drain');
  });

  it('separates rssMemoryMb recycle checks from provisionedMemoryMb suspend-cap checks', () => {
    // High RSS >= 1536 MB with no active work -> soft recycle
    const soft = evaluateWorkloadLifecycle(baseSnapshot({ rssMemoryMb: 1600 }), BASE_TIME);
    expect(soft.action).toBe('recycle');
    expect(soft.reason).toBe('rss_exceeds_soft_recycle_threshold');

    // High RSS >= 1536 MB with active turn -> wait
    const softBusy = evaluateWorkloadLifecycle(
      baseSnapshot({ rssMemoryMb: 1600, inFlightTurns: 1 }),
      BASE_TIME,
    );
    expect(softBusy.action).toBe('none');

    // RSS > 2048 MB hard cap -> immediate recycle even if busy
    const hard = evaluateWorkloadLifecycle(
      baseSnapshot({ rssMemoryMb: 2100, inFlightTurns: 1 }),
      BASE_TIME,
    );
    expect(hard.action).toBe('recycle');
    expect(hard.reason).toBe('rss_exceeds_hard_cap');

    // Provisioned 4096 MB ephemeral-session on Fly stays running (RSS low), then terminates on drain
    const largeSession = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'ephemeral-session',
        provisionedMemoryMb: 4096,
        rssMemoryMb: 900,
      }),
      BASE_TIME,
    );
    expect(largeSession.action).toBe('none');

    const largeSessionDrained = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'ephemeral-session',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        provisionedMemoryMb: 4096,
        rssMemoryMb: 900,
        archiveFlushed: true,
      }),
      BASE_TIME,
    );
    expect(largeSessionDrained.action).toBe('terminate');
    expect(largeSessionDrained.reason).toBe('cannot_suspend_above_provider_memory_cap');
  });

  it('supports warm-pool short (5m) vs extended (60m) retention modes', () => {
    const shortDecision = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'warm-pool',
        warmRetentionMode: 'short',
        lastActivityAtMs: BASE_TIME - 6 * MINUTE,
      }),
      BASE_TIME,
    );
    expect(shortDecision.action).toBe('drain');

    const extendedDecision = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'warm-pool',
        warmRetentionMode: 'extended',
        lastActivityAtMs: BASE_TIME - 15 * MINUTE,
      }),
      BASE_TIME,
    );
    expect(extendedDecision.action).toBe('none');
  });

  it('never kills active work during an idle drain, only after maxLifetime + drainGrace, and respects pendingApprovals', () => {
    // Idle-triggered drain with active work STILL blocks past drainGraceMs (H2)
    const activeIdleDrain = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'batch-worker',
        state: 'draining',
        createdAtMs: BASE_TIME - 30 * MINUTE,
        stateEnteredAtMs: BASE_TIME - 10 * MINUTE,
        inFlightTurns: 1,
      }),
      BASE_TIME,
    );
    expect(activeIdleDrain.action).toBe('none');
    expect(activeIdleDrain.reason).toBe('active_work_blocks_idle_drain');

    // Max-lifetime drain waits during drainGraceMs, then forces terminate
    const maxLifeDraining = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'batch-worker',
        state: 'draining',
        createdAtMs: BASE_TIME - 4 * HOUR,
        stateEnteredAtMs: BASE_TIME - 90_000,
        inFlightTurns: 1,
      }),
      BASE_TIME,
    );
    expect(maxLifeDraining.action).toBe('none');

    const maxLifeExpired = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'batch-worker',
        state: 'draining',
        createdAtMs: BASE_TIME - 4 * HOUR,
        stateEnteredAtMs: BASE_TIME - 120_000,
        inFlightTurns: 1,
      }),
      BASE_TIME,
    );
    expect(maxLifeExpired.action).toBe('terminate');
    expect(maxLifeExpired.reason).toBe('max_lifetime_exceeded_with_active_work');

    // pendingApprovals extends ephemeral-session idle tolerance to 30m (H2)
    const waitingApproval = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'ephemeral-session',
        lastActivityAtMs: BASE_TIME - 20 * MINUTE,
        pendingApprovals: 1,
      }),
      BASE_TIME,
    );
    expect(waitingApproval.action).toBe('none');
    expect(waitingApproval.reason).toBe('waiting_for_pending_approval');

    // Pending approvals surfaced during drain are also respected inside pendingApprovalGraceMs
    const drainingWithApproval = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'ephemeral-session',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        lastActivityAtMs: BASE_TIME - 20 * MINUTE,
        pendingApprovals: 1,
        archiveFlushed: true,
      }),
      BASE_TIME,
    );
    expect(drainingWithApproval.action).toBe('none');
    expect(drainingWithApproval.reason).toBe('waiting_for_pending_approval');

    const expiredApproval = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'ephemeral-session',
        lastActivityAtMs: BASE_TIME - 31 * MINUTE,
        pendingApprovals: 1,
      }),
      BASE_TIME,
    );
    expect(expiredApproval.action).toBe('drain');

    // Archive flush gate still blocks ephemeral-session suspend until flushed
    const unflushed = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'ephemeral-session',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        archiveFlushed: false,
      }),
      BASE_TIME,
    );
    expect(unflushed.action).toBe('none');
    expect(unflushed.reason).toBe('waiting_for_archive_flush');
  });

  it('prevents working-hours prewarm oscillation, supports overnight windows, and schedules next prewarm check (H1/L3)', () => {
    const dayPolicy = defaultWorkloadLifecyclePolicy('warm-interactive', {
      workingHoursPrewarm: {
        timezoneOffsetMinutes: 0,
        startHour: 9,
        endHour: 18,
        weekdaysOnly: true,
        prewarmLeadMs: 10 * MINUTE,
      },
    });

    // Monday 08:52 UTC (in 10m lead) -> suspended prewarms, warm stays warm (no thrash!)
    const mondayLead = Date.UTC(2026, 10, 23, 8, 52, 0);
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({ state: 'suspended', stateEnteredAtMs: mondayLead - HOUR }),
        mondayLead,
        dayPolicy,
      ).action,
    ).toBe('prewarm');

    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({
          state: 'warm',
          createdAtMs: mondayLead - 2 * HOUR,
          lastActivityAtMs: mondayLead - 30 * MINUTE,
        }),
        mondayLead,
        dayPolicy,
      ),
    ).toMatchObject({
      action: 'none',
      reason: 'within_working_hours_window',
    });

    // Monday 08:48 UTC (2 min before prewarm start) -> nextCheckAtMs targets exact prewarmStartMs (08:50)
    const beforeLead = Date.UTC(2026, 10, 23, 8, 48, 0);
    const suspendedCheck = evaluateWorkloadLifecycle(
      baseSnapshot({ state: 'suspended', stateEnteredAtMs: beforeLead - HOUR }),
      beforeLead,
      dayPolicy,
    );
    expect(suspendedCheck.action).toBe('none');
    expect(suspendedCheck.nextCheckAtMs).toBe(Date.UTC(2026, 10, 23, 8, 50, 0));

    // Overnight window (22:00..06:00 UTC) active at 02:00 UTC next day!
    const nightPolicy = defaultWorkloadLifecyclePolicy('warm-interactive', {
      workingHoursPrewarm: {
        timezoneOffsetMinutes: 0,
        startHour: 22,
        endHour: 6,
        weekdaysOnly: false,
        prewarmLeadMs: 10 * MINUTE,
      },
    });
    const tuesday2am = Date.UTC(2026, 10, 24, 2, 0, 0);
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({ state: 'suspended', stateEnteredAtMs: tuesday2am - HOUR }),
        tuesday2am,
        nightPolicy,
      ).action,
    ).toBe('prewarm');
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({
          state: 'warm',
          createdAtMs: tuesday2am - 2 * HOUR,
          lastActivityAtMs: tuesday2am - 30 * MINUTE,
        }),
        tuesday2am,
        nightPolicy,
      ).reason,
    ).toBe('within_working_hours_window');

    // always-on never idles out
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({ workloadClass: 'always-on', lastActivityAtMs: BASE_TIME - 30 * DAY }),
        BASE_TIME,
      ).action,
    ).toBe('none');
  });

  it('rejects NaN/invalid inputs and clamps clock skew safely (H2)', () => {
    expect(() => evaluateWorkloadLifecycle(baseSnapshot(), Number.NaN)).toThrow();
    expect(() =>
      evaluateWorkloadLifecycle(baseSnapshot({ inFlightTurns: -1 }), BASE_TIME),
    ).toThrow();
    expect(() =>
      evaluateWorkloadLifecycle(baseSnapshot({ rssMemoryMb: Number.NaN }), BASE_TIME),
    ).toThrow();

    // Clock skew (nowMs < lastActivityAtMs) clamps elapsed to 0 cleanly
    const skewed = evaluateWorkloadLifecycle(
      baseSnapshot({ lastActivityAtMs: BASE_TIME + 5 * MINUTE }),
      BASE_TIME,
    );
    expect(skewed.action).toBe('none');
  });
});

describe('planStaggeredWakes', () => {
  it('deduplicates workloadIds, sorts deterministically, and advances timestamps monotonically when slots=0 (H8)', () => {
    const requests = [
      { workloadId: 'proj-b', priority: 1, requestedAtMs: 500 },
      { workloadId: 'proj-b', priority: 5, requestedAtMs: 1200 }, // higher-priority duplicate wins
      { workloadId: 'proj-a', priority: 10, requestedAtMs: 2000 },
      { workloadId: 'proj-c', priority: 1, requestedAtMs: 1000 },
    ];

    const plan = planStaggeredWakes(requests, 5_000, {
      maxConcurrentWakes: 2,
      minSpacingMs: 4_000,
    });
    expect(plan.launchNow.map((r) => r.workloadId)).toEqual(['proj-a']);
    expect(
      plan.defer.map((d) => ({
        id: d.request.workloadId,
        prio: d.request.priority,
        at: d.earliestLaunchAtMs,
        reason: d.reason,
      })),
    ).toEqual([
      { id: 'proj-b', prio: 5, at: 9_000, reason: 'spacing_interval' },
      { id: 'proj-c', prio: 1, at: 13_000, reason: 'concurrency_limit' },
    ]);

    // When availableSlots === 0, timestamps are strictly monotonic (no collisions)
    const saturated = planStaggeredWakes(
      [
        { workloadId: 'w1', requestedAtMs: 100 },
        { workloadId: 'w2', requestedAtMs: 200 },
        { workloadId: 'w3', requestedAtMs: 300 },
      ],
      10_000,
      { maxConcurrentWakes: 2, inFlightWakeCount: 2, minSpacingMs: 0 },
    );
    expect(saturated.launchNow).toHaveLength(0);
    expect(saturated.defer.map((d) => d.earliestLaunchAtMs)).toEqual([11_000, 12_000, 13_000]);

    // Rejects NaN / negative inputs
    expect(() =>
      planStaggeredWakes([], Number.NaN, { maxConcurrentWakes: 1, minSpacingMs: 0 }),
    ).toThrow();
    expect(() =>
      planStaggeredWakes([{ workloadId: 'w1', requestedAtMs: Number.NaN }], 1000, {
        maxConcurrentWakes: 1,
        minSpacingMs: 0,
      }),
    ).toThrow();
  });
});

describe('projectHostingMonthlyCost', () => {
  it('validates hours/utilization, shares Render tiers, and preserves exact rounded identities (M8/L4)', () => {
    const fly = projectHostingMonthlyCost({
      provider: 'fly',
      memoryMb: 2048,
      vcpus: 2,
      activeHoursPerMonth: 176,
      suspendedHoursPerMonth: 554,
      rootfsGb: 2,
      markupMultiplier: 1.35,
    });
    expect(fly.activeComputeUsd).toBeGreaterThan(3.1);
    expect(fly.activeComputeUsd).toBeLessThan(3.4);
    expect(Math.round((fly.activeComputeUsd + fly.suspendedStorageUsd) * 10_000) / 10_000).toBe(
      fly.rawMonthlyCostUsd,
    );
    expect(Math.round((fly.markedUpMonthlyCostUsd - fly.rawMonthlyCostUsd) * 10_000) / 10_000).toBe(
      fly.marginUsd,
    );

    const renderMax = projectHostingMonthlyCost({
      provider: 'render',
      memoryMb: 16_384,
      vcpus: 4,
      activeHoursPerMonth: 730,
      suspendedHoursPerMonth: 0,
      rootfsGb: 0,
    });
    expect(renderMax.rawMonthlyCostUsd).toBe(225);

    // Rejects active + suspended > 730
    expect(() =>
      projectHostingMonthlyCost({
        provider: 'fly',
        memoryMb: 1024,
        vcpus: 1,
        activeHoursPerMonth: 500,
        suspendedHoursPerMonth: 300,
        rootfsGb: 1,
      }),
    ).toThrow();

    // Rejects utilization outside [0, 1]
    expect(() =>
      projectHostingMonthlyCost({
        provider: 'railway',
        memoryMb: 1024,
        vcpus: 1,
        activeHoursPerMonth: 100,
        suspendedHoursPerMonth: 0,
        rootfsGb: 1,
        averageMemoryUtilization: 1.5,
      }),
    ).toThrow();
  });
});

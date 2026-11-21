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
  workloadClass: 'chorus-l1',
  provider: 'fly',
  state: 'warm',
  createdAtMs: BASE_TIME - 30 * MINUTE,
  lastActivityAtMs: BASE_TIME,
  stateEnteredAtMs: BASE_TIME - 30 * MINUTE,
  inFlightTurns: 0,
  activeBackgroundShells: 0,
  archiveFlushed: true,
  memoryMb: 1024,
  ...overrides,
});

describe('defaultWorkloadLifecyclePolicy and evaluateWorkloadLifecycle', () => {
  it('drains and suspends chorus-l1 after 10 min on Fly, vs 3h stop on Railway', () => {
    const flyPolicy = defaultWorkloadLifecyclePolicy('chorus-l1');
    expect(flyPolicy.idleSuspendMs).toBe(10 * MINUTE);
    expect(flyPolicy.idleStopMs).toBe(3 * HOUR);

    // 9 min idle on Fly -> stay warm
    const beforeIdle = evaluateWorkloadLifecycle(
      baseSnapshot({ lastActivityAtMs: BASE_TIME - 9 * MINUTE }),
      BASE_TIME,
    );
    expect(beforeIdle.action).toBe('none');
    expect(beforeIdle.nextCheckAtMs).toBe(BASE_TIME + 1 * MINUTE);

    // 10 min idle on Fly -> drain
    const atIdle = evaluateWorkloadLifecycle(
      baseSnapshot({ lastActivityAtMs: BASE_TIME - 10 * MINUTE }),
      BASE_TIME,
    );
    expect(atIdle.action).toBe('drain');

    // 2h idle on Railway -> still warm because Railway has no suspend (3h idleStopMs)
    const railwayAt2h = evaluateWorkloadLifecycle(
      baseSnapshot({ provider: 'railway', lastActivityAtMs: BASE_TIME - 2 * HOUR }),
      BASE_TIME,
    );
    expect(railwayAt2h.action).toBe('none');

    // 3h idle on Railway -> drain
    const railwayAt3h = evaluateWorkloadLifecycle(
      baseSnapshot({ provider: 'railway', lastActivityAtMs: BASE_TIME - 3 * HOUR }),
      BASE_TIME,
    );
    expect(railwayAt3h.action).toBe('drain');
  });

  it('triggers blue/green recycle above soft 1536 MB threshold and hard 2048 MB Fly suspend cap', () => {
    // At 1600 MB with no active turns -> soft recycle
    const soft = evaluateWorkloadLifecycle(baseSnapshot({ memoryMb: 1600 }), BASE_TIME);
    expect(soft.action).toBe('recycle');
    expect(soft.reason).toBe('memory_exceeds_soft_recycle_threshold');

    // At 1600 MB WITH active turn -> wait (do not interrupt mid-turn below hard cap)
    const softBusy = evaluateWorkloadLifecycle(
      baseSnapshot({ memoryMb: 1600, inFlightTurns: 1 }),
      BASE_TIME,
    );
    expect(softBusy.action).toBe('none');

    // Above 2048 MB Fly cap -> immediate recycle even if busy
    const hard = evaluateWorkloadLifecycle(
      baseSnapshot({ memoryMb: 2100, inFlightTurns: 1 }),
      BASE_TIME,
    );
    expect(hard.action).toBe('recycle');
    expect(hard.reason).toBe('memory_exceeds_hard_cap');
  });

  it('supports chorus-l2 subset (10m) vs full_warm (60m) policies', () => {
    const subsetDecision = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'chorus-l2',
        chorusL2Mode: 'subset',
        lastActivityAtMs: BASE_TIME - 15 * MINUTE,
      }),
      BASE_TIME,
    );
    expect(subsetDecision.action).toBe('drain');

    const fullWarmDecision = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'chorus-l2',
        chorusL2Mode: 'full_warm',
        lastActivityAtMs: BASE_TIME - 15 * MINUTE,
      }),
      BASE_TIME,
    );
    expect(fullWarmDecision.action).toBe('none');
  });

  it('enforces oracle-worker 5m idle terminate, 120s drain grace, and 4h hard lifetime', () => {
    const drainingBusy = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'oracle-worker',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        inFlightTurns: 1,
      }),
      BASE_TIME,
    );
    expect(drainingBusy.action).toBe('none');

    const drainingDone = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'oracle-worker',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 120_000,
        inFlightTurns: 0,
      }),
      BASE_TIME,
    );
    expect(drainingDone.action).toBe('terminate');

    const maxLife = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'oracle-worker',
        createdAtMs: BASE_TIME - 4 * HOUR,
      }),
      BASE_TIME,
    );
    expect(maxLife.action).toBe('terminate');
  });

  it('protects adhoc-foundry active turns/shells, gates wind-down on archiveFlushed, and reaps forgotten boxes', () => {
    // Active background shell blocks idle drain even after 15m
    const withShell = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        lastActivityAtMs: BASE_TIME - 20 * MINUTE,
        activeBackgroundShells: 1,
      }),
      BASE_TIME,
    );
    expect(withShell.action).toBe('none');

    // Draining with archiveFlushed=false MUST wait
    const unflushed = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        archiveFlushed: false,
      }),
      BASE_TIME,
    );
    expect(unflushed.action).toBe('none');
    expect(unflushed.reason).toBe('waiting_for_archive_flush');

    // Once archiveFlushed=true -> suspends cleanly
    const flushed = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        archiveFlushed: true,
      }),
      BASE_TIME,
    );
    expect(flushed.action).toBe('suspend');

    // Hard 24h max lifetime forces drain/terminate
    const past24h = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        createdAtMs: BASE_TIME - 24 * HOUR,
        archiveFlushed: true,
      }),
      BASE_TIME,
    );
    expect(past24h.action).toBe('terminate');

    // Large 4 GB adhoc-foundry box on Fly stays active without infinite recycle, then terminates after drain
    const largeAdhocRunning = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        provider: 'fly',
        memoryMb: 4096,
      }),
      BASE_TIME,
    );
    expect(largeAdhocRunning.action).toBe('none');

    const largeAdhocDrained = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        provider: 'fly',
        state: 'draining',
        stateEnteredAtMs: BASE_TIME - 90_000,
        memoryMb: 4096,
        archiveFlushed: true,
      }),
      BASE_TIME,
    );
    expect(largeAdhocDrained.action).toBe('terminate');
    expect(largeAdhocDrained.reason).toBe('cannot_suspend_above_provider_memory_cap');

    // Suspended > 7d gets reaped
    const suspendedTooLong = evaluateWorkloadLifecycle(
      baseSnapshot({
        workloadClass: 'adhoc-foundry',
        state: 'suspended',
        stateEnteredAtMs: BASE_TIME - 7 * DAY,
      }),
      BASE_TIME,
    );
    expect(suspendedTooLong.action).toBe('terminate');
    expect(suspendedTooLong.reason).toBe('suspended_retention_expired');
  });

  it('prewarms suspended chorus during working hours and keeps archive warm', () => {
    const policy = defaultWorkloadLifecyclePolicy('chorus-l1', {
      workingHoursPrewarm: {
        timezoneOffsetMinutes: 0,
        startHour: 9,
        endHour: 18,
        weekdaysOnly: true,
        prewarmLeadMs: 10 * MINUTE,
      },
    });

    // Monday 08:52 UTC (within 10m lead before 09:00) -> prewarm
    const mondayPrewarm = Date.UTC(2026, 10, 23, 8, 52, 0);
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({ state: 'suspended', stateEnteredAtMs: mondayPrewarm - HOUR }),
        mondayPrewarm,
        policy,
      ).action,
    ).toBe('prewarm');

    // Saturday 10:00 UTC (weekend) -> stays suspended
    const saturday = Date.UTC(2026, 10, 21, 10, 0, 0);
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({ state: 'suspended', stateEnteredAtMs: saturday - HOUR }),
        saturday,
        policy,
      ).action,
    ).toBe('none');

    // Archive never idles out
    expect(
      evaluateWorkloadLifecycle(
        baseSnapshot({ workloadClass: 'archive', lastActivityAtMs: BASE_TIME - 30 * DAY }),
        BASE_TIME,
      ).action,
    ).toBe('none');

    // Orphaned / failed workloads are reaped
    expect(evaluateWorkloadLifecycle(baseSnapshot({ state: 'orphaned' }), BASE_TIME).action).toBe(
      'terminate',
    );
    expect(evaluateWorkloadLifecycle(baseSnapshot({ state: 'destroyed' }), BASE_TIME).action).toBe(
      'none',
    );
  });
});

describe('planStaggeredWakes', () => {
  it('spaces wakes by minSpacingMs and caps concurrency to prevent thundering herds', () => {
    const requests = [
      { workloadId: 'proj-c', priority: 1, requestedAtMs: 1000 },
      { workloadId: 'proj-a', priority: 10, requestedAtMs: 2000 },
      { workloadId: 'proj-b', priority: 1, requestedAtMs: 500 },
      { workloadId: 'proj-d', priority: 1, requestedAtMs: 1500 },
    ];

    const plan = planStaggeredWakes(requests, 5_000, {
      maxConcurrentWakes: 3,
      minSpacingMs: 4_000,
    });

    // Highest priority wakes now; remaining are staggered by 4s
    expect(plan.launchNow.map((req) => req.workloadId)).toEqual(['proj-a']);
    expect(plan.defer.map((item) => item.request.workloadId)).toEqual([
      'proj-b',
      'proj-c',
      'proj-d',
    ]);
    expect(plan.defer[0]).toMatchObject({
      earliestLaunchAtMs: 9_000,
      reason: 'spacing_interval',
    });
    expect(plan.defer[1]).toMatchObject({
      earliestLaunchAtMs: 13_000,
      reason: 'spacing_interval',
    });
    expect(plan.defer[2]).toMatchObject({
      earliestLaunchAtMs: 17_000,
      reason: 'concurrency_limit',
    });

    // With minSpacingMs=0, up to maxConcurrentWakes launch immediately
    const burst = planStaggeredWakes(requests, 5_000, {
      maxConcurrentWakes: 2,
      minSpacingMs: 0,
    });
    expect(burst.launchNow.map((req) => req.workloadId)).toEqual(['proj-a', 'proj-b']);
    expect(burst.defer.every((item) => item.reason === 'concurrency_limit')).toBe(true);

    // Respects recent launch cooldown
    const cooling = planStaggeredWakes(requests.slice(0, 1), 5_000, {
      maxConcurrentWakes: 2,
      minSpacingMs: 4_000,
      lastWakeLaunchedAtMs: 3_000,
    });
    expect(cooling.launchNow).toHaveLength(0);
    expect(cooling.defer[0]?.earliestLaunchAtMs).toBe(7_000);
  });
});

describe('projectHostingMonthlyCost', () => {
  it('projects realistic Fly and Railway COGS matching 2026-11-18 benchmarks plus markup', () => {
    const fly = projectHostingMonthlyCost({
      provider: 'fly',
      memoryMb: 2048,
      vcpus: 2,
      activeHoursPerMonth: 176,
      suspendedHoursPerMonth: 554,
      rootfsGb: 2,
      markupMultiplier: 1.35,
    });
    // 176h of shared-cpu-2x 2GB (~$3.23) + ~554h rootfs (~$0.23)
    expect(fly.activeComputeUsd).toBeGreaterThan(3.1);
    expect(fly.activeComputeUsd).toBeLessThan(3.4);
    expect(fly.suspendedStorageUsd).toBeGreaterThan(0.2);
    expect(fly.markedUpMonthlyCostUsd).toBeCloseTo(fly.rawMonthlyCostUsd * 1.35, 3);
    expect(fly.marginUsd).toBeCloseTo(fly.markedUpMonthlyCostUsd - fly.rawMonthlyCostUsd, 3);

    const railway = projectHostingMonthlyCost({
      provider: 'railway',
      memoryMb: 2048,
      vcpus: 1,
      activeHoursPerMonth: 176,
      suspendedHoursPerMonth: 0,
      rootfsGb: 0,
      averageMemoryUtilization: 0.65,
      averageCpuUtilization: 0.1,
    });
    expect(railway.rawMonthlyCostUsd).toBeGreaterThan(3.4);
    expect(railway.rawMonthlyCostUsd).toBeLessThan(3.9);

    const firecracker = projectHostingMonthlyCost({
      provider: 'firecracker',
      memoryMb: 2048,
      vcpus: 2,
      activeHoursPerMonth: 176,
      suspendedHoursPerMonth: 554,
      rootfsGb: 2,
    });
    expect(firecracker.rawMonthlyCostUsd).toBeGreaterThan(3);

    expect(() =>
      projectHostingMonthlyCost({
        provider: 'fly',
        memoryMb: 1024,
        vcpus: 1,
        activeHoursPerMonth: 10,
        suspendedHoursPerMonth: 0,
        rootfsGb: 1,
        markupMultiplier: 0.5,
      }),
    ).toThrow();
  });
});

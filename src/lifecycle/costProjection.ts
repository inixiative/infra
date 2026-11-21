import type { WorkloadCpuKind } from '../core/contracts.ts';
import { InfraError } from '../core/infraError.ts';
import type { InfraProviderId } from '../core/providers.ts';

const HOURS_PER_MONTH = 730;
const DEFAULT_RAILWAY_MEMORY_UTILIZATION = 0.65;
const DEFAULT_RAILWAY_CPU_UTILIZATION = 0.1;

export type HostingCostProjectionInput = {
  readonly provider: InfraProviderId;
  readonly memoryMb: number;
  readonly vcpus: number;
  readonly activeHoursPerMonth: number;
  readonly suspendedHoursPerMonth: number;
  readonly rootfsGb: number;
  readonly markupMultiplier?: number;
  readonly averageMemoryUtilization?: number;
  readonly averageCpuUtilization?: number;
  readonly cpuKind?: WorkloadCpuKind;
};

export type HostingCostProjection = {
  readonly provider: InfraProviderId;
  readonly activeComputeUsd: number;
  readonly suspendedStorageUsd: number;
  readonly rawMonthlyCostUsd: number;
  readonly markupMultiplier: number;
  readonly markedUpMonthlyCostUsd: number;
  readonly marginUsd: number;
  readonly pricingBasis: string;
};

export const HOSTING_PRICING_RATES = {
  railway: {
    memoryUsdPerGbHour: 0.0139,
    vcpuUsdPerHour: 0.0278,
    storageUsdPerGbMonth: 0.15,
  },
  fly: {
    sharedVcpuUsdPerMonth: 0.7,
    performanceVcpuUsdPerMonth: 21.0,
    memoryUsdPerGbMonth: 6.0,
    suspendedRootfsUsdPerGbMonth: 0.15,
  },
  render: {
    starterMonthUsd: 7,
    standardMonthUsd: 25,
    proMonthUsd: 85,
    proPlusMonthUsd: 175,
    diskUsdPerGbMonth: 0.25,
  },
  firecracker: {
    amortizedMemoryUsdPerGbMonth: 3.5,
    amortizedVcpuUsdPerMonth: 4.0,
    snapshotStorageUsdPerGbMonth: 0.05,
  },
  aws: {
    fargateArmVcpuUsdPerHour: 0.0324,
    fargateArmMemoryUsdPerGbHour: 0.0036,
    storageUsdPerGbMonth: 0.08,
  },
  gcp: {
    vcpuUsdPerHour: 0.0432,
    memoryUsdPerGbHour: 0.0048,
    storageUsdPerGbMonth: 0.1,
  },
  azure: {
    vcpuUsdPerHour: 0.0432,
    memoryUsdPerGbHour: 0.0048,
    storageUsdPerGbMonth: 0.1,
  },
} as const;

const roundUsd = (amount: number): number => Math.round(amount * 10_000) / 10_000;

const requireNonNegative = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new InfraError('invalid_request', `${name} must be a finite number >= 0 (got ${value})`);
  }
};

const renderMonthlyTierUsd = (memoryMb: number): number => {
  if (memoryMb <= 512) return HOSTING_PRICING_RATES.render.starterMonthUsd;
  if (memoryMb <= 2048) return HOSTING_PRICING_RATES.render.standardMonthUsd;
  if (memoryMb <= 4096) return HOSTING_PRICING_RATES.render.proMonthUsd;
  return HOSTING_PRICING_RATES.render.proPlusMonthUsd;
};

export const projectHostingMonthlyCost = (
  input: HostingCostProjectionInput,
): HostingCostProjection => {
  requireNonNegative(input.memoryMb, 'memoryMb');
  requireNonNegative(input.vcpus, 'vcpus');
  requireNonNegative(input.activeHoursPerMonth, 'activeHoursPerMonth');
  requireNonNegative(input.suspendedHoursPerMonth, 'suspendedHoursPerMonth');
  requireNonNegative(input.rootfsGb, 'rootfsGb');

  const markupMultiplier = input.markupMultiplier ?? 1;
  if (!Number.isFinite(markupMultiplier) || markupMultiplier < 1) {
    throw new InfraError(
      'invalid_request',
      `markupMultiplier must be a finite number >= 1 (got ${markupMultiplier})`,
    );
  }

  const memoryGb = input.memoryMb / 1024;
  const activeMonthFraction = input.activeHoursPerMonth / HOURS_PER_MONTH;
  const totalStoredMonthFraction = Math.min(
    1,
    (input.activeHoursPerMonth + input.suspendedHoursPerMonth) / HOURS_PER_MONTH,
  );
  const suspendedMonthFraction = Math.min(1, input.suspendedHoursPerMonth / HOURS_PER_MONTH);

  let activeComputeUsd = 0;
  let suspendedStorageUsd = 0;
  let pricingBasis = '';

  switch (input.provider) {
    case 'railway': {
      const memUtil = input.averageMemoryUtilization ?? DEFAULT_RAILWAY_MEMORY_UTILIZATION;
      const cpuUtil = input.averageCpuUtilization ?? DEFAULT_RAILWAY_CPU_UTILIZATION;
      activeComputeUsd =
        memoryGb *
          memUtil *
          input.activeHoursPerMonth *
          HOSTING_PRICING_RATES.railway.memoryUsdPerGbHour +
        input.vcpus *
          cpuUtil *
          input.activeHoursPerMonth *
          HOSTING_PRICING_RATES.railway.vcpuUsdPerHour;
      suspendedStorageUsd =
        input.rootfsGb *
        totalStoredMonthFraction *
        HOSTING_PRICING_RATES.railway.storageUsdPerGbMonth;
      pricingBasis = 'usage-metered active RAM/vCPU per second + persistent volume storage';
      break;
    }
    case 'fly': {
      const vcpuMonthRate =
        input.cpuKind === 'performance'
          ? HOSTING_PRICING_RATES.fly.performanceVcpuUsdPerMonth
          : HOSTING_PRICING_RATES.fly.sharedVcpuUsdPerMonth;
      const monthlyActiveRate =
        input.vcpus * vcpuMonthRate + memoryGb * HOSTING_PRICING_RATES.fly.memoryUsdPerGbMonth;
      activeComputeUsd = monthlyActiveRate * activeMonthFraction;
      suspendedStorageUsd =
        input.rootfsGb *
        suspendedMonthFraction *
        HOSTING_PRICING_RATES.fly.suspendedRootfsUsdPerGbMonth;
      pricingBasis =
        'provisioned Firecracker microVM per second while active + rootfs-only storage while suspended';
      break;
    }
    case 'render': {
      activeComputeUsd = renderMonthlyTierUsd(input.memoryMb) * Math.min(1, activeMonthFraction);
      suspendedStorageUsd =
        input.rootfsGb * totalStoredMonthFraction * HOSTING_PRICING_RATES.render.diskUsdPerGbMonth;
      pricingBasis = 'prorated fixed Render instance tier while unsuspended + persistent disk';
      break;
    }
    case 'firecracker': {
      const monthlyHostShare =
        memoryGb * HOSTING_PRICING_RATES.firecracker.amortizedMemoryUsdPerGbMonth +
        input.vcpus * HOSTING_PRICING_RATES.firecracker.amortizedVcpuUsdPerMonth;
      activeComputeUsd = monthlyHostShare * activeMonthFraction;
      suspendedStorageUsd =
        (input.rootfsGb + memoryGb) *
        suspendedMonthFraction *
        HOSTING_PRICING_RATES.firecracker.snapshotStorageUsdPerGbMonth;
      pricingBasis =
        'amortized dedicated bare-metal host capacity while active + NVMe snapshot storage while suspended';
      break;
    }
    case 'aws': {
      activeComputeUsd =
        input.vcpus *
          input.activeHoursPerMonth *
          HOSTING_PRICING_RATES.aws.fargateArmVcpuUsdPerHour +
        memoryGb *
          input.activeHoursPerMonth *
          HOSTING_PRICING_RATES.aws.fargateArmMemoryUsdPerGbHour;
      suspendedStorageUsd =
        input.rootfsGb * totalStoredMonthFraction * HOSTING_PRICING_RATES.aws.storageUsdPerGbMonth;
      pricingBasis = 'AWS Fargate ARM provisioned vCPU/GB-hour + EBS/snapshot storage';
      break;
    }
    case 'gcp': {
      activeComputeUsd =
        input.vcpus * input.activeHoursPerMonth * HOSTING_PRICING_RATES.gcp.vcpuUsdPerHour +
        memoryGb * input.activeHoursPerMonth * HOSTING_PRICING_RATES.gcp.memoryUsdPerGbHour;
      suspendedStorageUsd =
        input.rootfsGb * totalStoredMonthFraction * HOSTING_PRICING_RATES.gcp.storageUsdPerGbMonth;
      pricingBasis = 'GCP provisioned vCPU/GB-hour + persistent storage';
      break;
    }
    case 'azure': {
      activeComputeUsd =
        input.vcpus * input.activeHoursPerMonth * HOSTING_PRICING_RATES.azure.vcpuUsdPerHour +
        memoryGb * input.activeHoursPerMonth * HOSTING_PRICING_RATES.azure.memoryUsdPerGbHour;
      suspendedStorageUsd =
        input.rootfsGb *
        totalStoredMonthFraction *
        HOSTING_PRICING_RATES.azure.storageUsdPerGbMonth;
      pricingBasis = 'Azure Container Apps provisioned vCPU/GB-hour + storage';
      break;
    }
  }

  const rawMonthlyCostUsd = activeComputeUsd + suspendedStorageUsd;
  const markedUpMonthlyCostUsd = rawMonthlyCostUsd * markupMultiplier;

  return {
    provider: input.provider,
    activeComputeUsd: roundUsd(activeComputeUsd),
    suspendedStorageUsd: roundUsd(suspendedStorageUsd),
    rawMonthlyCostUsd: roundUsd(rawMonthlyCostUsd),
    markupMultiplier,
    markedUpMonthlyCostUsd: roundUsd(markedUpMonthlyCostUsd),
    marginUsd: roundUsd(markedUpMonthlyCostUsd - rawMonthlyCostUsd),
    pricingBasis,
  };
};

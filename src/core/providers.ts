export const IMPLEMENTED_INFRA_PROVIDERS = ['railway', 'render', 'fly', 'firecracker'] as const;
export const PLANNED_INFRA_PROVIDERS = ['aws', 'gcp', 'azure'] as const;
export const ARCHIVE_HOSTING_PROVIDERS = ['railway', 'render'] as const;

export type ImplementedInfraProvider = (typeof IMPLEMENTED_INFRA_PROVIDERS)[number];
export type PlannedInfraProvider = (typeof PLANNED_INFRA_PROVIDERS)[number];
export type ArchiveHostingProvider = (typeof ARCHIVE_HOSTING_PROVIDERS)[number];
export type InfraProviderId = ImplementedInfraProvider | PlannedInfraProvider;

export type InfraIsolationKind = 'microvm' | 'container';

export type InfraBillingUnit =
  | 'active_utilization_second'
  | 'provisioned_second_with_suspend_storage'
  | 'flat_plan_month'
  | 'host_machine_month'
  | 'provisioned_vcpu_memory_second';

export type InfraProviderDescriptor = {
  readonly id: InfraProviderId;
  readonly name: string;
  readonly implemented: boolean;
  readonly supportsArchiveHosting: boolean;
  readonly supportsWorkloadDriver: boolean;
  readonly isolation: InfraIsolationKind;
  readonly supportsSuspend: boolean;
  readonly suspendMaxMemoryMb?: number;
  readonly supportsByoAccount: boolean;
  readonly supportsManagedAccount: boolean;
  readonly billingUnit: InfraBillingUnit;
  readonly notes: string;
};

export const INFRA_PROVIDERS: Readonly<Record<InfraProviderId, InfraProviderDescriptor>> = {
  railway: {
    id: 'railway',
    name: 'Railway',
    implemented: true,
    supportsArchiveHosting: true,
    supportsWorkloadDriver: true,
    isolation: 'container',
    supportsSuspend: false,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'active_utilization_second',
    notes:
      'Usage-metered memory and CPU per second; stopped services bill nothing; no memory-snapshot suspend.',
  },
  render: {
    id: 'render',
    name: 'Render',
    implemented: true,
    supportsArchiveHosting: true,
    supportsWorkloadDriver: true,
    isolation: 'container',
    supportsSuspend: false,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'flat_plan_month',
    notes:
      'Managed web services and Postgres on fixed tiers; service suspend stops execution without a memory snapshot.',
  },
  fly: {
    id: 'fly',
    name: 'Fly.io Machines',
    implemented: true,
    supportsArchiveHosting: false,
    supportsWorkloadDriver: true,
    isolation: 'microvm',
    supportsSuspend: true,
    suspendMaxMemoryMb: 2048,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'provisioned_second_with_suspend_storage',
    notes:
      'Firecracker microVMs with GA memory-snapshot suspend up to 2048 MB RAM and rootfs-only suspended storage billing.',
  },
  firecracker: {
    id: 'firecracker',
    name: 'Firecracker',
    implemented: true,
    supportsArchiveHosting: false,
    supportsWorkloadDriver: true,
    isolation: 'microvm',
    supportsSuspend: true,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'host_machine_month',
    notes:
      'Direct Firecracker VMM HTTP/Unix control plane for dedicated or bare-metal microVM hosts with full memory snapshots.',
  },
  aws: {
    id: 'aws',
    name: 'AWS (Fargate / Lambda MicroVMs)',
    implemented: false,
    supportsArchiveHosting: false,
    supportsWorkloadDriver: false,
    isolation: 'microvm',
    supportsSuspend: true,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'provisioned_vcpu_memory_second',
    notes:
      'Planned cloud adapter for AWS Fargate tasks and Firecracker-backed Lambda MicroVMs (8h session cap).',
  },
  gcp: {
    id: 'gcp',
    name: 'Google Cloud (Cloud Run / GKE Autopilot)',
    implemented: false,
    supportsArchiveHosting: false,
    supportsWorkloadDriver: false,
    isolation: 'microvm',
    supportsSuspend: false,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'provisioned_vcpu_memory_second',
    notes: 'Planned cloud adapter for Google Cloud Run and GKE Autopilot workloads.',
  },
  azure: {
    id: 'azure',
    name: 'Azure (Container Apps / ACI)',
    implemented: false,
    supportsArchiveHosting: false,
    supportsWorkloadDriver: false,
    isolation: 'container',
    supportsSuspend: false,
    supportsByoAccount: true,
    supportsManagedAccount: true,
    billingUnit: 'provisioned_vcpu_memory_second',
    notes: 'Planned cloud adapter for Azure Container Apps and Container Instances.',
  },
};

export const isInfraProvider = (value: string | null | undefined): value is InfraProviderId =>
  typeof value === 'string' && Object.hasOwn(INFRA_PROVIDERS, value);

export const isImplementedInfraProvider = (
  value: string | null | undefined,
): value is ImplementedInfraProvider =>
  IMPLEMENTED_INFRA_PROVIDERS.some((provider) => provider === value);

export const isArchiveHostingProvider = (
  value: string | null | undefined,
): value is ArchiveHostingProvider =>
  ARCHIVE_HOSTING_PROVIDERS.some((provider) => provider === value);

export const infraProviderDescriptor = (provider: InfraProviderId): InfraProviderDescriptor =>
  INFRA_PROVIDERS[provider];

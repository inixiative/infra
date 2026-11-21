import type { ArchiveHostingDriver, WorkloadDriver } from './core/contracts.ts';
import type { ArchiveHostingProvider, ImplementedInfraProvider } from './core/providers.ts';
import { firecrackerWorkloadDriver } from './firecracker/firecrackerWorkloadDriver.ts';
import { flyWorkloadDriver } from './fly/flyWorkloadDriver.ts';
import { railwayArchiveDriver } from './railway/railwayArchiveDriver.ts';
import { railwayWorkloadDriver } from './railway/railwayWorkloadDriver.ts';
import { renderArchiveDriver } from './render/renderArchiveDriver.ts';
import { renderWorkloadDriver } from './render/renderWorkloadDriver.ts';

export const WORKLOAD_DRIVERS: Readonly<Record<ImplementedInfraProvider, WorkloadDriver>> = {
  railway: railwayWorkloadDriver,
  render: renderWorkloadDriver,
  fly: flyWorkloadDriver,
  firecracker: firecrackerWorkloadDriver,
};

export const ARCHIVE_HOSTING_DRIVERS: Readonly<
  Record<ArchiveHostingProvider, ArchiveHostingDriver>
> = {
  railway: railwayArchiveDriver,
  render: renderArchiveDriver,
};

export const workloadDriverForProvider = (provider: ImplementedInfraProvider): WorkloadDriver =>
  WORKLOAD_DRIVERS[provider];

export const archiveHostingDriverForProvider = (
  provider: ArchiveHostingProvider,
): ArchiveHostingDriver => ARCHIVE_HOSTING_DRIVERS[provider];

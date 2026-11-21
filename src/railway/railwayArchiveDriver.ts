import {
  ARCHIVE_DATABASE,
  ARCHIVE_IMAGE,
  ARCHIVE_PORT,
  type ArchiveDeployment,
  type ArchiveHostingDriver,
  archiveTokenOrThrow,
  type ImageDeployStatus,
} from '../core/contracts.ts';
import { InfraError, requireNonEmpty } from '../core/infraError.ts';
import {
  deployRailwayServiceInstance,
  ensureRailwayProject,
  ensureRailwayService,
  ensureRailwayServiceDomain,
  ensureRailwayVolume,
  fetchRailwayDeploymentStatus,
  fetchRailwayProjectByName,
  fetchRailwayServiceInstance,
  fetchRailwayServiceVariables,
  fetchRailwayWorkspaces,
  scheduleRailwayProjectDelete,
  updateRailwayServiceInstance,
  upsertRailwayServiceVariables,
} from './railwayResources.ts';

export const RAILWAY_DATABASE_SERVICE = 'archive-postgres';
export const RAILWAY_ARCHIVE_SERVICE = 'archive';

const DATABASE_IMAGE = 'pgvector/pgvector:pg17';
const DATABASE_MOUNT = '/var/lib/postgresql/data';

const LIVE_DEPLOYMENTS = new Set(['SUCCESS', 'SLEEPING']);
const FAILED_DEPLOYMENTS = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

const generateRandomHexPassword = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const deployOnceIfNeeded = async (
  deployment: ArchiveDeployment,
  environmentId: string,
  serviceId: string,
) => {
  const instance = await fetchRailwayServiceInstance(
    deployment.token,
    serviceId,
    environmentId,
    deployment.apiUrl,
  );
  if (instance.latestDeployment) return instance;
  await deployRailwayServiceInstance(
    deployment.token,
    serviceId,
    environmentId,
    {},
    deployment.apiUrl,
  );
  return instance;
};

export const railwayArchiveDriver: ArchiveHostingDriver = {
  provider: 'railway',
  fetchWorkspaces: fetchRailwayWorkspaces,
  provisionDatabase: async (deployment) => {
    const { projectId, environmentId } = await ensureRailwayProject(
      deployment.token,
      deployment.workspaceId,
      deployment.name,
      deployment.ids,
      deployment.apiUrl,
    );
    const databaseServiceId =
      deployment.ids.databaseServiceId ??
      (await ensureRailwayService(
        deployment.token,
        projectId,
        environmentId,
        RAILWAY_DATABASE_SERVICE,
        deployment.apiUrl,
      ));
    await ensureRailwayVolume(
      deployment.token,
      projectId,
      environmentId,
      databaseServiceId,
      DATABASE_MOUNT,
      deployment.apiUrl,
    );
    const existing = await fetchRailwayServiceVariables(
      deployment.token,
      projectId,
      environmentId,
      databaseServiceId,
      deployment.apiUrl,
    );
    if (!existing.POSTGRES_PASSWORD) {
      await upsertRailwayServiceVariables(
        deployment.token,
        projectId,
        environmentId,
        databaseServiceId,
        {
          POSTGRES_USER: ARCHIVE_DATABASE,
          POSTGRES_DB: ARCHIVE_DATABASE,
          POSTGRES_PASSWORD: generateRandomHexPassword(),
          PGDATA: `${DATABASE_MOUNT}/pgdata`,
        },
        { skipDeploys: true },
        deployment.apiUrl,
      );
    }
    await updateRailwayServiceInstance(
      deployment.token,
      databaseServiceId,
      environmentId,
      { source: { image: DATABASE_IMAGE } },
      deployment.apiUrl,
    );
    await deployOnceIfNeeded(deployment, environmentId, databaseServiceId);
    return { projectId, environmentId, databaseServiceId };
  },
  fetchDatabaseReadiness: async (deployment) => {
    const instance = await fetchRailwayServiceInstance(
      deployment.token,
      requireNonEmpty(deployment.ids.databaseServiceId, 'archive databaseServiceId', 'railway'),
      requireNonEmpty(deployment.ids.environmentId, 'archive environmentId', 'railway'),
      deployment.apiUrl,
    );
    const status = instance.latestDeployment?.status;
    if (status === 'FAILED' || status === 'CRASHED') {
      throw new InfraError('deploy_failed', `Railway database deployment ${status}`, {
        provider: 'railway',
      });
    }
    return status === 'SUCCESS';
  },
  provisionService: async (deployment) => {
    const projectId = requireNonEmpty(deployment.ids.projectId, 'archive projectId', 'railway');
    const environmentId = requireNonEmpty(
      deployment.ids.environmentId,
      'archive environmentId',
      'railway',
    );
    const serviceId =
      deployment.ids.serviceId ??
      (await ensureRailwayService(
        deployment.token,
        projectId,
        environmentId,
        RAILWAY_ARCHIVE_SERVICE,
        deployment.apiUrl,
      ));
    await upsertRailwayServiceVariables(
      deployment.token,
      projectId,
      environmentId,
      serviceId,
      {
        ARCHIVE_SERVER_TOKEN: archiveTokenOrThrow(deployment),
        PORT: String(ARCHIVE_PORT),
        DATABASE_URL: `postgresql://${ARCHIVE_DATABASE}:\${{${RAILWAY_DATABASE_SERVICE}.POSTGRES_PASSWORD}}@\${{${RAILWAY_DATABASE_SERVICE}.RAILWAY_PRIVATE_DOMAIN}}:5432/${ARCHIVE_DATABASE}`,
      },
      { skipDeploys: true },
      deployment.apiUrl,
    );
    await updateRailwayServiceInstance(
      deployment.token,
      serviceId,
      environmentId,
      {
        source: { image: `${ARCHIVE_IMAGE}:${deployment.imageVersion}` },
        healthcheckPath: '/health',
      },
      deployment.apiUrl,
    );
    const instance = await deployOnceIfNeeded(deployment, environmentId, serviceId);
    const domain =
      instance.domains[0] ??
      (await ensureRailwayServiceDomain(
        deployment.token,
        serviceId,
        environmentId,
        ARCHIVE_PORT,
        deployment.apiUrl,
      ));
    if (
      instance.latestDeployment?.status === 'FAILED' ||
      instance.latestDeployment?.status === 'CRASHED'
    ) {
      throw new InfraError('deploy_failed', 'Railway archive service deployment failed', {
        provider: 'railway',
      });
    }
    return { ids: { ...deployment.ids, serviceId }, url: `https://${domain}` };
  },
  fetchServiceReadiness: async (deployment) => {
    const instance = await fetchRailwayServiceInstance(
      deployment.token,
      requireNonEmpty(deployment.ids.serviceId, 'archive serviceId', 'railway'),
      requireNonEmpty(deployment.ids.environmentId, 'archive environmentId', 'railway'),
      deployment.apiUrl,
    );
    const status = instance.latestDeployment?.status;
    if (status === 'FAILED' || status === 'CRASHED') {
      throw new InfraError('deploy_failed', `Railway archive service deployment ${status}`, {
        provider: 'railway',
      });
    }
    return Boolean(status && LIVE_DEPLOYMENTS.has(status));
  },
  fetchServiceFailureStatus: async (deployment) => {
    const instance = await fetchRailwayServiceInstance(
      deployment.token,
      requireNonEmpty(deployment.ids.serviceId, 'archive serviceId', 'railway'),
      requireNonEmpty(deployment.ids.environmentId, 'archive environmentId', 'railway'),
      deployment.apiUrl,
    );
    const status = instance.latestDeployment?.status;
    return status === 'FAILED' || status === 'CRASHED';
  },
  deployImage: async (deployment) => {
    const environmentId = requireNonEmpty(
      deployment.ids.environmentId,
      'archive environmentId',
      'railway',
    );
    const serviceId = requireNonEmpty(deployment.ids.serviceId, 'archive serviceId', 'railway');
    await updateRailwayServiceInstance(
      deployment.token,
      serviceId,
      environmentId,
      { source: { image: `${ARCHIVE_IMAGE}:${deployment.imageVersion}` } },
      deployment.apiUrl,
    );
    const deploymentId = await deployRailwayServiceInstance(
      deployment.token,
      serviceId,
      environmentId,
      {},
      deployment.apiUrl,
    );
    return { ...deployment.ids, deploymentId };
  },
  restoreImage: async (deployment) => {
    await updateRailwayServiceInstance(
      deployment.token,
      requireNonEmpty(deployment.ids.serviceId, 'archive serviceId', 'railway'),
      requireNonEmpty(deployment.ids.environmentId, 'archive environmentId', 'railway'),
      { source: { image: `${ARCHIVE_IMAGE}:${deployment.imageVersion}` } },
      deployment.apiUrl,
    );
  },
  fetchImageDeployStatus: async (deployment): Promise<ImageDeployStatus> => {
    const status = await fetchRailwayDeploymentStatus(
      deployment.token,
      requireNonEmpty(deployment.ids.deploymentId, 'archive deploymentId', 'railway'),
      deployment.apiUrl,
    );
    if (LIVE_DEPLOYMENTS.has(status)) return 'live';
    return FAILED_DEPLOYMENTS.has(status) ? 'failed' : 'deploying';
  },
  destroyService: async (deployment) => {
    const projectId =
      deployment.ids.projectId ??
      (
        await fetchRailwayProjectByName(
          deployment.token,
          deployment.workspaceId,
          deployment.name,
          deployment.apiUrl,
        )
      )?.id;
    if (!projectId) return;
    await scheduleRailwayProjectDelete(deployment.token, projectId, deployment.apiUrl);
  },
};

import {
  ARCHIVE_DATABASE,
  ARCHIVE_IMAGE,
  ARCHIVE_PORT,
  type ArchiveDeployment,
  type ArchiveHostingDriver,
  archiveTokenOf,
  type HostingWorkspace,
  type ImageDeployStatus,
} from '../core/contracts.ts';
import { InfraError } from '../core/infraError.ts';
import { deleteRenderResource, sendRenderRequest } from './renderRequest.ts';

export const RENDER_REGION = 'oregon';
export const RENDER_DATABASE_PLAN = 'basic_256mb';
export const RENDER_SERVICE_PLAN = 'starter';

const FAILED_DEPLOYS = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled']);
const ENDED_DEPLOYS = new Set([...FAILED_DEPLOYS, 'deactivated']);
const OWNER_PAGE_SIZE = 100;

type RenderOwner = { id: string; name?: string | null; email?: string | null };
type RenderPostgres = { id: string; name: string; status: string };
type RenderService = {
  id: string;
  name: string;
  suspended?: string;
  serviceDetails?: { url?: string };
};

const requireRenderValue = (value: string | undefined, label: string): string => {
  if (!value) {
    throw new InfraError('invalid_request', `Missing required Render ${label}`, {
      provider: 'render',
    });
  }
  return value;
};

const renderNameQuery = (name: string, ownerId: string): string =>
  new URLSearchParams({ name, ownerId, limit: '20' }).toString();

const archiveDatabaseName = (deployment: ArchiveDeployment): string => `${deployment.name}-db`;

const fetchRenderDatabaseByName = async (deployment: ArchiveDeployment) =>
  (
    await sendRenderRequest<{ postgres: RenderPostgres }[]>(
      deployment.token,
      `/postgres?${renderNameQuery(archiveDatabaseName(deployment), deployment.workspaceId)}`,
      {},
      deployment.apiUrl,
    )
  ).find((item) => item.postgres.name === archiveDatabaseName(deployment))?.postgres;

const fetchRenderServiceByName = async (deployment: ArchiveDeployment) =>
  (
    await sendRenderRequest<{ service: RenderService }[]>(
      deployment.token,
      `/services?${renderNameQuery(deployment.name, deployment.workspaceId)}`,
      {},
      deployment.apiUrl,
    )
  ).find((item) => item.service.name === deployment.name)?.service;

export const fetchRenderOwners = async (
  token: string,
  apiUrl?: string,
): Promise<HostingWorkspace[]> => {
  const workspaces: HostingWorkspace[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({
      limit: String(OWNER_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    const page = await sendRenderRequest<{ owner: RenderOwner; cursor: string }[]>(
      token,
      `/owners?${query}`,
      {},
      apiUrl,
    );
    if (!Array.isArray(page)) {
      throw new InfraError('provider_unavailable', 'Render owners response was not an array', {
        provider: 'render',
      });
    }
    workspaces.push(
      ...page.map(({ owner }) => ({ id: owner.id, name: owner.name || owner.email || owner.id })),
    );
    cursor = page.length === OWNER_PAGE_SIZE ? page.at(-1)?.cursor : undefined;
  } while (cursor);
  return workspaces;
};

export const renderArchiveDriver: ArchiveHostingDriver = {
  provider: 'render',
  fetchWorkspaces: fetchRenderOwners,
  provisionDatabase: async (deployment) => {
    const database =
      (deployment.ids.databaseId ? { id: deployment.ids.databaseId } : undefined) ??
      (await fetchRenderDatabaseByName(deployment)) ??
      (await sendRenderRequest<RenderPostgres>(
        deployment.token,
        '/postgres',
        {
          method: 'POST',
          body: {
            name: archiveDatabaseName(deployment),
            ownerId: deployment.workspaceId,
            plan: RENDER_DATABASE_PLAN,
            version: '17',
            region: RENDER_REGION,
            databaseName: ARCHIVE_DATABASE,
            databaseUser: ARCHIVE_DATABASE,
          },
        },
        deployment.apiUrl,
      ));
    return { ...deployment.ids, databaseId: database.id };
  },
  fetchDatabaseReadiness: async (deployment) => {
    const { status } = await sendRenderRequest<RenderPostgres>(
      deployment.token,
      `/postgres/${requireRenderValue(deployment.ids.databaseId, 'databaseId')}`,
      {},
      deployment.apiUrl,
    );
    if (status === 'unavailable' || status === 'suspended') {
      throw new InfraError('deploy_failed', `Render Postgres status ${status}`, {
        provider: 'render',
      });
    }
    return status === 'available';
  },
  provisionService: async (deployment) => {
    const existing =
      (deployment.ids.serviceId
        ? await sendRenderRequest<RenderService>(
            deployment.token,
            `/services/${deployment.ids.serviceId}`,
            {},
            deployment.apiUrl,
          )
        : undefined) ?? (await fetchRenderServiceByName(deployment));
    const service =
      existing ??
      (
        await sendRenderRequest<{ service: RenderService }>(
          deployment.token,
          '/services',
          {
            method: 'POST',
            body: {
              type: 'web_service',
              name: deployment.name,
              ownerId: deployment.workspaceId,
              image: {
                ownerId: deployment.workspaceId,
                imagePath: `${ARCHIVE_IMAGE}:${deployment.imageVersion}`,
              },
              envVars: [
                { key: 'ARCHIVE_SERVER_TOKEN', value: archiveTokenOf(deployment) },
                { key: 'PORT', value: String(ARCHIVE_PORT) },
                {
                  key: 'DATABASE_URL',
                  value: (
                    await sendRenderRequest<{ internalConnectionString: string }>(
                      deployment.token,
                      `/postgres/${requireRenderValue(deployment.ids.databaseId, 'databaseId')}/connection-info`,
                      {},
                      deployment.apiUrl,
                    )
                  ).internalConnectionString,
                },
              ],
              serviceDetails: {
                runtime: 'image',
                plan: RENDER_SERVICE_PLAN,
                region: RENDER_REGION,
                healthCheckPath: '/health',
              },
            },
          },
          deployment.apiUrl,
        )
      ).service;
    return {
      ids: { ...deployment.ids, serviceId: service.id },
      url: requireRenderValue(service.serviceDetails?.url, 'service url'),
    };
  },
  fetchServiceReadiness: async (deployment) => {
    const [latest] = await sendRenderRequest<{ deploy: { status: string } }[]>(
      deployment.token,
      `/services/${requireRenderValue(deployment.ids.serviceId, 'serviceId')}/deploys?limit=1`,
      {},
      deployment.apiUrl,
    );
    if (!latest) return false;
    if (FAILED_DEPLOYS.has(latest.deploy.status)) {
      throw new InfraError('deploy_failed', `Render deploy ${latest.deploy.status}`, {
        provider: 'render',
      });
    }
    return latest.deploy.status === 'live';
  },
  fetchServiceFailureStatus: async (deployment) => {
    const [latest] = await sendRenderRequest<{ deploy: { status: string } }[]>(
      deployment.token,
      `/services/${requireRenderValue(deployment.ids.serviceId, 'serviceId')}/deploys?limit=1`,
      {},
      deployment.apiUrl,
    );
    return Boolean(latest && FAILED_DEPLOYS.has(latest.deploy.status));
  },
  deployImage: async (deployment) => {
    const serviceId = requireRenderValue(deployment.ids.serviceId, 'serviceId');
    const imagePath = `${ARCHIVE_IMAGE}:${deployment.imageVersion}`;
    await sendRenderRequest(
      deployment.token,
      `/services/${serviceId}`,
      {
        method: 'PATCH',
        body: { image: { ownerId: deployment.workspaceId, imagePath } },
      },
      deployment.apiUrl,
    );
    const deploy = await sendRenderRequest<{ id: string }>(
      deployment.token,
      `/services/${serviceId}/deploys`,
      {
        method: 'POST',
        body: { imageUrl: imagePath },
      },
      deployment.apiUrl,
    );
    return {
      ...deployment.ids,
      deploymentId: requireRenderValue(deploy?.id, 'deploymentId'),
    };
  },
  restoreImage: async (deployment) => {
    await sendRenderRequest(
      deployment.token,
      `/services/${requireRenderValue(deployment.ids.serviceId, 'serviceId')}`,
      {
        method: 'PATCH',
        body: {
          image: {
            ownerId: deployment.workspaceId,
            imagePath: `${ARCHIVE_IMAGE}:${deployment.imageVersion}`,
          },
        },
      },
      deployment.apiUrl,
    );
  },
  fetchImageDeployStatus: async (deployment): Promise<ImageDeployStatus> => {
    const { status } = await sendRenderRequest<{ status: string }>(
      deployment.token,
      `/services/${requireRenderValue(deployment.ids.serviceId, 'serviceId')}/deploys/${requireRenderValue(deployment.ids.deploymentId, 'deploymentId')}`,
      {},
      deployment.apiUrl,
    );
    if (status === 'live') return 'live';
    return ENDED_DEPLOYS.has(status) ? 'failed' : 'deploying';
  },
  destroyService: async (deployment) => {
    const serviceId = deployment.ids.serviceId ?? (await fetchRenderServiceByName(deployment))?.id;
    if (serviceId) {
      await deleteRenderResource(deployment.token, `/services/${serviceId}`, deployment.apiUrl);
    }
    const databaseId =
      deployment.ids.databaseId ?? (await fetchRenderDatabaseByName(deployment))?.id;
    if (databaseId) {
      await deleteRenderResource(deployment.token, `/postgres/${databaseId}`, deployment.apiUrl);
    }
  },
};

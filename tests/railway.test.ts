import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  type ArchiveDeployment,
  connectRailwayServiceToGitHub,
  ensureRailwayBucket,
  fetchRailwayBucketCredentials,
  fetchRailwayProjectEnvironments,
  fetchRailwayProjectVolumes,
  fetchRailwayServiceConnectedToGitHub,
  InfraError,
  railwayArchiveDriver,
  railwayWorkloadDriver,
  renameRailwayEnvironment,
  renameRailwayService,
  renameRailwayVolume,
} from '../src/index.ts';

const FAKE_TOKEN = 'railway-test-token';

type Project = {
  id: string;
  name: string;
  workspaceId: string;
  environments: { id: string; name: string }[];
  buckets: { id: string; name: string }[];
  volumes: { id: string; name: string }[];
};

type Service = {
  id: string;
  projectId: string;
  name: string;
  image?: string;
  repo?: string;
  variables: Record<string, string>;
  deploymentId?: string;
  deploymentStatus?: string;
  domain?: string;
  volumeMount?: string;
  triggers: { id: string; repository: string; branch: string }[];
};

const state = {
  projects: new Map<string, Project>(),
  services: new Map<string, Service>(),
  deployments: new Map<string, string>(),
  scheduledDeletes: [] as string[],
  deletedServices: [] as string[],
  stoppedDeployments: [] as string[],
  operations: [] as string[],
  serviceDomain: 'archive.up.railway.app',
  deployStatus: 'SUCCESS',
  failNext: undefined as string | undefined,
  rejectNext: undefined as { operation: string; message: string } | undefined,
  pageSize: 100,
  workspaces: [{ id: 'workspace-1', name: 'Team Workspace' }],
};

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;
const edges = <T>(items: T[]) => ({ edges: items.map((node) => ({ node })) });

const operationOf = (query: string) =>
  [
    'projectScheduleDelete',
    'projectCreate',
    'projects',
    'serviceDelete',
    'serviceUpdate',
    'serviceCreate',
    'volumeUpdate',
    'volumeCreate',
    'environmentRename',
    'environment',
    'variableCollectionUpsert',
    'variables',
    'serviceInstanceUpdate',
    'serviceInstanceDeployV2',
    'serviceInstance',
    'deploymentTriggerCreate',
    'deploymentTriggers',
    'deploymentStop',
    'deployment',
    'serviceDomainCreate',
    'bucketS3Credentials',
    'bucketCreate',
    'apiToken',
    'service',
    'project',
  ].find((name) => new RegExp(`\\b${name}\\s*[({]`).test(query)) ?? 'unknown';

const resolveGraphql = (operation: string, variables: Record<string, unknown>) => {
  const input = (variables.input ?? {}) as Record<string, unknown>;
  const service = state.services.get(
    String(variables.serviceId ?? input.serviceId ?? variables.id),
  );

  switch (operation) {
    case 'apiToken':
      return { apiToken: { workspaces: state.workspaces } };
    case 'projects': {
      const all = [...state.projects.values()].filter(
        (project) => project.workspaceId === variables.workspaceId,
      );
      const start = variables.after ? Number(variables.after) : 0;
      const page = all.slice(start, start + state.pageSize);
      return {
        projects: {
          ...edges(
            page.map((project) => ({
              id: project.id,
              name: project.name,
              environments: edges(project.environments),
            })),
          ),
          pageInfo: {
            hasNextPage: start + state.pageSize < all.length,
            endCursor: String(start + state.pageSize),
          },
        },
      };
    }
    case 'projectCreate': {
      const project: Project = {
        id: nextId('project'),
        name: String(input.name),
        workspaceId: String(input.workspaceId),
        environments: [
          {
            id: nextId('env'),
            name: String(input.defaultEnvironmentName ?? 'production'),
          },
        ],
        buckets: [],
        volumes: [],
      };
      state.projects.set(project.id, project);
      return {
        projectCreate: {
          id: project.id,
          name: project.name,
          environments: edges(project.environments),
        },
      };
    }
    case 'project': {
      const project = state.projects.get(String(variables.id));
      return {
        project: {
          services: edges(
            [...state.services.values()].filter((item) => item.projectId === variables.id),
          ),
          environments: edges(project?.environments ?? []),
          volumes: edges(project?.volumes ?? []),
          buckets: project?.buckets ?? [],
        },
      };
    }
    case 'environmentRename': {
      for (const project of state.projects.values()) {
        const env = project.environments.find((candidate) => candidate.id === variables.id);
        if (env) env.name = String(variables.name);
      }
      return { environmentRename: true };
    }
    case 'serviceCreate': {
      const created: Service = {
        id: nextId('service'),
        projectId: String(input.projectId),
        name: String(input.name),
        variables: {},
        triggers: [],
      };
      state.services.set(created.id, created);
      return { serviceCreate: { id: created.id } };
    }
    case 'service':
      return service ? { service: { projectId: service.projectId } } : undefined;
    case 'serviceUpdate': {
      if (service) service.name = String(input.name);
      return { serviceUpdate: { id: service?.id ?? '', name: service?.name ?? '' } };
    }
    case 'serviceDelete': {
      const id = String(variables.id);
      if (!state.services.has(id)) return undefined;
      state.services.delete(id);
      state.deletedServices.push(id);
      return { serviceDelete: true };
    }
    case 'environment':
      return {
        environment: {
          volumeInstances: edges(
            [...state.services.values()]
              .filter((item) => item.volumeMount)
              .map((item) => ({ serviceId: item.id, mountPath: item.volumeMount })),
          ),
        },
      };
    case 'volumeCreate': {
      const volumeId = nextId('vol');
      if (service) {
        service.volumeMount = String(input.mountPath);
        const project = state.projects.get(service.projectId);
        project?.volumes.push({ id: volumeId, name: `${service.name}-vol` });
      }
      return { volumeCreate: { id: volumeId } };
    }
    case 'volumeUpdate': {
      for (const project of state.projects.values()) {
        const volume = project.volumes.find((candidate) => candidate.id === variables.volumeId);
        if (volume) {
          volume.name = String(input.name);
          return { volumeUpdate: volume };
        }
      }
      return undefined;
    }
    case 'variables':
      return { variables: service?.variables ?? {} };
    case 'variableCollectionUpsert':
      if (service) Object.assign(service.variables, input.variables);
      return { variableCollectionUpsert: true };
    case 'serviceInstanceUpdate': {
      const update = variables.input as { source?: { image?: string; repo?: string } };
      if (service && update.source?.image) service.image = update.source.image;
      if (service && update.source?.repo) service.repo = update.source.repo;
      return { serviceInstanceUpdate: true };
    }
    case 'serviceInstanceDeployV2': {
      const deploymentId = nextId('dep');
      if (service) {
        service.deploymentId = deploymentId;
        service.deploymentStatus = state.deployStatus;
      }
      state.deployments.set(deploymentId, state.deployStatus);
      return { serviceInstanceDeployV2: deploymentId };
    }
    case 'deployment': {
      const status = state.deployments.get(String(variables.id));
      return status ? { deployment: { status } } : undefined;
    }
    case 'deploymentStop': {
      const id = String(variables.id);
      state.stoppedDeployments.push(id);
      state.deployments.set(id, 'STOPPED');
      for (const item of state.services.values()) {
        if (item.deploymentId === id) item.deploymentStatus = 'STOPPED';
      }
      return { deploymentStop: true };
    }
    case 'deploymentTriggers':
      return { deploymentTriggers: edges(service?.triggers ?? []) };
    case 'deploymentTriggerCreate': {
      const trigger = {
        id: nextId('trig'),
        repository: String(input.repository),
        branch: String(input.branch),
      };
      service?.triggers.push(trigger);
      return { deploymentTriggerCreate: { id: trigger.id } };
    }
    case 'serviceInstance':
      return {
        serviceInstance: {
          id: service?.id ?? 'unknown',
          latestDeployment: service?.deploymentStatus
            ? { id: service.deploymentId, status: service.deploymentStatus }
            : null,
          domains: { serviceDomains: service?.domain ? [{ domain: service.domain }] : [] },
          source: service?.repo ? { repo: service.repo } : null,
        },
      };
    case 'serviceDomainCreate':
      if (service) service.domain = state.serviceDomain;
      return { serviceDomainCreate: { domain: service?.domain } };
    case 'bucketCreate': {
      const project = state.projects.get(String(input.projectId));
      const bucket = { id: nextId('bkt'), name: String(input.name) };
      project?.buckets.push(bucket);
      return { bucketCreate: bucket };
    }
    case 'bucketS3Credentials':
      return {
        bucketS3Credentials: {
          bucketName: `s3-${String(variables.bucketId)}`,
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'SECRET_TEST',
          region: 'auto',
          endpoint: 'https://storage.railway.app',
          urlStyle: 'path',
        },
      };
    case 'projectScheduleDelete':
      state.scheduledDeletes.push(String(variables.id));
      state.projects.delete(String(variables.id));
      return { projectScheduleDelete: true };
    default:
      return undefined;
  }
};

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (request) => {
    if (request.headers.get('authorization') !== `Bearer ${FAKE_TOKEN}`) {
      return Response.json({ errors: [{ message: 'Not Authorized' }] });
    }
    const { query, variables } = (await request.json()) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = operationOf(query);
    if (state.failNext === operation) {
      state.failNext = undefined;
      return new Response('unavailable', { status: 503 });
    }
    if (state.rejectNext?.operation === operation) {
      const { message } = state.rejectNext;
      state.rejectNext = undefined;
      return Response.json({ errors: [{ message }] });
    }
    state.operations.push(operation);
    const data = resolveGraphql(operation, variables);
    if (!data) {
      return Response.json({ errors: [{ message: `${operation} not found` }] });
    }
    return Response.json({ data });
  },
});

const apiUrl = `http://127.0.0.1:${server.port}/graphql/v2`;

const makeDeployment = (ids: ArchiveDeployment['ids'] = {}): ArchiveDeployment => ({
  apiUrl,
  token: FAKE_TOKEN,
  workspaceId: 'workspace-1',
  name: 'kingdom-archive-abc',
  imageVersion: '0.7.0',
  archiveToken: 'archive-token-at-least-32-characters-long',
  ids,
});

const resetState = () => {
  state.projects.clear();
  state.services.clear();
  state.deployments.clear();
  state.scheduledDeletes.length = 0;
  state.deletedServices.length = 0;
  state.stoppedDeployments.length = 0;
  state.operations.length = 0;
  state.deployStatus = 'SUCCESS';
  state.failNext = undefined;
  state.rejectNext = undefined;
  state.pageSize = 100;
  state.workspaces = [{ id: 'workspace-1', name: 'Team Workspace' }];
};

afterAll(() => server.stop(true));

describe('railwayArchiveDriver', () => {
  beforeEach(resetState);

  it('provisions pgvector Postgres with volume before deploy, then Archive service behind a domain', async () => {
    const ids = await railwayArchiveDriver.provisionDatabase(makeDeployment());
    const db = state.services.get(ids.databaseServiceId ?? '');
    expect(db).toMatchObject({
      name: 'archive-postgres',
      image: 'pgvector/pgvector:pg17',
      volumeMount: '/var/lib/postgresql/data',
      deploymentStatus: 'SUCCESS',
    });
    expect(state.operations.indexOf('volumeCreate')).toBeLessThan(
      state.operations.indexOf('serviceInstanceDeployV2'),
    );
    expect(await railwayArchiveDriver.fetchDatabaseReadiness(makeDeployment(ids))).toBe(true);

    const { ids: withService, url } = await railwayArchiveDriver.provisionService(
      makeDeployment(ids),
    );
    expect(url).toBe('https://archive.up.railway.app');
    expect(await railwayArchiveDriver.fetchServiceReadiness(makeDeployment(withService))).toBe(
      true,
    );
    expect(await railwayArchiveDriver.fetchServiceFailureStatus(makeDeployment(withService))).toBe(
      false,
    );
  });

  it('deploys a new image, tracks status transitions, and restores previous image', async () => {
    const ids = await railwayArchiveDriver.provisionDatabase(makeDeployment());
    const { ids: running } = await railwayArchiveDriver.provisionService(makeDeployment(ids));
    const deploying = await railwayArchiveDriver.deployImage({
      ...makeDeployment(running),
      imageVersion: '0.8.0',
    });
    expect(await railwayArchiveDriver.fetchImageDeployStatus(makeDeployment(deploying))).toBe(
      'live',
    );
    state.deployments.set(deploying.deploymentId ?? '', 'DEPLOYING');
    expect(await railwayArchiveDriver.fetchImageDeployStatus(makeDeployment(deploying))).toBe(
      'deploying',
    );
    state.deployments.set(deploying.deploymentId ?? '', 'CRASHED');
    expect(await railwayArchiveDriver.fetchImageDeployStatus(makeDeployment(deploying))).toBe(
      'failed',
    );

    await railwayArchiveDriver.restoreImage({ ...makeDeployment(running), imageVersion: '0.7.0' });
    expect(state.services.get(running.serviceId ?? '')?.image).toBe(
      'ghcr.io/inixiative/archive:0.7.0',
    );
  });

  it('maps throttle and auth errors to typed InfraError codes and adopts retries', async () => {
    state.rejectNext = {
      operation: 'projectCreate',
      message: 'You are creating projects too quickly.',
    };
    await expect(railwayArchiveDriver.provisionDatabase(makeDeployment())).rejects.toMatchObject({
      code: 'rate_limited',
    });

    state.failNext = 'volumeCreate';
    await expect(railwayArchiveDriver.provisionDatabase(makeDeployment())).rejects.toBeInstanceOf(
      InfraError,
    );

    const ids = await railwayArchiveDriver.provisionDatabase(makeDeployment());
    expect(state.operations.filter((op) => op === 'projectCreate')).toHaveLength(1);
    expect(state.operations.filter((op) => op === 'serviceCreate')).toHaveLength(1);

    await expect(railwayArchiveDriver.fetchWorkspaces('wrong', apiUrl)).rejects.toMatchObject({
      code: 'authentication_failed',
    });

    await railwayArchiveDriver.destroyService(makeDeployment());
    expect(state.scheduledDeletes).toEqual([ids.projectId ?? '']);
  });
});

describe('railwayWorkloadDriver and shared Railway helpers', () => {
  beforeEach(resetState);

  it('provisions, checks status/usage, stops, wakes, and destroys a workload', async () => {
    const credentials = { token: FAKE_TOKEN, workspaceId: 'workspace-1', apiUrl };
    const handle = await railwayWorkloadDriver.provisionWorkload(credentials, {
      name: 'chorus-host-1',
      image: 'ghcr.io/inixiative/chorus:1.0.0',
      memoryMb: 2048,
      vcpus: 2,
      env: { NODE_ENV: 'production' },
      volume: { name: 'data', mountPath: '/data' },
      port: { internalPort: 4500, publicHttps: true },
      healthcheckPath: '/health',
    });
    expect(handle.provider).toBe('railway');
    expect(handle.url).toBe('https://archive.up.railway.app');

    const running = await railwayWorkloadDriver.fetchWorkloadStatus(credentials, handle);
    expect(running.state).toBe('running');

    const usage = await railwayWorkloadDriver.fetchWorkloadUsage(credentials, handle);
    expect(usage.activeSeconds).toBeGreaterThan(0);

    await railwayWorkloadDriver.suspendWorkload(credentials, handle);
    expect(state.stoppedDeployments).toHaveLength(1);
    const stopped = await railwayWorkloadDriver.fetchWorkloadStatus(credentials, handle);
    expect(stopped.state).toBe('stopped');

    const woken = await railwayWorkloadDriver.wakeWorkload(credentials, handle);
    expect(woken.metadata?.deploymentId).toBeDefined();

    await railwayWorkloadDriver.destroyWorkload(credentials, handle);
    expect(state.deletedServices).toEqual([handle.workloadId]);
  });

  it('supports template/init GitHub wiring, buckets, and renames over GraphQL', async () => {
    const credentials = { token: FAKE_TOKEN, workspaceId: 'workspace-1', apiUrl };
    const handle = await railwayWorkloadDriver.provisionWorkload(credentials, {
      name: 'web-api',
      image: 'node:22',
      memoryMb: 1024,
      vcpus: 1,
      volume: { name: 'uploads', mountPath: '/uploads' },
    });

    const projectId = handle.projectId ?? '';
    const environmentId = handle.environmentId ?? '';

    expect(
      await fetchRailwayServiceConnectedToGitHub(
        FAKE_TOKEN,
        handle.workloadId,
        environmentId,
        apiUrl,
      ),
    ).toBe(false);
    await connectRailwayServiceToGitHub(
      FAKE_TOKEN,
      handle.workloadId,
      environmentId,
      'inixiative/kingdom',
      'main',
      apiUrl,
    );
    expect(
      await fetchRailwayServiceConnectedToGitHub(
        FAKE_TOKEN,
        handle.workloadId,
        environmentId,
        apiUrl,
      ),
    ).toBe(true);

    const bucket = await ensureRailwayBucket(FAKE_TOKEN, projectId, 'assets', apiUrl);
    const bucketAgain = await ensureRailwayBucket(FAKE_TOKEN, projectId, 'assets', apiUrl);
    expect(bucketAgain.id).toBe(bucket.id);

    const creds = await fetchRailwayBucketCredentials(
      FAKE_TOKEN,
      bucket.id,
      environmentId,
      projectId,
      apiUrl,
    );
    expect(creds.accessKeyId).toBe('AKIA_TEST');

    const renamed = await renameRailwayService(FAKE_TOKEN, handle.workloadId, 'api-prod', apiUrl);
    expect(renamed.name).toBe('api-prod');
    await renameRailwayEnvironment(FAKE_TOKEN, environmentId, 'prod', apiUrl);
    expect((await fetchRailwayProjectEnvironments(FAKE_TOKEN, projectId, apiUrl))[0]?.name).toBe(
      'prod',
    );
    const volumes = await fetchRailwayProjectVolumes(FAKE_TOKEN, projectId, apiUrl);
    const renamedVol = await renameRailwayVolume(
      FAKE_TOKEN,
      volumes[0]?.id ?? '',
      'data-vol',
      apiUrl,
    );
    expect(renamedVol.name).toBe('data-vol');
  });
});

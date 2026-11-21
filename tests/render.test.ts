import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { type ArchiveDeployment, renderArchiveDriver, renderWorkloadDriver } from '../src/index.ts';

const FAKE_TOKEN = 'render-test-token';

type Owner = { id: string; name: string; email: string };
type Postgres = { id: string; name: string; ownerId: string; status: string };
type Service = {
  id: string;
  name: string;
  ownerId: string;
  suspended: 'suspended' | 'not_suspended';
  image: { imagePath: string };
  serviceDetails: { url?: string; region: string; plan: string };
};

const state = {
  owners: [{ id: 'tea-1', name: 'Team Workspace', email: 'team@example.com' }] as Owner[],
  postgres: new Map<string, Postgres>(),
  services: new Map<string, Service>(),
  deploys: new Map<string, { id: string; status: string; imageUrl?: string }>(),
  requests: [] as { method: string; path: string; body?: unknown }[],
  serviceUrl: 'https://archive.onrender.com',
  deployStatus: 'live',
  databaseChecksUntilAvailable: 1,
};

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (request) => {
    if (request.headers.get('authorization') !== `Bearer ${FAKE_TOKEN}`) {
      return Response.json({ message: 'unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1/, '');
    const body =
      request.method === 'POST' || request.method === 'PATCH'
        ? await request.json().catch(() => undefined)
        : undefined;
    state.requests.push({ method: request.method, path, body });

    const [, collection, id, child, grandChild] = path.split('/');

    if (collection === 'owners' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      return Response.json(
        state.owners
          .slice(start, start + limit)
          .map((owner, index) => ({ owner, cursor: String(start + index + 1) })),
      );
    }

    const matchesQuery = (item: { name: string; ownerId: string }) =>
      item.name === url.searchParams.get('name') &&
      item.ownerId === url.searchParams.get('ownerId');

    if (collection === 'postgres') {
      if (request.method === 'GET' && !id) {
        return Response.json(
          [...state.postgres.values()]
            .filter(matchesQuery)
            .map((postgres) => ({ postgres, cursor: 'c' })),
        );
      }
      if (request.method === 'POST') {
        const input = body as { name: string; ownerId: string };
        const postgres: Postgres = {
          id: nextId('dpg'),
          name: input.name,
          ownerId: input.ownerId,
          status: 'creating',
        };
        state.postgres.set(postgres.id, postgres);
        return Response.json(postgres, { status: 201 });
      }
      const postgres = id ? state.postgres.get(id) : undefined;
      if (!postgres) return Response.json({ message: 'not found' }, { status: 404 });
      if (request.method === 'DELETE') {
        state.postgres.delete(postgres.id);
        return new Response(null, { status: 204 });
      }
      if (child === 'connection-info') {
        return Response.json({
          internalConnectionString: `postgresql://archive:secret@${postgres.id}/archive`,
        });
      }
      if (state.databaseChecksUntilAvailable-- <= 0) postgres.status = 'available';
      return Response.json(postgres);
    }

    if (collection === 'services') {
      if (request.method === 'GET' && !id) {
        return Response.json(
          [...state.services.values()]
            .filter(matchesQuery)
            .map((service) => ({ service, cursor: 'c' })),
        );
      }
      if (request.method === 'POST' && !id) {
        const input = body as {
          type: string;
          name: string;
          ownerId: string;
          image: { imagePath: string };
          serviceDetails: { region: string; plan: string };
        };
        const service: Service = {
          id: nextId('srv'),
          name: input.name,
          ownerId: input.ownerId,
          suspended: 'not_suspended',
          image: { imagePath: input.image.imagePath },
          serviceDetails: {
            url: input.type === 'web_service' ? state.serviceUrl : undefined,
            region: input.serviceDetails.region,
            plan: input.serviceDetails.plan,
          },
        };
        state.services.set(service.id, service);
        return Response.json({ service, deployId: nextId('dep') }, { status: 201 });
      }

      const service = id ? state.services.get(id) : undefined;
      if (!service) return Response.json({ message: 'not found' }, { status: 404 });

      if (child === 'suspend' && request.method === 'POST') {
        service.suspended = 'suspended';
        return new Response(null, { status: 204 });
      }
      if (child === 'resume' && request.method === 'POST') {
        service.suspended = 'not_suspended';
        return new Response(null, { status: 204 });
      }
      if (request.method === 'DELETE') {
        state.services.delete(service.id);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'PATCH') {
        const input = body as { image?: { imagePath: string } };
        if (input.image) service.image = { imagePath: input.image.imagePath };
        return Response.json(service);
      }
      if (child === 'deploys' && request.method === 'POST') {
        const deploy = {
          id: nextId('dep'),
          status: state.deployStatus,
          imageUrl: (body as { imageUrl?: string }).imageUrl,
        };
        state.deploys.set(deploy.id, deploy);
        return Response.json(deploy, { status: 201 });
      }
      if (child === 'deploys' && grandChild) {
        const deploy = state.deploys.get(grandChild);
        return deploy
          ? Response.json(deploy)
          : Response.json({ message: 'not found' }, { status: 404 });
      }
      if (child === 'deploys') {
        return Response.json([{ deploy: { status: state.deployStatus } }]);
      }
      return Response.json(service);
    }

    return Response.json({ message: 'not found' }, { status: 404 });
  },
});

const apiUrl = `http://127.0.0.1:${server.port}/v1`;

const makeDeployment = (ids: ArchiveDeployment['ids'] = {}): ArchiveDeployment => ({
  apiUrl,
  token: FAKE_TOKEN,
  workspaceId: 'tea-1',
  name: 'kingdom-archive-abc',
  imageVersion: '0.7.0',
  archiveToken: 'archive-token-at-least-32-characters-long',
  ids,
});

const resetState = () => {
  state.owners = [{ id: 'tea-1', name: 'Team Workspace', email: 'team@example.com' }];
  state.postgres.clear();
  state.services.clear();
  state.deploys.clear();
  state.requests.length = 0;
  state.deployStatus = 'live';
  state.databaseChecksUntilAvailable = 1;
};

afterAll(() => server.stop(true));

describe('renderArchiveDriver', () => {
  beforeEach(resetState);

  it('provisions Postgres, polls readiness, provisions service, upgrades image, and tears down', async () => {
    const ids = await renderArchiveDriver.provisionDatabase(makeDeployment());
    expect(await renderArchiveDriver.fetchDatabaseReadiness(makeDeployment(ids))).toBe(false);
    expect(await renderArchiveDriver.fetchDatabaseReadiness(makeDeployment(ids))).toBe(true);

    const { ids: running, url } = await renderArchiveDriver.provisionService(makeDeployment(ids));
    expect(url).toBe(state.serviceUrl);
    expect(await renderArchiveDriver.fetchServiceReadiness(makeDeployment(running))).toBe(true);

    const deploying = await renderArchiveDriver.deployImage({
      ...makeDeployment(running),
      imageVersion: '0.8.0',
    });
    expect(await renderArchiveDriver.fetchImageDeployStatus(makeDeployment(deploying))).toBe(
      'live',
    );
    const depRecord = state.deploys.get(deploying.deploymentId ?? '');
    if (depRecord) depRecord.status = 'update_failed';
    expect(await renderArchiveDriver.fetchImageDeployStatus(makeDeployment(deploying))).toBe(
      'failed',
    );

    await renderArchiveDriver.destroyService(makeDeployment());
    expect(state.services.size).toBe(0);
    expect(state.postgres.size).toBe(0);
  });

  it('paginates owners and maps bad token to authentication_failed', async () => {
    state.owners = Array.from({ length: 101 }, (_, index) => ({
      id: `tea-${index}`,
      name: index === 100 ? '' : `Workspace ${index}`,
      email: `owner${index}@example.com`,
    }));
    const workspaces = await renderArchiveDriver.fetchWorkspaces(FAKE_TOKEN, apiUrl);
    expect(workspaces).toHaveLength(101);
    expect(workspaces[100]).toEqual({ id: 'tea-100', name: 'owner100@example.com' });

    await expect(renderArchiveDriver.fetchWorkspaces('wrong', apiUrl)).rejects.toMatchObject({
      code: 'authentication_failed',
    });
  });
});

describe('renderWorkloadDriver', () => {
  beforeEach(resetState);

  it('creates, suspends, resumes, checks status/usage, and deletes a Render workload', async () => {
    const credentials = { token: FAKE_TOKEN, workspaceId: 'tea-1', apiUrl };
    const handle = await renderWorkloadDriver.provisionWorkload(credentials, {
      name: 'chorus-render-1',
      image: 'ghcr.io/inixiative/chorus:1.0.0',
      memoryMb: 2048,
      vcpus: 1,
      port: { internalPort: 4500, publicHttps: true },
    });
    expect(handle.provider).toBe('render');
    expect(state.services.get(handle.workloadId)?.serviceDetails.plan).toBe('standard');

    expect((await renderWorkloadDriver.fetchWorkloadStatus(credentials, handle)).state).toBe(
      'running',
    );

    await renderWorkloadDriver.suspendWorkload(credentials, handle);
    expect((await renderWorkloadDriver.fetchWorkloadStatus(credentials, handle)).state).toBe(
      'suspended',
    );
    expect(
      (await renderWorkloadDriver.fetchWorkloadUsage(credentials, handle)).suspendedSeconds,
    ).toBeGreaterThan(0);

    await renderWorkloadDriver.wakeWorkload(credentials, handle);
    expect((await renderWorkloadDriver.fetchWorkloadStatus(credentials, handle)).state).toBe(
      'running',
    );

    await renderWorkloadDriver.destroyWorkload(credentials, handle);
    expect(state.services.size).toBe(0);
    await renderWorkloadDriver.destroyWorkload(credentials, handle);
  });
});

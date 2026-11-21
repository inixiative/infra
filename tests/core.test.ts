import { afterAll, describe, expect, it } from 'bun:test';
import {
  infraErrorForStatus,
  infraProviderDescriptor,
  isArchiveHostingProvider,
  isImplementedInfraProvider,
  isInfraError,
  isInfraProvider,
  sendInfraRequest,
} from '../src/index.ts';

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/redirect') {
      return Response.redirect('http://127.0.0.1/other', 302);
    }
    if (path === '/slow') {
      await Bun.sleep(250);
      return Response.json({ ok: true });
    }
    if (path === '/malformed') {
      return new Response('{not-json', { status: 200 });
    }
    if (path === '/empty') {
      return new Response(null, { status: 204 });
    }
    if (path === '/echo') {
      return Response.json({
        auth: request.headers.get('authorization'),
        body: await request.json(),
      });
    }
    return Response.json({ error: 'nope' }, { status: 422 });
  },
});

const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

describe('core primitives', () => {
  it('enforces redirect:error, timeouts, JSON validation, 204 empty responses, and status error mapping', async () => {
    const echoed = await sendInfraRequest<{ auth: string; body: { hello: string } }>(
      `${baseUrl}/echo`,
      { method: 'POST', token: 'secret-token', body: { hello: 'world' }, provider: 'fly' },
    );
    expect(echoed).toEqual({ auth: 'Bearer secret-token', body: { hello: 'world' } });

    expect(await sendInfraRequest(`${baseUrl}/empty`)).toBeUndefined();

    await expect(
      sendInfraRequest(`${baseUrl}/redirect`, { provider: 'fly' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', provider: 'fly' });

    await expect(
      sendInfraRequest(`${baseUrl}/slow`, { timeoutMs: 40, provider: 'railway' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', provider: 'railway' });

    await expect(
      sendInfraRequest(`${baseUrl}/malformed`, { provider: 'render' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', provider: 'render' });

    await expect(sendInfraRequest(`${baseUrl}/other`, { provider: 'fly' })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 422,
      provider: 'fly',
    });

    expect(isInfraError(infraErrorForStatus(401), 'authentication_failed')).toBe(true);
    expect(isInfraError(infraErrorForStatus(404), 'not_found')).toBe(true);
    expect(isInfraError(infraErrorForStatus(409), 'conflict')).toBe(true);
    expect(isInfraError(infraErrorForStatus(429), 'rate_limited')).toBe(true);
    expect(isInfraError(infraErrorForStatus(500), 'provider_unavailable')).toBe(true);
    expect(isInfraError(new Error('plain'))).toBe(false);
  });

  it('exposes accurate provider capability guards and descriptors', () => {
    expect(isInfraProvider('fly')).toBe(true);
    expect(isInfraProvider('aws')).toBe(true);
    expect(isInfraProvider('unknown')).toBe(false);

    expect(isImplementedInfraProvider('firecracker')).toBe(true);
    expect(isImplementedInfraProvider('gcp')).toBe(false);

    expect(isArchiveHostingProvider('railway')).toBe(true);
    expect(isArchiveHostingProvider('render')).toBe(true);
    expect(isArchiveHostingProvider('fly')).toBe(false);

    expect(infraProviderDescriptor('fly')).toMatchObject({
      isolation: 'microvm',
      supportsSuspend: true,
      suspendMaxMemoryMb: 2048,
      supportsByoAccount: true,
      supportsManagedAccount: true,
    });
    expect(infraProviderDescriptor('aws')).toMatchObject({
      implemented: false,
      isolation: 'microvm',
      supportsSuspend: true,
    });
  });
});

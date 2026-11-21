import { afterAll, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoEgressAllowlist,
  InfraError,
  infraErrorForStatus,
  infraProviderDescriptor,
  isArchiveHostingProvider,
  isImplementedInfraProvider,
  isInfraError,
  isInfraProvider,
  sendInfraRequest,
  sendUnixSocketHttpRequest,
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
    if (path === '/leak-token') {
      return new Response('rejected token super-secret-xyz and Bearer abc.def_123', {
        status: 401,
      });
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

const unixSocketPath = join(tmpdir(), `inixiative-infra-core-${process.pid}.sock`);
const unixServer = Bun.serve({
  unix: unixSocketPath,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/ok') return Response.json({ transport: 'node-http-unix' });
    return new Response('missing', { status: 404 });
  },
});

const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  unixServer.stop(true);
});

describe('core primitives', () => {
  it('enforces redirect:error, timeouts, JSON validation, 204 responses, and unreachable/retryable errors', async () => {
    const echoed = await sendInfraRequest<{ auth: string; body: { hello: string } }>(
      `${baseUrl}/echo`,
      { method: 'POST', token: 'secret-token', body: { hello: 'world' }, provider: 'fly' },
    );
    expect(echoed).toEqual({ auth: 'Bearer secret-token', body: { hello: 'world' } });

    expect(await sendInfraRequest(`${baseUrl}/empty`)).toBeUndefined();

    await expect(
      sendInfraRequest(`${baseUrl}/redirect`, { provider: 'fly' }),
    ).rejects.toMatchObject({ code: 'unreachable', retryable: true, provider: 'fly' });

    const timeoutError = await sendInfraRequest(`${baseUrl}/slow?api_key=leakme`, {
      timeoutMs: 40,
      provider: 'railway',
    }).catch((error: unknown) => error);
    expect(timeoutError).toBeInstanceOf(InfraError);
    expect(timeoutError).toMatchObject({ code: 'unreachable', retryable: true });
    expect((timeoutError as InfraError).message).not.toContain('leakme');

    await expect(
      sendInfraRequest(`${baseUrl}/malformed`, { provider: 'render' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true, provider: 'render' });

    await expect(sendInfraRequest(`${baseUrl}/other`, { provider: 'fly' })).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
      status: 422,
      provider: 'fly',
    });

    // Redacts token and Bearer strings in error excerpts
    const redactedError = await sendInfraRequest(`${baseUrl}/leak-token`, {
      token: 'super-secret-xyz',
      provider: 'fly',
    }).catch((error: unknown) => error);
    expect(redactedError).toBeInstanceOf(InfraError);
    expect(redactedError).toMatchObject({ code: 'authentication_failed', retryable: false });
    expect((redactedError as InfraError).message).not.toContain('super-secret-xyz');
    expect((redactedError as InfraError).message).not.toContain('abc.def_123');

    // Validates timeoutMs
    await expect(sendInfraRequest(`${baseUrl}/empty`, { timeoutMs: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      sendInfraRequest(`${baseUrl}/empty`, { timeoutMs: Number.NaN }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(isInfraError(infraErrorForStatus(401), 'authentication_failed')).toBe(true);
    expect(infraErrorForStatus(401).retryable).toBe(false);
    expect(infraErrorForStatus(429).retryable).toBe(true);
    expect(infraErrorForStatus(500).retryable).toBe(true);
    expect(new InfraError('deploy_failed').retryable).toBe(false);
    expect(isInfraError(new Error('plain'))).toBe(false);
  });

  it('supports Node.js node:http Unix domain socket transport and fails closed on egressAllowlist', async () => {
    const result = await sendUnixSocketHttpRequest<{ transport: string }>(
      'http://localhost/ok',
      unixSocketPath,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: 5_000,
        provider: 'firecracker',
      },
    );
    expect(result).toEqual({ transport: 'node-http-unix' });

    await expect(
      sendUnixSocketHttpRequest('http://localhost/missing', unixSocketPath, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: 5_000,
        provider: 'firecracker',
      }),
    ).rejects.toMatchObject({ code: 'not_found', provider: 'firecracker' });

    expect(() => assertNoEgressAllowlist(['api.anthropic.com'], 'fly')).toThrow(InfraError);
    expect(() => assertNoEgressAllowlist([], 'fly')).not.toThrow();
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

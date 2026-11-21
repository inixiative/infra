import { InfraError } from '../core/infraError.ts';
import { sendInfraRequest, stripTrailingSlash } from '../core/infraFetch.ts';

export const FIRECRACKER_DEFAULT_BASE_URL = 'http://localhost';

export type FirecrackerTransport = {
  readonly apiUrl?: string;
  readonly unixSocketPath?: string;
  readonly token?: string;
};

export type FirecrackerRequestInit = {
  readonly method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  readonly body?: unknown;
  readonly timeoutMs?: number;
};

export const sendFirecrackerRequest = async <T>(
  transport: FirecrackerTransport,
  path: string,
  init: FirecrackerRequestInit = {},
): Promise<T> => {
  if (!transport.unixSocketPath && !transport.apiUrl) {
    throw new InfraError(
      'invalid_request',
      'Firecracker driver requires either unixSocketPath or apiUrl',
      { provider: 'firecracker' },
    );
  }

  const baseUrl = stripTrailingSlash(transport.apiUrl ?? FIRECRACKER_DEFAULT_BASE_URL);
  return sendInfraRequest<T>(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    token: transport.token,
    body: init.body,
    timeoutMs: init.timeoutMs,
    unixSocketPath: transport.unixSocketPath,
    provider: 'firecracker',
  });
};

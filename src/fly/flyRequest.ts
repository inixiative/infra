import { sendInfraRequest, stripTrailingSlash } from '../core/infraFetch.ts';

export const FLY_MACHINES_API_URL = 'https://api.machines.dev/v1';

export type FlyRequestInit = {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly timeoutMs?: number;
};

export const sendFlyRequest = async <T>(
  token: string,
  path: string,
  init: FlyRequestInit = {},
  apiUrl = FLY_MACHINES_API_URL,
): Promise<T> =>
  sendInfraRequest<T>(`${stripTrailingSlash(apiUrl)}${path}`, {
    method: init.method ?? 'GET',
    token,
    body: init.body,
    timeoutMs: init.timeoutMs,
    provider: 'fly',
  });

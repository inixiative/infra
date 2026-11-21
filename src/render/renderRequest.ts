import { ignoreNotFound } from '../core/infraError.ts';
import { sendInfraRequest, stripTrailingSlash } from '../core/infraFetch.ts';

export const RENDER_API_URL = 'https://api.render.com/v1';

export type RenderRequestInit = {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
};

export const sendRenderRequest = async <T>(
  token: string,
  path: string,
  init: RenderRequestInit = {},
  apiUrl = RENDER_API_URL,
): Promise<T> =>
  sendInfraRequest<T>(`${stripTrailingSlash(apiUrl)}${path}`, {
    method: init.method ?? 'GET',
    token,
    body: init.body,
    provider: 'render',
  });

export const deleteRenderResource = async (
  token: string,
  path: string,
  apiUrl?: string,
): Promise<void> => {
  await sendRenderRequest(token, path, { method: 'DELETE' }, apiUrl).catch(ignoreNotFound);
};

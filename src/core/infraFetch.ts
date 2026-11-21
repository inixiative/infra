import { InfraError, infraErrorForStatus } from './infraError.ts';

export const INFRA_REQUEST_TIMEOUT_MS = 30_000;

const MAX_ERROR_BODY_CHARS = 500;

export type InfraFetchOptions = {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly token?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly unixSocketPath?: string;
  readonly provider?: string;
};

type UnixRequestInit = RequestInit & { unix?: string };

const readResponseExcerpt = async (response: Response): Promise<string | undefined> => {
  const text = await response.text().catch(() => '');
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_BODY_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...`
    : trimmed;
};

export const sendInfraRequest = async <T = unknown>(
  url: string,
  options: InfraFetchOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  const init: UnixRequestInit = {
    method: options.method ?? 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? INFRA_REQUEST_TIMEOUT_MS),
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.unixSocketPath ? { unix: options.unixSocketPath } : {}),
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new InfraError('provider_unavailable', `Request to ${url} failed`, {
      provider: options.provider,
      cause,
    });
  }

  if (!response.ok) {
    const excerpt = await readResponseExcerpt(response);
    throw infraErrorForStatus(response.status, {
      provider: options.provider,
      message: excerpt,
    });
  }

  if (response.status === 204) return undefined as T;

  const rawBody = await response.text().catch((cause) => {
    throw new InfraError('provider_unavailable', 'Failed to read response body', {
      status: response.status,
      provider: options.provider,
      cause,
    });
  });

  if (!rawBody.trim()) return undefined as T;

  try {
    return JSON.parse(rawBody) as T;
  } catch (cause) {
    throw new InfraError('provider_unavailable', 'Provider returned malformed JSON', {
      status: response.status,
      provider: options.provider,
      cause,
    });
  }
};

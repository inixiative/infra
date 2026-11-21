import { request as nodeHttpRequest } from 'node:http';
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

export const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

const sanitizeUrlForError = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return rawUrl.split('?')[0]?.split('#')[0] ?? rawUrl;
  }
};

const redactSensitiveText = (text: string, token?: string): string => {
  let sanitized = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  if (token && token.length > 0) {
    sanitized = sanitized.split(token).join('[REDACTED]');
  }
  return sanitized;
};

const formatErrorExcerpt = (text: string, token?: string): string | undefined => {
  const trimmed = redactSensitiveText(text.trim(), token);
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_BODY_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...`
    : trimmed;
};

const validateTimeoutMs = (timeoutMs: number | undefined, provider?: string): number => {
  if (timeoutMs === undefined) return INFRA_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InfraError(
      'invalid_request',
      `timeoutMs must be a finite positive number (got ${timeoutMs})`,
      { provider },
    );
  }
  return timeoutMs;
};

const parseJsonOrEmpty = <T>(rawBody: string, status: number, provider?: string): T => {
  if (status === 204 || !rawBody.trim()) return undefined as T;
  try {
    return JSON.parse(rawBody) as T;
  } catch (cause) {
    throw new InfraError('provider_unavailable', 'Provider returned malformed JSON', {
      status,
      provider,
      cause,
    });
  }
};

export const sendUnixSocketHttpRequest = async <T = unknown>(
  url: string,
  socketPath: string,
  options: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly serializedBody?: string;
    readonly timeoutMs: number;
    readonly token?: string;
    readonly provider?: string;
  },
): Promise<T> => {
  const timeoutMs = validateTimeoutMs(options.timeoutMs, options.provider);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (cause) {
    throw new InfraError('invalid_request', `Invalid request URL: ${sanitizeUrlForError(url)}`, {
      provider: options.provider,
      cause,
    });
  }

  const requestPath = `${parsedUrl.pathname}${parsedUrl.search}`;
  const response = await new Promise<{ readonly status: number; readonly body: string }>(
    (resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const settleResolve = (result: { readonly status: number; readonly body: string }) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        resolve(result);
      };

      const settleReject = (error: InfraError) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        reject(error);
      };

      const req = nodeHttpRequest(
        {
          socketPath,
          method: options.method,
          path: requestPath,
          headers: {
            ...options.headers,
            ...(options.serializedBody !== undefined
              ? { 'Content-Length': String(Buffer.byteLength(options.serializedBody)) }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          });
          res.on('end', () => {
            settleResolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('close', () => {
            if (!res.complete) {
              settleReject(
                new InfraError(
                  'unreachable',
                  `Unix socket response closed prematurely for ${sanitizeUrlForError(url)}`,
                  { provider: options.provider },
                ),
              );
            }
          });
          res.on('error', (cause) => {
            settleReject(
              new InfraError(
                'unreachable',
                `Unix socket response failed for ${sanitizeUrlForError(url)}`,
                { provider: options.provider, cause },
              ),
            );
          });
        },
      );

      deadlineTimer = setTimeout(() => {
        const timeoutCause = new Error(`Unix socket request exceeded deadline of ${timeoutMs}ms`);
        req.destroy(timeoutCause);
        settleReject(
          new InfraError(
            'unreachable',
            `Unix socket request timed out for ${sanitizeUrlForError(url)}`,
            { provider: options.provider, cause: timeoutCause },
          ),
        );
      }, timeoutMs);

      req.on('timeout', () => {
        req.destroy(new Error(`Unix socket request timed out after ${timeoutMs}ms`));
      });
      req.on('error', (cause) => {
        settleReject(
          new InfraError(
            'unreachable',
            `Unix socket request failed for ${sanitizeUrlForError(url)}`,
            {
              provider: options.provider,
              cause,
            },
          ),
        );
      });

      if (options.serializedBody !== undefined) {
        req.write(options.serializedBody);
      }
      req.end();
    },
  );

  if (response.status >= 300 && response.status < 400) {
    throw new InfraError(
      'unreachable',
      `Unexpected redirect (${response.status}) from ${sanitizeUrlForError(url)}`,
      { status: response.status, provider: options.provider },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw infraErrorForStatus(response.status, {
      provider: options.provider,
      message: formatErrorExcerpt(response.body, options.token),
    });
  }

  return parseJsonOrEmpty<T>(response.body, response.status, options.provider);
};

export const sendInfraRequest = async <T = unknown>(
  url: string,
  options: InfraFetchOptions = {},
): Promise<T> => {
  const timeoutMs = validateTimeoutMs(options.timeoutMs, options.provider);
  const method = options.method ?? 'GET';
  const serializedBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(serializedBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  if (options.unixSocketPath && typeof Bun === 'undefined') {
    return sendUnixSocketHttpRequest<T>(url, options.unixSocketPath, {
      method,
      headers,
      serializedBody,
      timeoutMs,
      token: options.token,
      provider: options.provider,
    });
  }

  const init: UnixRequestInit = {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    ...(serializedBody !== undefined ? { body: serializedBody } : {}),
    ...(options.unixSocketPath ? { unix: options.unixSocketPath } : {}),
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new InfraError('unreachable', `Request to ${sanitizeUrlForError(url)} failed`, {
      provider: options.provider,
      cause,
    });
  }

  if (!response.ok) {
    const rawError = await response.text().catch(() => '');
    throw infraErrorForStatus(response.status, {
      provider: options.provider,
      message: formatErrorExcerpt(rawError, options.token),
    });
  }

  if (response.status === 204) return undefined as T;

  const rawBody = await response.text().catch((cause) => {
    throw new InfraError('unreachable', 'Failed to read response body', {
      status: response.status,
      provider: options.provider,
      cause,
    });
  });

  return parseJsonOrEmpty<T>(rawBody, response.status, options.provider);
};

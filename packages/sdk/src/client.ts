import { WithMemoryError, TimeoutError, NetworkError, createError } from "./errors";
import { CacheInstance } from "./cache";
import type { ScopedRequestFn } from "./cache";
import type {
  WithMemoryConfig,
  AddParams,
  AddResponse,
  GetParams,
  GetResponse,
  RecallResponse,
  RemoveParams,
  RemoveResponse,
  HealthResponse,
  WhoamiResponse,
  UsageResponse,
  RecallOptions,
  RegisterDefaults,
  ExtractionPromptResponse,
  ResetExtractionPromptResponse,
  ListOptions,
  ListResponse,
  RequestOptions,
  CreateContainerOptions,
  CreateContainerResponse,
  CreateContainerKeyOptions,
  CreateContainerKeyResponse,
  ListContainersResponse,
  GetContainerOptions,
  GetContainerResponse,
  RevokeContainerKeyOptions,
  RevokeContainerKeyResponse,
  DeleteContainerOptions,
  DeleteContainerResponse,
  CacheCreateOptions,
  CacheCreateResponse,
  CacheClaimOptions,
  CacheClaimResponse,
  RequestCodeParams,
  RequestCodeResponse,
  VerifyCodeParams,
  VerifyCodeResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://api.withmemory.dev";
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_RETRIES = 3;

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

export class WithMemoryClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;
  private maxRetries: number;
  private clientId: string | undefined;
  private registeredDefaults: Record<string, string> = {};

  constructor(config: WithMemoryConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.clientId = config.clientId;
  }

  register(defaults: RegisterDefaults): void {
    this.registeredDefaults = { ...defaults };
  }

  async add(params: AddParams, options?: RequestOptions): Promise<AddResponse> {
    const body: Record<string, unknown> = {
      scope: params.scope,
      value: params.value,
    };
    if (params.key !== undefined) body.key = params.key;
    if (params.importance !== undefined) body.importance = params.importance;
    return this.request<AddResponse>("POST", "/v1/memories", body, options);
  }

  async get(params: GetParams, options?: RequestOptions): Promise<GetResponse> {
    return this.request<GetResponse>(
      "POST",
      "/v1/memories/get",
      {
        scope: params.scope,
        key: params.key,
      },
      options
    );
  }

  async recall(options: RecallOptions, requestOptions?: RequestOptions): Promise<RecallResponse> {
    const mergedDefaults = {
      ...this.registeredDefaults,
      ...(options.defaults ?? {}),
    };
    const body: Record<string, unknown> = {
      scope: options.scope,
      query: options.query,
    };
    if (options.maxItems !== undefined) body.maxItems = options.maxItems;
    if (options.maxTokens !== undefined) body.maxTokens = options.maxTokens;
    if (options.threshold !== undefined) body.threshold = options.threshold;
    if (Object.keys(mergedDefaults).length > 0) body.defaults = mergedDefaults;
    return this.request<RecallResponse>("POST", "/v1/recall", body, requestOptions);
  }

  async remove(params: RemoveParams, options?: RequestOptions): Promise<RemoveResponse> {
    return this.request<RemoveResponse>(
      "POST",
      "/v1/memories/remove",
      {
        scope: params.scope,
        key: params.key,
      },
      options
    );
  }

  async list(options?: ListOptions, requestOptions?: RequestOptions): Promise<ListResponse> {
    const body: Record<string, unknown> = {};
    if (options) {
      if (options.scope !== undefined) body.scope = options.scope;
      if (options.source !== undefined) body.source = options.source;
      if (options.search !== undefined) body.search = options.search;
      if (options.createdAfter !== undefined) body.createdAfter = options.createdAfter;
      if (options.createdBefore !== undefined) body.createdBefore = options.createdBefore;
      if (options.orderBy !== undefined) body.orderBy = options.orderBy;
      if (options.orderDir !== undefined) body.orderDir = options.orderDir;
      if (options.limit !== undefined) body.limit = options.limit;
      if (options.cursor !== undefined) body.cursor = options.cursor;
      if (options.includeTotal !== undefined) body.includeTotal = options.includeTotal;
    }
    return this.request<ListResponse>("POST", "/v1/memories/list", body, requestOptions);
  }

  async delete(memoryId: string, options?: RequestOptions): Promise<RemoveResponse> {
    return this.request<RemoveResponse>("DELETE", `/v1/memories/${memoryId}`, undefined, options);
  }

  async health(options?: RequestOptions): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/health", undefined, options);
  }

  async whoami(options?: RequestOptions): Promise<WhoamiResponse> {
    return this.request<WhoamiResponse>("GET", "/v1/account", undefined, options);
  }

  async usage(options?: RequestOptions): Promise<UsageResponse> {
    return this.request<UsageResponse>("GET", "/v1/account/usage", undefined, options);
  }

  async setExtractionPrompt(
    prompt: string,
    options?: RequestOptions
  ): Promise<ExtractionPromptResponse> {
    return this.request<ExtractionPromptResponse>(
      "POST",
      "/v1/account/extraction-prompt",
      { prompt },
      options
    );
  }

  async getExtractionPrompt(options?: RequestOptions): Promise<ExtractionPromptResponse> {
    return this.request<ExtractionPromptResponse>(
      "GET",
      "/v1/account/extraction-prompt",
      undefined,
      options
    );
  }

  async resetExtractionPrompt(options?: RequestOptions): Promise<ResetExtractionPromptResponse> {
    return this.request<ResetExtractionPromptResponse>(
      "DELETE",
      "/v1/account/extraction-prompt",
      undefined,
      options
    );
  }

  // ─── Containers namespace ────────────────────────────────────────────────
  // Every method returns the full server response envelope (not unwrapped).
  // This is intentionally consistent with the rest of the SDK — callers
  // reach for `response.container`, `response.containers`, `response.key`,
  // etc. and keep `request_id` access for free.
  readonly containers = {
    create: (
      options: CreateContainerOptions,
      requestOptions?: RequestOptions
    ): Promise<CreateContainerResponse> => {
      return this.request<CreateContainerResponse>(
        "POST",
        "/v1/containers",
        options,
        requestOptions
      );
    },

    createKey: (
      options: CreateContainerKeyOptions,
      requestOptions?: RequestOptions
    ): Promise<CreateContainerKeyResponse> => {
      const { containerId, scopes, ...rest } = options;
      const normalizedScopes = Array.isArray(scopes)
        ? scopes.map((s) => s.trim()).join(",")
        : scopes;
      const body: Record<string, unknown> = { ...rest };
      if (normalizedScopes !== undefined) body.scopes = normalizedScopes;
      return this.request<CreateContainerKeyResponse>(
        "POST",
        `/v1/containers/${containerId}/keys`,
        body,
        requestOptions
      );
    },

    list: (requestOptions?: RequestOptions): Promise<ListContainersResponse> => {
      return this.request<ListContainersResponse>(
        "GET",
        "/v1/containers",
        undefined,
        requestOptions
      );
    },

    get: (
      options: GetContainerOptions,
      requestOptions?: RequestOptions
    ): Promise<GetContainerResponse> => {
      return this.request<GetContainerResponse>(
        "GET",
        `/v1/containers/${options.containerId}`,
        undefined,
        requestOptions
      );
    },

    revokeKey: (
      options: RevokeContainerKeyOptions,
      requestOptions?: RequestOptions
    ): Promise<RevokeContainerKeyResponse> => {
      return this.request<RevokeContainerKeyResponse>(
        "DELETE",
        `/v1/containers/${options.containerId}/keys/${options.keyId}`,
        undefined,
        requestOptions
      );
    },

    delete: (
      options: DeleteContainerOptions,
      requestOptions?: RequestOptions
    ): Promise<DeleteContainerResponse> => {
      return this.request<DeleteContainerResponse>(
        "DELETE",
        `/v1/containers/${options.containerId}`,
        { confirm: options.confirm },
        requestOptions
      );
    },
  };

  // ─── Cache namespace ──────────────────────────────────────────────────
  readonly cache = {
    create: async (
      options?: CacheCreateOptions,
      requestOptions?: RequestOptions
    ): Promise<CacheInstance> => {
      const body: Record<string, unknown> = {};
      if (options?.ttlSeconds !== undefined) body.ttlSeconds = options.ttlSeconds;
      const response = await this.requestWithToken<CacheCreateResponse>(
        null,
        "POST",
        "/v1/cache",
        body,
        requestOptions
      );
      const { cache } = response;
      const scopedFn = this.createScopedRequestFn(cache.rawToken);
      return new CacheInstance({
        id: cache.id,
        rawToken: cache.rawToken,
        claimToken: cache.claimToken,
        claimUrl: cache.claimUrl,
        expiresAt: cache.expiresAt,
        requestFn: scopedFn,
      });
    },

    claim: async (
      options: CacheClaimOptions,
      requestOptions?: RequestOptions
    ): Promise<CacheClaimResponse> => {
      return this.request<CacheClaimResponse>(
        "POST",
        "/v1/cache/claim",
        options,
        requestOptions
      );
    },
  };

  // ─── Pre-auth signup flow ─────────────────────────────────────────────
  // requestCode + verifyCode are pre-auth: they work on a client with an
  // empty apiKey. Route through requestWithToken(null, …) which omits the
  // Authorization header entirely. An agent constructs a temporary client
  // (or uses the singleton's pre-auth fallback in index.ts), calls
  // requestCode with an email, asks its principal for the 6-digit code,
  // then calls verifyCode and receives an API key.

  async requestCode(
    params: RequestCodeParams,
    options?: RequestOptions
  ): Promise<RequestCodeResponse> {
    return this.requestWithToken<RequestCodeResponse>(
      null,
      "POST",
      "/v1/auth/request-code",
      { email: params.email },
      options
    );
  }

  async verifyCode(
    params: VerifyCodeParams,
    options?: RequestOptions
  ): Promise<VerifyCodeResponse> {
    const body: Record<string, unknown> = {
      email: params.email,
      code: params.code,
    };
    if (params.issuedTo !== undefined) body.issuedTo = params.issuedTo;
    return this.requestWithToken<VerifyCodeResponse>(
      null,
      "POST",
      "/v1/auth/verify-code",
      body,
      options
    );
  }

  private createScopedRequestFn(token: string): ScopedRequestFn {
    return <T>(
      method: string,
      path: string,
      body?: unknown,
      options?: RequestOptions
    ): Promise<T> => {
      return this.requestWithToken<T>(token, method, path, body, options);
    };
  }

  private async requestWithToken<T>(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeout = options?.timeout ?? this.timeout;
    const maxRetries = options?.maxRetries ?? this.maxRetries;

    let lastError: WithMemoryError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        const jitter = Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          throw new TimeoutError("Request aborted by caller");
        }
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      const headers: Record<string, string> = {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.clientId ? { "X-WithMemory-Client": this.clientId } : {}),
        ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      };
      if (token !== null) {
        headers.Authorization = `Bearer ${token}`;
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new TimeoutError(`Request to ${path} timed out after ${timeout}ms`);
        } else {
          const message = err instanceof Error ? err.message : "Network request failed";
          lastError = new NetworkError(message);
        }
        if (attempt < maxRetries) continue;
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      const requestId = response.headers.get("X-Request-Id") ?? undefined;

      if (!response.ok) {
        let errorBody: {
          error?: { code?: string; message?: string; details?: unknown; request_id?: string };
        };
        try {
          errorBody = (await response.json()) as typeof errorBody;
        } catch {
          lastError = new NetworkError(
            `HTTP ${response.status}: Non-JSON error response from ${path}`,
            { requestId }
          );
          if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) continue;
          throw lastError;
        }

        const code = errorBody.error?.code ?? "network_error";
        const message = errorBody.error?.message ?? `HTTP ${response.status}`;
        const details = errorBody.error?.details;
        const rid = errorBody.error?.request_id ?? requestId;

        lastError = createError(message, { status: response.status, code, details, requestId: rid });

        if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            const seconds = Number.parseInt(retryAfter, 10);
            if (Number.isFinite(seconds) && seconds > 0 && seconds <= 60) {
              await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
            }
          }
          continue;
        }

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) continue;
        throw lastError;
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new NetworkError(`Invalid JSON in response body from ${path}`);
      }
    }

    throw lastError ?? new NetworkError("Request failed after retries");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeout = options?.timeout ?? this.timeout;
    const maxRetries = options?.maxRetries ?? this.maxRetries;

    let lastError: WithMemoryError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Wait before retrying (not on first attempt)
      if (attempt > 0) {
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        const jitter = Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      // Compose caller signal with timeout signal
      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          throw new TimeoutError("Request aborted by caller");
        }
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.clientId ? { "X-WithMemory-Client": this.clientId } : {}),
            ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new TimeoutError(`Request to ${path} timed out after ${timeout}ms`);
        } else {
          const message = err instanceof Error ? err.message : "Network request failed";
          lastError = new NetworkError(message);
        }
        // Network errors and timeouts are retryable
        if (attempt < maxRetries) continue;
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      // Read request ID from response header
      const requestId = response.headers.get("X-Request-Id") ?? undefined;

      if (!response.ok) {
        let errorBody: {
          error?: { code?: string; message?: string; details?: unknown; request_id?: string };
        };
        try {
          errorBody = (await response.json()) as typeof errorBody;
        } catch {
          lastError = new NetworkError(
            `HTTP ${response.status}: Non-JSON error response from ${path}`,
            { requestId }
          );
          if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) continue;
          throw lastError;
        }

        const code = errorBody.error?.code ?? "network_error";
        const message = errorBody.error?.message ?? `HTTP ${response.status}`;
        const details = errorBody.error?.details;
        const rid = errorBody.error?.request_id ?? requestId;

        lastError = createError(message, {
          status: response.status,
          code,
          details,
          requestId: rid,
        });

        // Retry-After header support for 429 and 503
        if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            const seconds = Number.parseInt(retryAfter, 10);
            if (Number.isFinite(seconds) && seconds > 0 && seconds <= 60) {
              await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
            }
          }
          continue;
        }

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) continue;
        throw lastError;
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new NetworkError(`Invalid JSON in response body from ${path}`);
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError ?? new NetworkError("Request failed after retries");
  }
}

export function createClient(config: WithMemoryConfig): WithMemoryClient {
  return new WithMemoryClient(config);
}

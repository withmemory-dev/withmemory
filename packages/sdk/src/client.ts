import { WithMemoryError } from "./errors";
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
  RecallOptions,
  RegisterDefaults,
  ExtractionPromptResponse,
  ResetExtractionPromptResponse,
  ListOptions,
  ListResponse,
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
} from "./types";

const DEFAULT_BASE_URL = "https://api.withmemory.dev";
const DEFAULT_TIMEOUT = 30_000;

export class WithMemoryClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;
  private registeredDefaults: Record<string, string> = {};

  constructor(config: WithMemoryConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  register(defaults: RegisterDefaults): void {
    this.registeredDefaults = { ...defaults };
  }

  async add(params: AddParams): Promise<AddResponse> {
    const body: Record<string, unknown> = {
      forScope: params.forScope,
      value: params.value,
    };
    if (params.forKey !== undefined) body.forKey = params.forKey;
    return this.request<AddResponse>("POST", "/v1/memories", body);
  }

  async get(params: GetParams): Promise<GetResponse> {
    return this.request<GetResponse>("POST", "/v1/memories/get", {
      forScope: params.forScope,
      forKey: params.forKey,
    });
  }

  async recall(options: RecallOptions): Promise<RecallResponse> {
    const mergedDefaults = {
      ...this.registeredDefaults,
      ...(options.defaults ?? {}),
    };
    const body: Record<string, unknown> = {
      forScope: options.forScope,
      query: options.query,
    };
    if (options.maxItems !== undefined) body.maxItems = options.maxItems;
    if (options.maxTokens !== undefined) body.maxTokens = options.maxTokens;
    if (Object.keys(mergedDefaults).length > 0) body.defaults = mergedDefaults;
    return this.request<RecallResponse>("POST", "/v1/recall", body);
  }

  async remove(params: RemoveParams): Promise<RemoveResponse> {
    return this.request<RemoveResponse>("POST", "/v1/memories/remove", {
      forScope: params.forScope,
      forKey: params.forKey,
    });
  }

  async list(options?: ListOptions): Promise<ListResponse> {
    const body: Record<string, unknown> = {};
    if (options) {
      if (options.forScope !== undefined) body.forScope = options.forScope;
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
    return this.request<ListResponse>("POST", "/v1/memories/list", body);
  }

  async deleteMemory(memoryId: string): Promise<RemoveResponse> {
    return this.request<RemoveResponse>("DELETE", `/v1/memories/${memoryId}`);
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/health");
  }

  async setExtractionPrompt(prompt: string): Promise<ExtractionPromptResponse> {
    return this.request<ExtractionPromptResponse>("POST", "/v1/account/extraction-prompt", {
      prompt,
    });
  }

  async getExtractionPrompt(): Promise<ExtractionPromptResponse> {
    return this.request<ExtractionPromptResponse>("GET", "/v1/account/extraction-prompt");
  }

  async resetExtractionPrompt(): Promise<ResetExtractionPromptResponse> {
    return this.request<ResetExtractionPromptResponse>("DELETE", "/v1/account/extraction-prompt");
  }

  // ─── Containers namespace ────────────────────────────────────────────────
  readonly containers = {
    create: (options: CreateContainerOptions): Promise<CreateContainerResponse> => {
      return this.request<CreateContainerResponse>("POST", "/v1/containers", options);
    },

    createKey: (options: CreateContainerKeyOptions): Promise<CreateContainerKeyResponse> => {
      const { forContainer, ...body } = options;
      return this.request<CreateContainerKeyResponse>(
        "POST",
        `/v1/containers/${forContainer}/keys`,
        body
      );
    },

    list: (): Promise<ListContainersResponse> => {
      return this.request<ListContainersResponse>("GET", "/v1/containers");
    },

    get: (options: GetContainerOptions): Promise<GetContainerResponse> => {
      return this.request<GetContainerResponse>("GET", `/v1/containers/${options.forContainer}`);
    },

    revokeKey: (options: RevokeContainerKeyOptions): Promise<RevokeContainerKeyResponse> => {
      return this.request<RevokeContainerKeyResponse>(
        "DELETE",
        `/v1/containers/${options.forContainer}/keys/${options.forKey}`
      );
    },

    delete: (options: DeleteContainerOptions): Promise<DeleteContainerResponse> => {
      return this.request<DeleteContainerResponse>(
        "DELETE",
        `/v1/containers/${options.forContainer}`,
        { confirm: options.confirm }
      );
    },
  };

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new WithMemoryError(
          0,
          "timeout",
          `Request to ${path} timed out after ${this.timeout}ms`
        );
      }
      const message = err instanceof Error ? err.message : "Network request failed";
      throw new WithMemoryError(0, "network_error", message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: { error?: { code?: string; message?: string; details?: unknown } };
      try {
        errorBody = (await response.json()) as typeof errorBody;
      } catch {
        throw new WithMemoryError(
          response.status,
          "network_error",
          `HTTP ${response.status}: Non-JSON error response from ${path}`
        );
      }

      const code = errorBody.error?.code ?? "network_error";
      const message = errorBody.error?.message ?? `HTTP ${response.status}`;
      const details = errorBody.error?.details;
      throw new WithMemoryError(response.status, code, message, details);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new WithMemoryError(
        response.status,
        "network_error",
        `Invalid JSON in response body from ${path}`
      );
    }
  }
}

export function createClient(config: WithMemoryConfig): WithMemoryClient {
  return new WithMemoryClient(config);
}

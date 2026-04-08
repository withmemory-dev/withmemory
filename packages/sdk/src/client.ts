import { WithMemoryError } from "./errors";
import type {
  WithMemoryConfig,
  Memory,
  SetResponse,
  GetResponse,
  RecallResponse,
  RemoveResponse,
  HealthResponse,
  RecallOptions,
  CommitOptions,
  RegisterDefaults,
} from "./types";

const DEFAULT_BASE_URL = "https://api.withmemory.dev";
const DEFAULT_TIMEOUT = 30_000;

export class WithMemoryClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

  constructor(config: WithMemoryConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  // No-op until Session 3 adds server-side defaults support. The method
  // signature is stable — it will forward defaults in the recall request
  // body when the server accepts them.
  register(_defaults: RegisterDefaults): void {}


  async set(userId: string, key: string, value: string): Promise<SetResponse> {
    return this.request<SetResponse>("POST", "/v1/set", { userId, key, value });
  }

  async get(userId: string, key: string): Promise<GetResponse> {
    return this.request<GetResponse>("POST", "/v1/get", { userId, key });
  }

  async recall(options: RecallOptions): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/v1/recall", options);
  }

  async remove(userId: string, key: string): Promise<RemoveResponse> {
    return this.request<RemoveResponse>("POST", "/v1/remove", { userId, key });
  }

  async commit(options: CommitOptions): Promise<void> {
    try {
      await this.request<void>("POST", "/v1/commit", options);
    } catch (err: unknown) {
      console.warn(
        "[@withmemory/sdk] commit() failed silently:",
        err instanceof Error ? err.message : err
      );
    }
  }

  async getUserMemories(userId: string): Promise<Memory[]> {
    const result = await this.request<{ memories: Memory[] }>("POST", "/v1/memories", { userId });
    return result.memories;
  }

  async deleteMemory(memoryId: string): Promise<RemoveResponse> {
    return this.request<RemoveResponse>("DELETE", `/v1/memories/${memoryId}`);
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/health");
  }

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
        throw new WithMemoryError(0, "timeout", `Request to ${path} timed out after ${this.timeout}ms`);
      }
      const message = err instanceof Error ? err.message : "Network request failed";
      throw new WithMemoryError(0, "network_error", message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: { error?: { code?: string; message?: string; details?: unknown } };
      try {
        errorBody = await response.json() as typeof errorBody;
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

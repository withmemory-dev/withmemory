import type {
  RequestOptions,
  CacheSetResponse,
  CacheGetResponse,
  CacheDeleteResponse,
  CacheListResponse,
} from "./types";

export type ScopedRequestFn = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions
) => Promise<T>;

export class CacheInstance {
  readonly id: string;
  readonly claimToken: string;
  readonly claimUrl: string;
  readonly expiresAt: string;

  private readonly requestFn: ScopedRequestFn;

  constructor(params: {
    id: string;
    rawToken: string;
    claimToken: string;
    claimUrl: string;
    expiresAt: string;
    requestFn: ScopedRequestFn;
  }) {
    this.id = params.id;
    this.claimToken = params.claimToken;
    this.claimUrl = params.claimUrl;
    this.expiresAt = params.expiresAt;
    this.requestFn = params.requestFn;
  }

  async set(
    params: { key: string; value: string },
    options?: RequestOptions
  ): Promise<CacheSetResponse> {
    return this.requestFn("POST", "/v1/cache/set", params, options);
  }

  async get(params: { key: string }, options?: RequestOptions): Promise<CacheGetResponse> {
    return this.requestFn("POST", "/v1/cache/get", params, options);
  }

  async delete(params: { key: string }, options?: RequestOptions): Promise<CacheDeleteResponse> {
    return this.requestFn("POST", "/v1/cache/delete", params, options);
  }

  async list(options?: RequestOptions): Promise<CacheListResponse> {
    return this.requestFn("GET", "/v1/cache/list", undefined, options);
  }
}

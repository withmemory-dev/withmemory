export interface WithMemoryConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

export interface Memory {
  id: string;
  userId: string;
  key: string | null;
  value: string;
  source: "explicit" | "extracted";
  createdAt: string;
  updatedAt: string;
}

export interface SetResponse {
  memory: Memory;
}

export interface GetResponse {
  memory: Memory | null;
}

export interface RecallResponse {
  promptBlock: string;
  memories: Memory[];
  ranking: {
    strategy: "semantic" | "recency_importance" | "user_not_found";
    reason?: "embedding_unavailable";
  };
}

export interface ExtractionPromptResponse {
  prompt: string | null;
  source: "custom" | "default";
}

export interface ResetExtractionPromptResponse {
  reset: boolean;
}

export interface RemoveResponse {
  deleted: boolean;
}

export interface HealthResponse {
  status: "ok";
  version: string;
}

export interface RecallOptions {
  userId: string;
  input: string;
  maxItems?: number;
  maxTokens?: number;
  defaults?: Record<string, string>;
}

export interface CommitOptions {
  userId: string;
  input: string;
  output: string;
}

export interface RegisterDefaults {
  [key: string]: string;
}

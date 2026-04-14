export { WithMemoryClient, createClient } from "./client";
export { WithMemoryError } from "./errors";
export type {
  WithMemoryConfig,
  Memory,
  SetParams,
  SetResponse,
  GetParams,
  GetResponse,
  RemoveParams,
  RecallResponse,
  RemoveResponse,
  HealthResponse,
  RecallOptions,
  CommitOptions,
  RegisterDefaults,
  ExtractionPromptResponse,
  ResetExtractionPromptResponse,
  ListOptions,
  ListResponse,
  Container,
  ContainerKey,
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

import { WithMemoryClient } from "./client";
import type {
  WithMemoryConfig,
  RegisterDefaults,
  RecallOptions,
  CommitOptions,
  SetParams,
  GetParams,
  RemoveParams,
  ListOptions,
} from "./types";

// ─── Default singleton ──────────────────────────────────────────────────────
// Usage:
//   import { memory } from '@withmemory/sdk';
//   memory.configure({ apiKey: 'wm_...' });
//   await memory.set({ value: 'Alice', forKey: 'name', forScope: 'user_1' });

let instance: WithMemoryClient | null = null;

function getInstance(): WithMemoryClient {
  if (!instance) {
    throw new Error(
      "WithMemory SDK not configured. Call memory.configure({ apiKey: '...' }) before use."
    );
  }
  return instance;
}

export const memory = {
  configure(config: WithMemoryConfig): void {
    instance = new WithMemoryClient(config);
  },

  register(defaults: RegisterDefaults): void {
    getInstance().register(defaults);
  },

  set(params: SetParams) {
    return getInstance().set(params);
  },

  get(params: GetParams) {
    return getInstance().get(params);
  },

  recall(options: RecallOptions) {
    return getInstance().recall(options);
  },

  remove(params: RemoveParams) {
    return getInstance().remove(params);
  },

  commit(options: CommitOptions) {
    return getInstance().commit(options);
  },

  list(options?: ListOptions) {
    return getInstance().list(options);
  },

  deleteMemory(memoryId: string) {
    return getInstance().deleteMemory(memoryId);
  },

  health() {
    return getInstance().health();
  },

  setExtractionPrompt(prompt: string) {
    return getInstance().setExtractionPrompt(prompt);
  },

  getExtractionPrompt() {
    return getInstance().getExtractionPrompt();
  },

  resetExtractionPrompt() {
    return getInstance().resetExtractionPrompt();
  },

  get containers() {
    return getInstance().containers;
  },
};

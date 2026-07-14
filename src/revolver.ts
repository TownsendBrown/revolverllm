import type { RevolverApi } from "../shared/types";
import { createWebApi } from "./webApi";

export type {
  CatalogModel,
  ChatConversation,
  ChatMessage,
  ConversationDetail,
  ConversationMeta,
  CreateServerRequest,
  EngineConfigField,
  EngineId,
  EngineInfo,
  GpuInfo,
  GpuMode,
  HubModel,
  InferenceBackend,
  LocalGgufModel,
  LoadProgress,
  LoadedModelState,
  LocalPaths,
  LocalSettings,
  MonitorSnapshot,
  RevolverConfig,
  RuntimeConfig,
  ServerConfig,
  ServerDefinition,
  ServerInstanceStatus,
  ServerLoadPhase,
  ServerStatus,
  SendMessageOptions,
  StreamDelta,
  SystemInfo,
  VramEstimate,
} from "../shared/types";

export const api: RevolverApi =
  typeof window !== "undefined" && window.revolver ? window.revolver : createWebApi();

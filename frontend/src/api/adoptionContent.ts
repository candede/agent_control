import { request } from "./client";
import type { SharedLearningPage } from "../../../backend/src/types/adoptionContent";
export type { SharedLearningPage };
export function readSharedLearning(options: { id?: string; company?: string; department?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
  return request<SharedLearningPage>("/api/discovery/learning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options), signal });
}

/**
 * LLM Model Configuration
 * 
 * Models are fetched dynamically from the OpenClaw Gateway rather than
 * being hardcoded here. The Gateway knows which models are available
 * through its configured providers (e.g. OpenRouter).
 * 
 * This module provides:
 * - The default model ID for new agents
 * - A cached fetcher to get available models from the Gateway
 */

import { getOpenClawClient } from '@/lib/openclaw/client';
import type { GatewayModel } from '@/lib/types';

/** Default model for all new agents */
export const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

/** Cached models and timestamp */
let cachedModels: GatewayModel[] | null = null;
let cacheTimestamp = 0;

/** Cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch available models from the OpenClaw Gateway.
 * Results are cached for 5 minutes to avoid hitting the Gateway on every request.
 * 
 * @param forceRefresh - Bypass the cache and fetch fresh data
 * @returns Array of available models, or empty array if Gateway is unavailable
 */
export async function fetchAvailableModels(forceRefresh = false): Promise<GatewayModel[]> {
  const now = Date.now();

  // Return cached results if still fresh
  if (!forceRefresh && cachedModels && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    const models = await client.listModels();
    cachedModels = models;
    cacheTimestamp = now;

    console.log(`[Models] Fetched ${models.length} model(s) from Gateway`);
    return models;
  } catch (err) {
    console.error('[Models] Failed to fetch models from Gateway:', err instanceof Error ? err.message : err);

    // Return stale cache if available, otherwise empty
    if (cachedModels) {
      console.log('[Models] Returning stale cached models');
      return cachedModels;
    }

    return [];
  }
}

/**
 * Invalidate the model cache.
 * Call this if you know the Gateway's model list has changed.
 */
export function invalidateModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}

/**
 * Models API
 * 
 * GET /api/models - List available LLM models from the OpenClaw Gateway
 * POST /api/models/refresh - Force refresh the model cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_MODEL, fetchAvailableModels, invalidateModelCache } from '@/lib/models';

/**
 * GET /api/models
 * Returns available models fetched from the OpenClaw Gateway.
 * Results are cached for 5 minutes.
 */
export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get('refresh') === 'true';

    if (forceRefresh) {
      invalidateModelCache();
    }

    const models = await fetchAvailableModels(forceRefresh);

    return NextResponse.json({
      default: DEFAULT_MODEL,
      models,
      source: 'gateway',
      count: models.length,
    });
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch models', default: DEFAULT_MODEL, models: [] },
      { status: 502 }
    );
  }
}

/**
 * POST /api/models
 * Force-refresh the model cache from the Gateway.
 */
export async function POST() {
  try {
    invalidateModelCache();
    const models = await fetchAvailableModels(true);

    return NextResponse.json({
      success: true,
      default: DEFAULT_MODEL,
      models,
      count: models.length,
    });
  } catch (error) {
    console.error('Failed to refresh models:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to refresh models' },
      { status: 502 }
    );
  }
}

/**
 * Agent Monitor Status API
 * 
 * GET  /api/monitor - Get monitor status and active sessions
 * POST /api/monitor - Control the monitor (resume/stop)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentMonitor } from '@/lib/agent-monitor';

/**
 * GET /api/monitor
 * Returns the current status of the agent session monitor.
 */
export async function GET() {
  try {
    const monitor = getAgentMonitor();
    const status = monitor.getStatus();

    return NextResponse.json({
      ...status,
      description: 'Agent Session Monitor polls OpenClaw Gateway for agent messages and logs activities automatically.',
    });
  } catch (error) {
    console.error('Failed to get monitor status:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get monitor status' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/monitor
 * Control the monitor.
 * 
 * Body:
 *   { "action": "resume" }  - Re-scan database and resume monitoring in-progress tasks
 *   { "action": "stop", "taskId": "..." } - Stop monitoring a specific task
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const monitor = getAgentMonitor();

    switch (body.action) {
      case 'resume': {
        monitor.resumeFromDatabase();
        const status = monitor.getStatus();
        return NextResponse.json({
          success: true,
          message: 'Monitor resumed from database',
          ...status,
        });
      }

      case 'stop': {
        if (!body.taskId) {
          return NextResponse.json(
            { error: 'taskId is required for stop action' },
            { status: 400 }
          );
        }
        monitor.stopMonitoring(body.taskId);
        return NextResponse.json({
          success: true,
          message: `Stopped monitoring task ${body.taskId}`,
        });
      }

      default:
        return NextResponse.json(
          { error: 'Invalid action. Use "resume" or "stop"' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Monitor control error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Monitor control failed' },
      { status: 500 }
    );
  }
}

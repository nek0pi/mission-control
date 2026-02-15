import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { getAgentMonitor } from '@/lib/agent-monitor';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { DEFAULT_MODEL } from '@/lib/models';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Build a system prompt for the agent based on its configuration and the task context.
 * This is sent to the Gateway so the LLM knows its role and how to behave.
 */
function buildSystemPrompt(agent: Agent, task: Task & { assigned_agent_name?: string }): string {
  const parts: string[] = [];

  parts.push(`You are ${agent.name}, a specialized AI agent.`);
  parts.push(`Role: ${agent.role}`);

  if (agent.description) {
    parts.push(`\nDescription: ${agent.description}`);
  }

  if (agent.soul_md) {
    parts.push(`\n${agent.soul_md}`);
  }

  parts.push(`\nYou are working within the Mission Control system.`);
  parts.push(`Your task ID is: ${task.id}`);
  parts.push(`You should focus on completing the assigned task thoroughly and report back when done.`);
  parts.push(`When you finish your work, include "TASK_COMPLETE: [brief summary]" in your final message.`);

  return parts.join('\n');
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent's OpenClaw session.
 * Creates a properly configured LLM-backed session on the Gateway,
 * then sends the task details to the agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json(
        { error: 'Task has no assigned agent' },
        { status: 400 }
      );
    }

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [task.assigned_agent_id]
    );

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    // Connect to OpenClaw Gateway
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to OpenClaw Gateway:', err);
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    // Get or create OpenClaw session for this agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active']
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
      
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, task_id, openclaw_session_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, task.id, openclawSessionId, 'mission-control', 'active', now, now]
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId]
      );

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now]
      );
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Failed to create agent session' },
        { status: 500 }
      );
    }

    // Build task message for agent
    const priorityEmoji = {
      low: '🔵',
      normal: '⚪',
      high: '🟡',
      urgent: '🔴'
    }[task.priority] || '⚪';

    // Build a relative directory name for this task's deliverables.
    // Fallback to the task ID if the title has no alphanumeric characters.
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      || `task-${task.id}`;
    const missionControlUrl = getMissionControlUrl();

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}

**DELIVERABLE DIRECTORY (relative):** ${projectDir}/
Use this as the relative path prefix when uploading deliverables.

**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Upload & register deliverable (single call):
   POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {
     "deliverable_type": "file",
     "title": "Descriptive name",
     "relative_path": "${projectDir}/filename.html",
     "content": "<full file content here>",
     "description": "optional description"
   }
   The server saves the file and registers it automatically.
   You may call this endpoint multiple times for multiple files.
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask me (Charlie).`;

    // Create the agent's chat session on the Gateway and send the task message
    try {
      // Use sessionKey for routing to the agent's session
      // Format: agent:main:{openclaw_session_id}
      const sessionKey = `agent:main:${session.openclaw_session_id}`;
      const agentModel = agent.model || DEFAULT_MODEL;

      // Build system prompt from the agent's configuration
      const systemPrompt = buildSystemPrompt(agent, task);

      // CRITICAL: Create a properly configured LLM-backed session on the Gateway.
      // Without this, chat.send goes to a session with no model behind it.
      console.log(`[Dispatch] Creating Gateway session: ${sessionKey} with model: ${agentModel}`);
      try {
        await client.createChatSession({
          sessionKey,
          model: agentModel,
          systemPrompt,
        });
        console.log(`[Dispatch] Gateway session created successfully`);
      } catch (createErr) {
        // Session might already exist (e.g. re-dispatch) - log but continue
        console.warn(`[Dispatch] chat.create returned:`, createErr instanceof Error ? createErr.message : createErr);
        console.log(`[Dispatch] Continuing with chat.send (session may already exist)`);
      }

      // Update task status to in_progress BEFORE sending so the UI
      // reflects the correct state while the agent works.
      run(
        'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
        ['in_progress', now, id]
      );

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Log dispatch event
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_dispatched',
          agent.id,
          task.id,
          `Task "${task.title}" dispatched to ${agent.name}`,
          now
        ]
      );

      // Start monitoring BEFORE sending the message so that event
      // listeners are attached and will capture streaming tool calls,
      // chat messages, and agent lifecycle events in real-time.
      const monitor = getAgentMonitor();
      monitor.startMonitoring({
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        openclawSessionId: session.openclaw_session_id,
      });

      // Fire chat.send in the background — do NOT await.
      // The Gateway streams events while the agent works, and the
      // AgentMonitor picks them up via WebSocket event listeners.
      // The RPC response (with the full transcript) only arrives
      // after the agent finishes, so awaiting it here would block
      // the HTTP response for the entire agent execution time.
      client.call('chat.send', {
        sessionKey,
        message: taskMessage,
        idempotencyKey: `dispatch-${task.id}-${Date.now()}`
      }).catch((err) => {
        console.error(`[Dispatch] Background chat.send failed for task "${task.id}":`, err);
      });

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent'
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      return NextResponse.json(
        { error: `Failed to send task to agent: ${err instanceof Error ? err.message : 'Unknown error'}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to dispatch task' },
      { status: 500 }
    );
  }
}

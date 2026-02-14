/**
 * Agent Session Monitor
 * 
 * Background service that polls OpenClaw Gateway for agent session messages
 * after tasks are dispatched. Bridges agent activity back to Mission Control by:
 * 
 * 1. Polling chat.history for active agent sessions
 * 2. Detecting new messages and logging them as task activities
 * 3. Detecting TASK_COMPLETE patterns and triggering the completion workflow
 * 4. Broadcasting real-time updates via SSE
 * 
 * This solves the "fire and forget" gap where tasks are dispatched to agents
 * but no one monitors for their responses.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

/** How often to poll for new messages (in milliseconds) */
const POLL_INTERVAL_MS = 5_000;

/** Maximum number of messages to fetch per poll */
const HISTORY_LIMIT = 50;

/** State tracked per monitored session */
interface MonitoredSession {
  taskId: string;
  agentId: string;
  agentName: string;
  openclawSessionId: string;
  sessionKey: string;
  /** Number of assistant messages we've already processed */
  lastSeenMessageCount: number;
  /** Timestamp when monitoring started */
  startedAt: number;
  /** Consecutive errors encountered (for backoff) */
  errorCount: number;
}

/**
 * Singleton Agent Session Monitor
 */
class AgentSessionMonitor {
  private monitoredSessions = new Map<string, MonitoredSession>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  /**
   * Start monitoring an agent session for a dispatched task.
   * Called after a task is successfully dispatched to an agent.
   */
  startMonitoring(params: {
    taskId: string;
    agentId: string;
    agentName: string;
    openclawSessionId: string;
  }): void {
    const sessionKey = `agent:main:${params.openclawSessionId}`;

    // Don't double-monitor the same task
    if (this.monitoredSessions.has(params.taskId)) {
      console.log(`[AgentMonitor] Already monitoring task ${params.taskId}`);
      return;
    }

    this.monitoredSessions.set(params.taskId, {
      taskId: params.taskId,
      agentId: params.agentId,
      agentName: params.agentName,
      openclawSessionId: params.openclawSessionId,
      sessionKey,
      lastSeenMessageCount: 0,
      startedAt: Date.now(),
      errorCount: 0,
    });

    console.log(
      `[AgentMonitor] Started monitoring task "${params.taskId}" ` +
      `via session "${params.openclawSessionId}" (${this.monitoredSessions.size} active)`
    );

    // Ensure the polling loop is running
    this.ensurePolling();
  }

  /**
   * Stop monitoring a specific task (e.g., on completion or cancellation).
   */
  stopMonitoring(taskId: string): void {
    const session = this.monitoredSessions.get(taskId);
    if (session) {
      this.monitoredSessions.delete(taskId);
      console.log(
        `[AgentMonitor] Stopped monitoring task "${taskId}" ` +
        `(${this.monitoredSessions.size} remaining)`
      );
    }

    // Stop polling if no sessions remain
    if (this.monitoredSessions.size === 0) {
      this.stopPolling();
    }
  }

  /**
   * Resume monitoring for all in-progress tasks on startup.
   * Called when the application initializes to pick up any
   * tasks that were dispatched before a restart.
   */
  resumeFromDatabase(): void {
    try {
      const inProgressTasks = queryAll<Task & {
        assigned_agent_name: string;
        openclaw_session_id: string;
      }>(
        `SELECT t.*, a.name as assigned_agent_name, os.openclaw_session_id
         FROM tasks t
         JOIN agents a ON t.assigned_agent_id = a.id
         JOIN openclaw_sessions os ON os.task_id = t.id AND os.status = 'active'
         WHERE t.status = 'in_progress' AND t.assigned_agent_id IS NOT NULL`
      );

      for (const task of inProgressTasks) {
        if (task.assigned_agent_id && task.openclaw_session_id) {
          this.startMonitoring({
            taskId: task.id,
            agentId: task.assigned_agent_id,
            agentName: task.assigned_agent_name,
            openclawSessionId: task.openclaw_session_id,
          });
        }
      }

      if (inProgressTasks.length > 0) {
        console.log(`[AgentMonitor] Resumed monitoring for ${inProgressTasks.length} in-progress task(s)`);
      }
    } catch (err) {
      console.error('[AgentMonitor] Failed to resume from database:', err);
    }
  }

  /**
   * Get status of all monitored sessions (for debugging / API).
   */
  getStatus(): {
    active: boolean;
    sessionCount: number;
    sessions: Array<{
      taskId: string;
      agentName: string;
      sessionKey: string;
      lastSeenMessageCount: number;
      monitoringForMs: number;
    }>;
  } {
    return {
      active: this.pollTimer !== null,
      sessionCount: this.monitoredSessions.size,
      sessions: Array.from(this.monitoredSessions.values()).map((s) => ({
        taskId: s.taskId,
        agentName: s.agentName,
        sessionKey: s.sessionKey,
        lastSeenMessageCount: s.lastSeenMessageCount,
        monitoringForMs: Date.now() - s.startedAt,
      })),
    };
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private ensurePolling(): void {
    if (this.pollTimer) return;

    console.log(`[AgentMonitor] Starting poll loop (every ${POLL_INTERVAL_MS / 1000}s)`);
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);

    // Also do an immediate first poll
    this.pollAll();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[AgentMonitor] Poll loop stopped (no active sessions)');
    }
  }

  /**
   * Poll all monitored sessions for new messages.
   */
  private async pollAll(): Promise<void> {
    // Prevent overlapping poll cycles
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const client = getOpenClawClient();
      if (!client.isConnected()) {
        try {
          await client.connect();
        } catch (err) {
          console.warn('[AgentMonitor] Gateway not connected, will retry next cycle');
          return;
        }
      }

      // Poll each session concurrently
      const tasks = Array.from(this.monitoredSessions.values()).map((session) =>
        this.pollSession(client, session)
      );
      await Promise.allSettled(tasks);
    } catch (err) {
      console.error('[AgentMonitor] Poll cycle error:', err);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll a single agent session for new messages.
   */
  private async pollSession(
    client: ReturnType<typeof getOpenClawClient>,
    session: MonitoredSession
  ): Promise<void> {
    try {
      // First, verify the task is still in a monitorable state
      const task = queryOne<Task>(
        'SELECT * FROM tasks WHERE id = ?',
        [session.taskId]
      );

      if (!task || !['assigned', 'in_progress'].includes(task.status)) {
        console.log(
          `[AgentMonitor] Task "${session.taskId}" no longer active (status: ${task?.status ?? 'deleted'}), stopping monitor`
        );
        this.stopMonitoring(session.taskId);
        return;
      }

      // Fetch message history from the agent's session
      const result = await client.call<{
        messages: Array<{
          role: string;
          content: Array<{ type: string; text?: string }>;
        }>;
      }>('chat.history', {
        sessionKey: session.sessionKey,
        limit: HISTORY_LIMIT,
      });

      const allMessages = result.messages || [];

      // Extract assistant messages
      const assistantMessages: string[] = [];
      for (const msg of allMessages) {
        if (msg.role === 'assistant') {
          const textContent = msg.content?.find((c) => c.type === 'text');
          if (textContent?.text) {
            assistantMessages.push(textContent.text);
          }
        }
      }

      // Check if there are new messages since last poll
      const newMessageCount = assistantMessages.length - session.lastSeenMessageCount;
      if (newMessageCount <= 0) {
        // No new messages, reset error count on successful poll
        session.errorCount = 0;
        return;
      }

      console.log(
        `[AgentMonitor] ${newMessageCount} new message(s) from "${session.agentName}" for task "${session.taskId}"`
      );

      // Process only the new messages
      const newMessages = assistantMessages.slice(session.lastSeenMessageCount);
      session.lastSeenMessageCount = assistantMessages.length;
      session.errorCount = 0;

      for (const messageText of newMessages) {
        await this.processAgentMessage(session, messageText);
      }
    } catch (err) {
      session.errorCount++;
      // Only log errors occasionally to avoid spam
      if (session.errorCount <= 3 || session.errorCount % 10 === 0) {
        console.error(
          `[AgentMonitor] Error polling session "${session.openclawSessionId}" ` +
          `(attempt ${session.errorCount}):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  /**
   * Process a new message from an agent.
   * Logs activity and checks for completion signals.
   */
  private async processAgentMessage(
    session: MonitoredSession,
    messageText: string
  ): Promise<void> {
    const now = new Date().toISOString();

    // Check for TASK_COMPLETE pattern
    const completionMatch = messageText.match(/TASK_COMPLETE:\s*(.+)/i);

    if (completionMatch) {
      const summary = completionMatch[1].trim();
      await this.handleTaskCompletion(session, summary, now);
      return;
    }

    // Otherwise, log as a progress activity
    // Truncate long messages for the activity feed
    const truncated =
      messageText.length > 500
        ? messageText.substring(0, 497) + '...'
        : messageText;

    // Create activity record
    const activityId = uuidv4();
    try {
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, session.taskId, session.agentId, 'updated', truncated, now]
      );

      // Fetch the activity with agent info for SSE broadcast
      const agent = queryOne<Agent>(
        'SELECT * FROM agents WHERE id = ?',
        [session.agentId]
      );

      broadcast({
        type: 'activity_logged',
        payload: {
          id: activityId,
          task_id: session.taskId,
          agent_id: session.agentId,
          activity_type: 'updated' as const,
          message: truncated,
          created_at: now,
          agent: agent
            ? {
                id: agent.id,
                name: agent.name,
                avatar_emoji: agent.avatar_emoji,
                role: agent.role,
                status: agent.status,
                is_master: agent.is_master,
                workspace_id: agent.workspace_id,
                description: agent.description || '',
                created_at: agent.created_at,
                updated_at: agent.updated_at,
              }
            : undefined,
        },
      });

      console.log(`[AgentMonitor] Activity logged for task "${session.taskId}": ${truncated.substring(0, 80)}...`);
    } catch (err) {
      console.error('[AgentMonitor] Failed to log activity:', err);
    }
  }

  /**
   * Handle the TASK_COMPLETE signal from an agent.
   * Moves task to testing, logs completion, updates agent status.
   */
  private async handleTaskCompletion(
    session: MonitoredSession,
    summary: string,
    now: string
  ): Promise<void> {
    console.log(
      `[AgentMonitor] Task "${session.taskId}" completed by "${session.agentName}": ${summary}`
    );

    try {
      // Get current task state (prevent overwriting later statuses)
      const task = queryOne<Task>(
        'SELECT * FROM tasks WHERE id = ?',
        [session.taskId]
      );

      if (!task) {
        console.warn(`[AgentMonitor] Task "${session.taskId}" not found for completion`);
        this.stopMonitoring(session.taskId);
        return;
      }

      // Only transition if still in assigned/in_progress
      if (task.status !== 'testing' && task.status !== 'review' && task.status !== 'done') {
        run(
          'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
          ['testing', now, session.taskId]
        );
      }

      // Log completion activity
      const activityId = uuidv4();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, session.taskId, session.agentId, 'completed', `Task completed: ${summary}`, now]
      );

      // Log completion event
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_completed',
          session.agentId,
          session.taskId,
          `${session.agentName} completed: ${summary}`,
          now,
        ]
      );

      // Set agent back to standby
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['standby', now, session.agentId]
      );

      // Broadcast updates
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [session.taskId]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Fetch the agent for activity broadcast
      const agent = queryOne<Agent>(
        'SELECT * FROM agents WHERE id = ?',
        [session.agentId]
      );

      broadcast({
        type: 'activity_logged',
        payload: {
          id: activityId,
          task_id: session.taskId,
          agent_id: session.agentId,
          activity_type: 'completed' as const,
          message: `Task completed: ${summary}`,
          created_at: now,
          agent: agent
            ? {
                id: agent.id,
                name: agent.name,
                avatar_emoji: agent.avatar_emoji,
                role: agent.role,
                status: agent.status,
                is_master: agent.is_master,
                workspace_id: agent.workspace_id,
                description: agent.description || '',
                created_at: agent.created_at,
                updated_at: agent.updated_at,
              }
            : undefined,
        },
      });

      // Stop monitoring this task
      this.stopMonitoring(session.taskId);
    } catch (err) {
      console.error('[AgentMonitor] Failed to handle task completion:', err);
    }
  }
}

// ─── Singleton Export ──────────────────────────────────────────────

let monitorInstance: AgentSessionMonitor | null = null;

export function getAgentMonitor(): AgentSessionMonitor {
  if (!monitorInstance) {
    monitorInstance = new AgentSessionMonitor();
    // On first creation, resume monitoring any in-progress tasks from the database
    // This handles server restarts where tasks were dispatched before the restart
    monitorInstance.resumeFromDatabase();
  }
  return monitorInstance;
}

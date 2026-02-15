/**
 * Agent Session Monitor
 * 
 * Hybrid monitoring service that combines:
 * 
 * 1. **Event-driven** (primary): Subscribes to Gateway push events (tool_call,
 *    tool_result, agent) for real-time, step-by-step activity tracking.
 * 2. **Polling** (fallback): Polls chat.history on a slower cadence to catch
 *    anything missed during reconnections (Gateway events are not replayed).
 * 
 * Each tool call and tool result the agent executes is logged as a separate
 * activity entry, giving full visibility into agent behaviour.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import type {
  Task,
  Agent,
  TaskDeliverable,
  ActivityType,
  GatewayToolCallEvent,
  GatewayToolResultEvent,
  GatewayAgentEvent,
} from '@/lib/types';

// ─── Configuration ──────────────────────────────────────────────────

/** Polling interval — slower now that events are the primary channel */
const POLL_INTERVAL_MS = 15_000;

/** Maximum number of messages to fetch per poll */
const HISTORY_LIMIT = 50;

/** Max characters for an activity message before truncation */
const MAX_ACTIVITY_MESSAGE_LENGTH = 500;

/** Max characters for tool output stored in metadata */
const MAX_TOOL_OUTPUT_LENGTH = 2_000;

// ─── Types ──────────────────────────────────────────────────────────

/** State tracked per monitored session */
interface MonitoredSession {
  taskId: string;
  agentId: string;
  agentName: string;
  openclawSessionId: string;
  sessionKey: string;
  /** Number of assistant messages we've already processed (for polling fallback) */
  lastSeenMessageCount: number;
  /** Timestamp when monitoring started */
  startedAt: number;
  /** Consecutive poll errors (for backoff) */
  errorCount: number;
  /** Timestamp of last Gateway event received for this session (0 = never) */
  lastEventAt: number;
}

// ─── Monitor Class ──────────────────────────────────────────────────

class AgentSessionMonitor {
  private monitoredSessions = new Map<string, MonitoredSession>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  /** Whether we've attached Gateway event listeners */
  private eventsAttached = false;

  /** Lookup: sessionKey → taskId for fast event correlation */
  private sessionKeyToTaskId = new Map<string, string>();

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Start monitoring an agent session for a dispatched task.
   * Attaches Gateway event listeners (once) and starts fallback polling.
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
      lastEventAt: 0,
    });

    // Build reverse lookup for event correlation
    this.sessionKeyToTaskId.set(sessionKey, params.taskId);

    console.log(
      `[AgentMonitor] Started monitoring task "${params.taskId}" ` +
      `via session "${params.openclawSessionId}" (${this.monitoredSessions.size} active)`
    );

    // Attach Gateway event listeners (idempotent)
    this.attachGatewayEvents();

    // Ensure polling fallback is running
    this.ensurePolling();
  }

  /**
   * Stop monitoring a specific task.
   */
  stopMonitoring(taskId: string): void {
    const session = this.monitoredSessions.get(taskId);
    if (session) {
      this.sessionKeyToTaskId.delete(session.sessionKey);
      this.monitoredSessions.delete(taskId);
      console.log(
        `[AgentMonitor] Stopped monitoring task "${taskId}" ` +
        `(${this.monitoredSessions.size} remaining)`
      );
    }

    if (this.monitoredSessions.size === 0) {
      this.stopPolling();
    }
  }

  /**
   * Resume monitoring for all in-progress tasks on startup.
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
    eventsAttached: boolean;
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
      eventsAttached: this.eventsAttached,
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

  // ─── Gateway Event Handlers (Primary Channel) ───────────────────

  /**
   * Attach listeners for Gateway push events. Called once and persists
   * across the lifetime of the monitor.
   */
  private attachGatewayEvents(): void {
    if (this.eventsAttached) return;

    const client = getOpenClawClient();

    // tool_call: Agent is invoking a tool (shell, file read, API call, etc.)
    client.on('event:tool_call', (payload: GatewayToolCallEvent) => {
      this.handleToolCallEvent(payload);
    });

    // tool_result: Tool execution completed with output
    client.on('event:tool_result', (payload: GatewayToolResultEvent) => {
      this.handleToolResultEvent(payload);
    });

    // agent: Streaming agent status / thinking updates
    client.on('event:agent', (payload: GatewayAgentEvent) => {
      this.handleAgentEvent(payload);
    });

    this.eventsAttached = true;
    console.log('[AgentMonitor] Gateway event listeners attached (tool_call, tool_result, agent)');
  }

  /**
   * Resolve a Gateway event payload to a MonitoredSession.
   * 
   * Correlation strategy (in priority order):
   * 1. payload.sessionKey → direct lookup
   * 2. If only one session is active → use it (common case)
   * 3. Otherwise → null (log a warning)
   */
  private resolveSession(payload: { sessionKey?: string; runId?: string }): MonitoredSession | null {
    // Strategy 1: Direct sessionKey match
    if (payload.sessionKey) {
      const taskId = this.sessionKeyToTaskId.get(payload.sessionKey);
      if (taskId) {
        return this.monitoredSessions.get(taskId) ?? null;
      }
    }

    // Strategy 2: Only one session → unambiguous
    if (this.monitoredSessions.size === 1) {
      return this.monitoredSessions.values().next().value ?? null;
    }

    // Strategy 3: Cannot correlate
    if (this.monitoredSessions.size > 1) {
      console.warn(
        '[AgentMonitor] Cannot correlate Gateway event to a specific session ' +
        `(${this.monitoredSessions.size} active, payload keys: ${Object.keys(payload).join(', ')})`
      );
    }
    return null;
  }

  /**
   * Handle a tool_call event from the Gateway.
   */
  private handleToolCallEvent(payload: GatewayToolCallEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    const toolName = payload.tool || 'unknown';
    const argsPreview = payload.args
      ? JSON.stringify(payload.args).substring(0, 150)
      : '';

    // Build a human-readable message
    let message: string;
    if (toolName === 'shell' && payload.args?.command) {
      message = `Running command: ${String(payload.args.command)}`;
    } else if (toolName === 'file_read' || toolName === 'read') {
      message = `Reading file: ${String(payload.args?.path || payload.args?.file || '')}`;
    } else if (toolName === 'file_write' || toolName === 'write') {
      message = `Writing file: ${String(payload.args?.path || payload.args?.file || '')}`;
    } else if (toolName === 'browser' || toolName === 'web_search') {
      message = `${toolName}: ${String(payload.args?.url || payload.args?.query || argsPreview)}`;
    } else {
      message = `Tool call: ${toolName}`;
      if (argsPreview) message += ` ${argsPreview}`;
    }

    // Truncate if needed
    if (message.length > MAX_ACTIVITY_MESSAGE_LENGTH) {
      message = message.substring(0, MAX_ACTIVITY_MESSAGE_LENGTH - 3) + '...';
    }

    const metadata = JSON.stringify({
      tool: toolName,
      args: payload.args,
      status: payload.status || 'executing',
    });

    this.logActivity(session, 'tool_called', message, metadata);
  }

  /**
   * Handle a tool_result event from the Gateway.
   */
  private handleToolResultEvent(payload: GatewayToolResultEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    const toolName = payload.tool || 'unknown';
    const exitCode = payload.exit_code;
    const output = payload.output || '';

    // Build a readable message
    let message: string;
    if (exitCode !== undefined && exitCode !== 0) {
      message = `${toolName} failed (exit ${exitCode})`;
    } else {
      // Show a short preview of the output
      const preview = output.length > 120
        ? output.substring(0, 117) + '...'
        : output;
      message = preview
        ? `${toolName} result: ${preview}`
        : `${toolName} completed`;
    }

    if (message.length > MAX_ACTIVITY_MESSAGE_LENGTH) {
      message = message.substring(0, MAX_ACTIVITY_MESSAGE_LENGTH - 3) + '...';
    }

    // Store full output in metadata for expandable view in UI
    const truncatedOutput = output.length > MAX_TOOL_OUTPUT_LENGTH
      ? output.substring(0, MAX_TOOL_OUTPUT_LENGTH - 3) + '...'
      : output;

    const metadata = JSON.stringify({
      tool: toolName,
      output: truncatedOutput,
      exit_code: exitCode,
    });

    this.logActivity(session, 'tool_result', message, metadata);
  }

  /**
   * Handle an agent event from the Gateway (thinking / streaming status).
   * These are batched — we only log meaningful status changes, not every token.
   */
  private handleAgentEvent(payload: GatewayAgentEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    // Only log if there's a meaningful status or summary (skip token-level streaming)
    if (payload.status === 'accepted') {
      this.logActivity(session, 'agent_thinking', 'Agent is thinking...', null);
    } else if (payload.summary) {
      // Agent run completed — this may overlap with the TASK_COMPLETE polling detection,
      // but that's fine — the completion handler is idempotent.
      this.logActivity(session, 'updated', payload.summary, JSON.stringify({
        status: payload.status,
        tokens_used: payload.tokens_used,
      }));
    }
    // Ignore other streaming events (token deltas) to avoid noise
  }

  // ─── Activity Logging Helper ────────────────────────────────────

  /**
   * Insert a task_activity row and broadcast it via SSE.
   */
  private logActivity(
    session: MonitoredSession,
    activityType: ActivityType,
    message: string,
    metadata: string | null,
  ): void {
    const now = new Date().toISOString();
    const activityId = uuidv4();

    try {
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [activityId, session.taskId, session.agentId, activityType, message, metadata, now]
      );

      // Fetch agent info for the broadcast payload
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
          activity_type: activityType,
          message,
          metadata: metadata ?? undefined,
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

      console.log(
        `[AgentMonitor] Activity [${activityType}] for task "${session.taskId}": ${message.substring(0, 80)}${message.length > 80 ? '...' : ''}`
      );
    } catch (err) {
      console.error('[AgentMonitor] Failed to log activity:', err);
    }
  }

  // ─── Polling Fallback ───────────────────────────────────────────

  private ensurePolling(): void {
    if (this.pollTimer) return;

    console.log(`[AgentMonitor] Starting poll fallback (every ${POLL_INTERVAL_MS / 1000}s)`);
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);

    // Immediate first poll
    this.pollAll();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[AgentMonitor] Poll fallback stopped (no active sessions)');
    }
  }

  /**
   * Poll all monitored sessions for new messages (fallback channel).
   */
  private async pollAll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const client = getOpenClawClient();
      if (!client.isConnected()) {
        try {
          await client.connect();
        } catch {
          console.warn('[AgentMonitor] Gateway not connected, will retry next cycle');
          return;
        }
      }

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
   * Poll a single session for new messages.
   * 
   * Now that events are the primary channel, polling mainly serves to:
   * - Detect TASK_COMPLETE patterns for the completion workflow
   * - Catch messages that may have been missed during reconnection gaps
   */
  private async pollSession(
    client: ReturnType<typeof getOpenClawClient>,
    session: MonitoredSession
  ): Promise<void> {
    try {
      // Verify task is still monitorable
      const task = queryOne<Task>(
        'SELECT * FROM tasks WHERE id = ?',
        [session.taskId]
      );

      if (!task || !['assigned', 'in_progress'].includes(task.status)) {
        console.log(
          `[AgentMonitor] Task "${session.taskId}" no longer active (status: ${task?.status ?? 'deleted'}), stopping`
        );
        this.stopMonitoring(session.taskId);
        return;
      }

      // Fetch message history
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

      const newMessageCount = assistantMessages.length - session.lastSeenMessageCount;
      if (newMessageCount <= 0) {
        session.errorCount = 0;
        return;
      }

      const newMessages = assistantMessages.slice(session.lastSeenMessageCount);
      session.lastSeenMessageCount = assistantMessages.length;
      session.errorCount = 0;

      for (const messageText of newMessages) {
        // Check for TASK_COMPLETE pattern (primary purpose of polling now)
        const completionMatch = messageText.match(/TASK_COMPLETE:\s*(.+)/i);
        if (completionMatch) {
          const summary = completionMatch[1].trim();
          await this.handleTaskCompletion(session, summary, new Date().toISOString());
          return;
        }

        // Only log via polling if this session hasn't received Gateway events
        // recently. If events are actively flowing, they provide richer
        // step-by-step tracking and polling would just duplicate data.
        const eventsSilentMs = Date.now() - session.lastEventAt;
        const eventsAreActive = session.lastEventAt > 0 && eventsSilentMs < POLL_INTERVAL_MS * 2;

        if (!eventsAreActive) {
          const truncated =
            messageText.length > MAX_ACTIVITY_MESSAGE_LENGTH
              ? messageText.substring(0, MAX_ACTIVITY_MESSAGE_LENGTH - 3) + '...'
              : messageText;
          this.logActivity(session, 'updated', truncated, null);
        }
      }
    } catch (err) {
      session.errorCount++;
      if (session.errorCount <= 3 || session.errorCount % 10 === 0) {
        console.error(
          `[AgentMonitor] Error polling session "${session.openclawSessionId}" ` +
          `(attempt ${session.errorCount}):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // ─── Task Completion Handler ────────────────────────────────────

  /**
   * Handle TASK_COMPLETE signal.
   *
   * Smart routing:
   * - If the task has testable deliverables (HTML files or URLs) → "testing"
   *   and auto-trigger the test endpoint.
   * - If no testable deliverables exist → skip directly to "review".
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
      const task = queryOne<Task>(
        'SELECT * FROM tasks WHERE id = ?',
        [session.taskId]
      );

      if (!task) {
        console.warn(`[AgentMonitor] Task "${session.taskId}" not found for completion`);
        this.stopMonitoring(session.taskId);
        return;
      }

      // Only transition if not already past in_progress
      if (task.status !== 'testing' && task.status !== 'review' && task.status !== 'done') {
        // Check for testable deliverables (HTML files or URLs)
        const deliverables = queryAll<TaskDeliverable>(
          `SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN (?, ?)`,
          [session.taskId, 'file', 'url']
        );

        const hasTestableContent = deliverables.some((d) => {
          if (d.deliverable_type === 'url') return true;
          if (d.path && (d.path.endsWith('.html') || d.path.endsWith('.htm'))) return true;
          return false;
        });

        if (hasTestableContent) {
          // Move to testing and auto-trigger tests
          run(
            'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
            ['testing', now, session.taskId]
          );
          this.logActivity(
            session,
            'status_changed',
            `Moved to testing — ${deliverables.length} testable deliverable(s) found, running automated tests`,
            null
          );

          // Fire-and-forget: trigger the test endpoint
          this.triggerAutoTests(session.taskId);
        } else {
          // No testable deliverables — skip testing, go straight to review
          run(
            'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
            ['review', now, session.taskId]
          );
          this.logActivity(
            session,
            'status_changed',
            'No testable deliverables found — skipped testing, moved to review for human approval',
            null
          );
        }
      }

      // Log completion activity
      this.logActivity(session, 'completed', `Task completed: ${summary}`, null);

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

      // Reset agent to standby
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['standby', now, session.agentId]
      );

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [session.taskId]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      this.stopMonitoring(session.taskId);
    } catch (err) {
      console.error('[AgentMonitor] Failed to handle task completion:', err);
    }
  }

  // ─── Auto-Test Trigger ──────────────────────────────────────────

  /**
   * Trigger the automated test endpoint for a task in the background.
   * This calls POST /api/tasks/{id}/test which runs Playwright-based
   * browser tests on all testable deliverables.
   */
  private async triggerAutoTests(taskId: string): Promise<void> {
    try {
      const baseUrl = getMissionControlUrl();
      console.log(`[AgentMonitor] Auto-triggering tests for task "${taskId}"`);

      const res = await fetch(`${baseUrl}/api/tasks/${taskId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok) {
        const result = await res.json();
        console.log(
          `[AgentMonitor] Auto-test completed for task "${taskId}": ${result.passed ? 'PASSED' : 'FAILED'} — ${result.summary}`
        );
      } else {
        const errorText = await res.text();
        console.error(
          `[AgentMonitor] Auto-test request failed for task "${taskId}" (HTTP ${res.status}): ${errorText}`
        );
      }
    } catch (err) {
      console.error(`[AgentMonitor] Failed to trigger auto-tests for task "${taskId}":`, err);
    }
  }
}

// ─── Singleton Export ──────────────────────────────────────────────

let monitorInstance: AgentSessionMonitor | null = null;

export function getAgentMonitor(): AgentSessionMonitor {
  if (!monitorInstance) {
    monitorInstance = new AgentSessionMonitor();
    monitorInstance.resumeFromDatabase();
  }
  return monitorInstance;
}

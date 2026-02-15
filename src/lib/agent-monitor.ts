/**
 * Agent Session Monitor
 * 
 * Hybrid monitoring service that combines:
 * 
 * 1. **Event-driven** (primary): Subscribes to Gateway streaming events.
 *    The `event:chat` stream carries every message — including assistant tool
 *    calls and tool results — as they happen.  Each is logged as a separate
 *    activity entry for full real-time visibility.
 * 2. **Polling** (fallback): Polls chat.history on a slower cadence to catch
 *    anything missed during reconnections (Gateway events are not replayed).
 * 
 * The Gateway does NOT push separate `tool_call` / `tool_result` event types.
 * Instead, tool calls and results are embedded inside `event:chat` messages:
 *   - role:"assistant" + content[type:"toolCall"] → tool invocation
 *   - role:"toolResult" → tool execution result with output + exit code
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
  GatewayChatEvent,
  GatewayChatContentBlock,
  GatewayChatMessage,
} from '@/lib/types';

// ─── Configuration ──────────────────────────────────────────────────

/** Polling interval — slower now that streaming events are the primary channel */
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
  /** Set of session-level seq numbers already processed (dedup between delta/final) */
  processedSeqs: Set<number>;
  /** Set of tool call IDs already logged (shared dedup across streaming + polling) */
  loggedToolCallIds: Set<string>;
  /** Whether TASK_COMPLETE has been detected (prevent double-completion) */
  completionHandled: boolean;
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
      processedSeqs: new Set(),
      loggedToolCallIds: new Set(),
      completionHandled: false,
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

    // ── PRIMARY: Chat events carry tool calls and results ──────────
    // The Gateway streams every message (assistant text, tool calls,
    // tool results) as `event:chat` with state "delta" or "final".
    client.on('event:chat', (payload: GatewayChatEvent) => {
      this.handleChatEvent(payload);
    });

    // ── Agent lifecycle events (start / end of agent run) ─────────
    client.on('event:agent', (payload: GatewayAgentEvent) => {
      this.handleAgentEvent(payload);
    });

    // ── Fallback: If the Gateway ever adds dedicated tool events ──
    client.on('event:tool_call', (payload: GatewayToolCallEvent) => {
      this.handleLegacyToolCallEvent(payload);
    });
    client.on('event:tool_result', (payload: GatewayToolResultEvent) => {
      this.handleLegacyToolResultEvent(payload);
    });

    this.eventsAttached = true;
    console.log('[AgentMonitor] Gateway event listeners attached (chat, agent, tool_call, tool_result)');
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

  // ─── Chat Event Handler (Primary) ─────────────────────────────

  /**
   * Handle a `event:chat` push from the Gateway.
   *
   * Every message in the agent conversation is streamed as a chat event:
   *   state:"delta" → partial / streaming update
   *   state:"final" → message is complete
   *
   * We process "final" events to avoid double-logging deltas.
   * Each message's content blocks are inspected:
   *   - type:"toolCall"  → log as tool_called activity
   *   - type:"text"      → check for TASK_COMPLETE pattern
   *   - role:"toolResult" → log as tool_result activity
   */
  private handleChatEvent(payload: GatewayChatEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    // Only process "final" events to avoid duplicate logging from deltas.
    // Tool calls complete almost instantly so the delay is negligible.
    if (payload.state !== 'final') return;

    // Deduplicate: skip if we've already processed this session seq
    if (payload.seq !== undefined) {
      if (session.processedSeqs.has(payload.seq)) return;
      session.processedSeqs.add(payload.seq);

      // Prune old seqs to prevent unbounded growth (keep last 200)
      if (session.processedSeqs.size > 200) {
        const seqs = Array.from(session.processedSeqs).sort((a, b) => a - b);
        const toRemove = seqs.slice(0, seqs.length - 200);
        for (const seq of toRemove) {
          session.processedSeqs.delete(seq);
        }
      }

      // Also prune loggedToolCallIds (keep last 400 — covers ~200 call+result pairs)
      if (session.loggedToolCallIds.size > 400) {
        const ids = Array.from(session.loggedToolCallIds);
        const toRemove = ids.slice(0, ids.length - 400);
        for (const id of toRemove) {
          session.loggedToolCallIds.delete(id);
        }
      }
    }

    const message = payload.message;
    if (!message) return;

    // ── Tool result messages ────────────────────────────────────
    if (message.role === 'toolResult') {
      this.handleStreamedToolResult(session, message);
      return;
    }

    // ── Assistant messages (tool calls + text) ──────────────────
    if (message.role === 'assistant' && message.content) {
      for (const block of message.content) {
        if (block.type === 'toolCall' && block.name) {
          this.handleStreamedToolCall(session, block);
        } else if (block.type === 'text' && block.text) {
          // Check for TASK_COMPLETE in assistant text
          this.checkForCompletion(session, block.text);
        }
      }
    }
  }

  /**
   * Log a tool call from a streamed chat message content block.
   * Shared by both the streaming handler and the polling fallback.
   */
  private handleStreamedToolCall(session: MonitoredSession, block: GatewayChatContentBlock): void {
    // Dedup: skip if we've already logged this tool call (prevents
    // duplicates when both streaming events and polling catch the same call)
    if (block.id) {
      if (session.loggedToolCallIds.has(block.id)) return;
      session.loggedToolCallIds.add(block.id);
    }

    const toolName = block.name || 'unknown';

    // Parse arguments — may be a JSON string or an object
    let args: Record<string, unknown> = {};
    if (typeof block.arguments === 'string') {
      try { args = JSON.parse(block.arguments); } catch { /* keep empty */ }
    } else if (block.arguments && typeof block.arguments === 'object') {
      args = block.arguments;
    }

    const argsPreview = Object.keys(args).length > 0
      ? JSON.stringify(args).substring(0, 150)
      : '';

    // Build a human-readable message
    let activityMessage: string;
    if ((toolName === 'shell' || toolName === 'exec') && args.command) {
      activityMessage = `Running command: ${String(args.command)}`;
    } else if (toolName === 'file_read' || toolName === 'read') {
      activityMessage = `Reading file: ${String(args.path || args.file_path || args.file || '')}`;
    } else if (toolName === 'file_write' || toolName === 'write') {
      activityMessage = `Writing file: ${String(args.path || args.file_path || args.file || '')}`;
    } else if (toolName === 'sessions_list') {
      activityMessage = `Listing active sessions`;
    } else if (toolName === 'sessions_send') {
      activityMessage = `Sending message to session: ${String(args.sessionKey || args.session_key || '')}`;
    } else if (toolName === 'browser' || toolName === 'web_search') {
      activityMessage = `${toolName}: ${String(args.url || args.query || argsPreview)}`;
    } else {
      activityMessage = `Tool call: ${toolName}`;
      if (argsPreview) activityMessage += ` ${argsPreview}`;
    }

    // Truncate if needed
    if (activityMessage.length > MAX_ACTIVITY_MESSAGE_LENGTH) {
      activityMessage = activityMessage.substring(0, MAX_ACTIVITY_MESSAGE_LENGTH - 3) + '...';
    }

    const metadata = JSON.stringify({
      tool: toolName,
      args,
      status: 'executing',
      toolCallId: block.id,
    });

    this.logActivity(session, 'tool_called', activityMessage, metadata);
  }

  /**
   * Log a tool result from a streamed chat message.
   * Shared by both the streaming handler and the polling fallback.
   */
  private handleStreamedToolResult(session: MonitoredSession, message: GatewayChatMessage): void {
    // Dedup: skip if we've already logged the result for this tool call
    // (toolCallId links a result back to the originating tool call)
    const resultKey = message.toolCallId ? `result:${message.toolCallId}` : null;
    if (resultKey) {
      if (session.loggedToolCallIds.has(resultKey)) return;
      session.loggedToolCallIds.add(resultKey);
    }

    const toolName = message.toolName || 'unknown';
    const details = message.details;
    const exitCode = details?.exitCode;
    const isError = message.isError === true;

    // Extract text output from content blocks
    let output = '';
    if (message.content) {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          output += block.text;
        }
      }
    }

    // Also include aggregated output from details if present
    if (!output && details?.aggregated) {
      output = details.aggregated;
    }

    // Build a readable message
    let activityMessage: string;
    if (isError || (exitCode !== undefined && exitCode !== 0)) {
      activityMessage = `${toolName} failed`;
      if (exitCode !== undefined) activityMessage += ` (exit ${exitCode})`;
      // Show a short preview of the error output
      const preview = output.length > 120
        ? output.substring(0, 117) + '...'
        : output;
      if (preview) activityMessage += `: ${preview}`;
    } else {
      // Show a short preview of the output
      const preview = output.length > 120
        ? output.substring(0, 117) + '...'
        : output;
      activityMessage = preview
        ? `${toolName} result: ${preview}`
        : `${toolName} completed`;
      if (details?.durationMs) {
        activityMessage += ` (${details.durationMs}ms)`;
      }
    }

    if (activityMessage.length > MAX_ACTIVITY_MESSAGE_LENGTH) {
      activityMessage = activityMessage.substring(0, MAX_ACTIVITY_MESSAGE_LENGTH - 3) + '...';
    }

    // Store full output in metadata for expandable view in UI
    const truncatedOutput = output.length > MAX_TOOL_OUTPUT_LENGTH
      ? output.substring(0, MAX_TOOL_OUTPUT_LENGTH - 3) + '...'
      : output;

    const metadata = JSON.stringify({
      tool: toolName,
      output: truncatedOutput,
      exit_code: exitCode ?? (isError ? 1 : 0),
      duration_ms: details?.durationMs,
      status: details?.status || (isError ? 'error' : 'completed'),
      toolCallId: message.toolCallId,
    });

    this.logActivity(session, 'tool_result', activityMessage, metadata);
  }

  /**
   * Check a text message for the TASK_COMPLETE pattern and handle completion.
   */
  private checkForCompletion(session: MonitoredSession, text: string): void {
    if (session.completionHandled) return;

    const completionMatch = text.match(/TASK_COMPLETE:\s*(.+)/i);
    if (completionMatch) {
      session.completionHandled = true;
      const summary = completionMatch[1].trim();
      // Use void to handle the async without blocking
      void this.handleTaskCompletion(session, summary, new Date().toISOString());
    }
  }

  // ─── Agent Event Handler ──────────────────────────────────────

  /**
   * Handle an `event:agent` push from the Gateway.
   *
   * Actual payload shape from the Gateway:
   *   { stream: "assistant", data: { text: "..." }, sessionKey, seq }
   *   { stream: "lifecycle", data: { phase: "start"|"end", ... }, sessionKey, seq }
   *
   * We only log meaningful lifecycle events, not token-level text streaming.
   */
  private handleAgentEvent(payload: GatewayAgentEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    // Handle lifecycle events (actual Gateway format)
    if (payload.stream === 'lifecycle') {
      if (payload.data?.phase === 'start') {
        this.logActivity(session, 'agent_thinking', 'Agent is processing...', null);
      }
      // "end" phase is handled by TASK_COMPLETE detection in chat events
      return;
    }

    // Legacy format fallback: payload.status / payload.summary
    if (payload.status === 'accepted') {
      this.logActivity(session, 'agent_thinking', 'Agent is thinking...', null);
    } else if (payload.summary) {
      this.logActivity(session, 'updated', payload.summary, JSON.stringify({
        status: payload.status,
        tokens_used: payload.tokens_used,
      }));
    }
    // Ignore assistant text streaming events (stream:"assistant") — too noisy
  }

  // ─── Legacy Tool Event Handlers (Fallback) ────────────────────
  // Kept in case the Gateway ever adds dedicated tool_call / tool_result
  // event types. Currently these events are NOT emitted by the Gateway.

  private handleLegacyToolCallEvent(payload: GatewayToolCallEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    const toolName = payload.tool || 'unknown';
    const argsPreview = payload.args
      ? JSON.stringify(payload.args).substring(0, 150)
      : '';

    let message: string;
    if ((toolName === 'shell' || toolName === 'exec') && payload.args?.command) {
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

  private handleLegacyToolResultEvent(payload: GatewayToolResultEvent): void {
    const session = this.resolveSession(payload);
    if (!session) return;
    session.lastEventAt = Date.now();

    const toolName = payload.tool || 'unknown';
    const exitCode = payload.exit_code;
    const output = payload.output || '';

    let message: string;
    if (exitCode !== undefined && exitCode !== 0) {
      message = `${toolName} failed (exit ${exitCode})`;
    } else {
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
   * Now that `event:chat` streaming is the primary channel, polling serves to:
   * - Detect TASK_COMPLETE patterns missed during reconnection gaps
   * - Log tool calls/results from chat.history if streaming events were missed
   * - Verify task is still active
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
          content?: Array<{ type: string; text?: string; name?: string; id?: string; arguments?: unknown }>;
          toolCallId?: string;
          toolName?: string;
          details?: { status?: string; exitCode?: number; durationMs?: number; aggregated?: string };
          isError?: boolean;
        }>;
      }>('chat.history', {
        sessionKey: session.sessionKey,
        limit: HISTORY_LIMIT,
      });

      const allMessages = result.messages || [];

      // Count all messages (not just assistant text) for the message counter
      const totalMessages = allMessages.length;
      const newMessageCount = totalMessages - session.lastSeenMessageCount;
      if (newMessageCount <= 0) {
        session.errorCount = 0;
        return;
      }

      const newMessages = allMessages.slice(session.lastSeenMessageCount);
      session.lastSeenMessageCount = totalMessages;
      session.errorCount = 0;

      // If streaming events are actively flowing, skip detailed polling logging
      // to avoid duplicating what the chat event handler already captures.
      const eventsSilentMs = Date.now() - session.lastEventAt;
      const eventsAreActive = session.lastEventAt > 0 && eventsSilentMs < POLL_INTERVAL_MS * 2;

      for (const msg of newMessages) {
        // ── Check for TASK_COMPLETE in assistant text messages ──
        if (msg.role === 'assistant' && msg.content) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              this.checkForCompletion(session, block.text);
            }
          }

          // Log tool calls from history if events were missed
          if (!eventsAreActive) {
            for (const block of msg.content) {
              if (block.type === 'toolCall' && block.name) {
                this.handleStreamedToolCall(session, block as GatewayChatContentBlock);
              }
            }
          }
        }

        // ── Log tool results from history if events were missed ──
        if (msg.role === 'toolResult' && !eventsAreActive) {
          this.handleStreamedToolResult(session, msg as GatewayChatMessage);
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

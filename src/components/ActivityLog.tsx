/**
 * ActivityLog Component
 * Displays chronological activity log for a task with real-time updates.
 * Supports rich rendering for tool calls, tool results, and agent thinking.
 */

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { TaskActivity } from '@/lib/types';

interface ActivityLogProps {
  taskId: string;
}

interface ToolCallMeta {
  tool: string;
  args?: Record<string, unknown>;
  status?: string;
}

interface ToolResultMeta {
  tool: string;
  output?: string;
  exit_code?: number;
}

export function ActivityLog({ taskId }: ActivityLogProps) {
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadActivities = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/activities`);
      if (res.ok) {
        const data = await res.json();
        setActivities(data);
      }
    } catch (error) {
      console.error('Failed to load activities:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Initial load
  useEffect(() => {
    loadActivities();
  }, [loadActivities]);

  // Real-time updates via SSE
  useEffect(() => {
    const eventSource = new EventSource('/api/events/stream');
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        if (event.data.startsWith(':')) return; // keep-alive
        const sseEvent = JSON.parse(event.data);

        if (sseEvent.type === 'activity_logged' && sseEvent.payload?.task_id === taskId) {
          setActivities((prev) => {
            // Avoid duplicates
            if (prev.some((a) => a.id === sseEvent.payload.id)) return prev;
            // Prepend (newest first)
            return [sseEvent.payload as TaskActivity, ...prev];
          });
        }
      } catch {
        // Ignore parse errors
      }
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [taskId]);

  const toggleResultExpanded = (activityId: string) => {
    setExpandedResults((prev) => {
      const next = new Set(prev);
      if (next.has(activityId)) {
        next.delete(activityId);
      } else {
        next.add(activityId);
      }
      return next;
    });
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'spawned':
        return '🚀';
      case 'updated':
        return '✏️';
      case 'completed':
        return '✅';
      case 'file_created':
        return '📄';
      case 'status_changed':
        return '🔄';
      case 'tool_called':
        return '⚡';
      case 'tool_result':
        return '📋';
      case 'agent_thinking':
        return '🧠';
      default:
        return '📝';
    }
  };

  const getActivityLabel = (type: string) => {
    switch (type) {
      case 'tool_called':
        return 'Tool Call';
      case 'tool_result':
        return 'Result';
      case 'agent_thinking':
        return 'Thinking';
      case 'completed':
        return 'Completed';
      case 'spawned':
        return 'Spawned';
      case 'updated':
        return 'Update';
      default:
        return null;
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return 'just now';
    if (diff < 3600000) {
      const mins = Math.floor(diff / 60000);
      return `${mins} min${mins > 1 ? 's' : ''} ago`;
    }
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  /**
   * Parse metadata JSON safely, returning null on failure.
   */
  const parseMeta = (metadata?: string): Record<string, unknown> | null => {
    if (!metadata) return null;
    try {
      return JSON.parse(metadata);
    } catch {
      return null;
    }
  };

  /**
   * Render a tool_called activity with tool badge and command preview.
   */
  const renderToolCall = (activity: TaskActivity) => {
    const meta = parseMeta(activity.metadata) as ToolCallMeta | null;
    const toolName = meta?.tool || 'unknown';

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          {activity.agent && (
            <>
              <span className="text-sm">{activity.agent.avatar_emoji}</span>
              <span className="text-sm font-medium text-mc-text">
                {activity.agent.name}
              </span>
              <span className="text-mc-text-secondary">·</span>
            </>
          )}
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">
            {toolName}
          </span>
          {meta?.status && meta.status !== 'executing' && (
            <span className="text-xs text-mc-text-secondary">({meta.status})</span>
          )}
        </div>
        <div className="mt-1 p-2 bg-mc-bg-tertiary rounded font-mono text-xs text-mc-text break-all whitespace-pre-wrap">
          {activity.message}
        </div>
        <div className="text-xs text-mc-text-secondary mt-1.5">
          {formatTimestamp(activity.created_at)}
        </div>
      </div>
    );
  };

  /**
   * Render a tool_result activity with expandable output.
   */
  const renderToolResult = (activity: TaskActivity) => {
    const meta = parseMeta(activity.metadata) as ToolResultMeta | null;
    const toolName = meta?.tool || '';
    const fullOutput = meta?.output || '';
    const exitCode = meta?.exit_code;
    const isExpanded = expandedResults.has(activity.id);
    const hasFullOutput = fullOutput.length > 0;
    const isFailed = exitCode !== undefined && exitCode !== 0;

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          {activity.agent && (
            <>
              <span className="text-sm">{activity.agent.avatar_emoji}</span>
              <span className="text-sm font-medium text-mc-text">
                {activity.agent.name}
              </span>
              <span className="text-mc-text-secondary">·</span>
            </>
          )}
          {toolName && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
              isFailed ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
            }`}>
              {toolName} {isFailed ? `✗ exit ${exitCode}` : '✓'}
            </span>
          )}
          {hasFullOutput && (
            <button
              onClick={() => toggleResultExpanded(activity.id)}
              className="text-xs text-mc-accent hover:text-mc-accent/80 transition-colors"
            >
              {isExpanded ? '▼ collapse' : '▶ expand output'}
            </button>
          )}
        </div>

        {/* Short preview is always shown via activity.message */}
        <p className="text-sm text-mc-text-secondary break-words">
          {activity.message}
        </p>

        {/* Expandable full output */}
        {isExpanded && hasFullOutput && (
          <div className="mt-2 p-2 bg-mc-bg-tertiary rounded font-mono text-xs text-mc-text overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap border border-mc-border">
            {fullOutput}
          </div>
        )}

        <div className="text-xs text-mc-text-secondary mt-1.5">
          {formatTimestamp(activity.created_at)}
        </div>
      </div>
    );
  };

  /**
   * Render the default activity style (updated, completed, spawned, etc.)
   */
  const renderDefaultActivity = (activity: TaskActivity) => {
    return (
      <div className="flex-1 min-w-0">
        {activity.agent && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm">{activity.agent.avatar_emoji}</span>
            <span className="text-sm font-medium text-mc-text">
              {activity.agent.name}
            </span>
          </div>
        )}
        <p className="text-sm text-mc-text break-words">
          {activity.message}
        </p>
        {activity.metadata && (
          <div className="mt-2 p-2 bg-mc-bg-tertiary rounded text-xs text-mc-text-secondary font-mono">
            {(() => {
              const meta = parseMeta(activity.metadata);
              return meta ? JSON.stringify(meta, null, 2) : activity.metadata;
            })()}
          </div>
        )}
        <div className="text-xs text-mc-text-secondary mt-2">
          {formatTimestamp(activity.created_at)}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading activities...</div>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <div className="text-4xl mb-2">📝</div>
        <p>No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {activities.map((activity) => {
        const label = getActivityLabel(activity.activity_type);
        const isToolCall = activity.activity_type === 'tool_called';
        const isToolResult = activity.activity_type === 'tool_result';
        const isThinking = activity.activity_type === 'agent_thinking';

        return (
          <div
            key={activity.id}
            className={`flex gap-3 p-3 rounded-lg border ${
              isToolCall
                ? 'bg-amber-500/5 border-amber-500/20'
                : isToolResult
                  ? 'bg-emerald-500/5 border-emerald-500/20'
                  : isThinking
                    ? 'bg-blue-500/5 border-blue-500/20'
                    : activity.activity_type === 'completed'
                      ? 'bg-green-500/5 border-green-500/20'
                      : 'bg-mc-bg border-mc-border'
            }`}
          >
            {/* Icon + optional label */}
            <div className="flex flex-col items-center flex-shrink-0 gap-0.5">
              <div className="text-lg">
                {getActivityIcon(activity.activity_type)}
              </div>
              {label && (
                <span className="text-[10px] text-mc-text-secondary whitespace-nowrap">
                  {label}
                </span>
              )}
            </div>

            {/* Content — delegated by type */}
            {isToolCall
              ? renderToolCall(activity)
              : isToolResult
                ? renderToolResult(activity)
                : renderDefaultActivity(activity)
            }
          </div>
        );
      })}
    </div>
  );
}

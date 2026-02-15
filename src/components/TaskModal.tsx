'use client';

import { useState } from 'react';
import { X, Save, Trash2, Activity, Package, Bot, ClipboardList, Plus, Play, SkipForward, Check, RotateCcw } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { ActivityLog } from './ActivityLog';
import { DeliverablesList } from './DeliverablesList';
import { SessionsList } from './SessionsList';
import { PlanningTab } from './PlanningTab';
import { AgentModal } from './AgentModal';
import type { Task, TaskPriority, TaskStatus } from '@/lib/types';

type TabType = 'overview' | 'planning' | 'activity' | 'deliverables' | 'sessions';

interface TaskModalProps {
  task?: Task;
  onClose: () => void;
  workspaceId?: string;
}

export function TaskModal({ task, onClose, workspaceId }: TaskModalProps) {
  const { agents, addTask, updateTask, addEvent } = useMissionControl();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Auto-switch to planning tab if task is in planning status
  const [activeTab, setActiveTab] = useState<TabType>(task?.status === 'planning' ? 'planning' : 'overview');

  const [form, setForm] = useState({
    title: task?.title || '',
    description: task?.description || '',
    priority: task?.priority || 'normal' as TaskPriority,
    status: task?.status || 'inbox' as TaskStatus,
    assigned_agent_id: task?.assigned_agent_id || '',
    due_date: task?.due_date || '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const url = task ? `/api/tasks/${task.id}` : '/api/tasks';
      const method = task ? 'PATCH' : 'POST';

      const payload = {
        ...form,
        // New tasks always start in planning mode
        status: !task ? 'planning' : form.status,
        assigned_agent_id: form.assigned_agent_id || null,
        due_date: form.due_date || null,
        workspace_id: workspaceId || task?.workspace_id || 'default',
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const savedTask = await res.json();

        if (task) {
          updateTask(savedTask);
          onClose();
        } else {
          addTask(savedTask);
          addEvent({
            id: crypto.randomUUID(),
            type: 'task_created',
            task_id: savedTask.id,
            message: `New task: ${savedTask.title}`,
            created_at: new Date().toISOString(),
          });

          // Trigger planning question generation in background
          fetch(`/api/tasks/${savedTask.id}/planning`, { method: 'POST' })
            .then(() => {
              // Update our local task reference and switch to planning tab
              updateTask({ ...savedTask, status: 'planning' });
            })
            .catch(console.error);
          
          // Log the planning start
          addEvent({
            id: crypto.randomUUID(),
            type: 'task_status_changed',
            task_id: savedTask.id,
            message: `📋 Planning started for: ${savedTask.title}`,
            created_at: new Date().toISOString(),
          });
          onClose();
        }
      }
    } catch (error) {
      console.error('Failed to save task:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!task || !confirm(`Delete "${task.title}"?`)) return;

    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (res.ok) {
        useMissionControl.setState((state) => ({
          tasks: state.tasks.filter((t) => t.id !== task.id),
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  /**
   * Run automated tests on a task's deliverables.
   */
  const handleRunTests = async () => {
    if (!task) return;
    setActionLoading('run-tests');
    try {
      const res = await fetch(`/api/tasks/${task.id}/test`, { method: 'POST' });
      const result = await res.json();

      if (!res.ok) {
        // API returned an error (400 = no deliverables, 500 = execution failure)
        addEvent({
          id: crypto.randomUUID(),
          type: 'task_status_changed',
          task_id: task.id,
          message: `Tests could not run for "${task.title}": ${result.error || `HTTP ${res.status}`}`,
          created_at: new Date().toISOString(),
        });
        return;
      }

      // Refresh task to reflect new status
      const taskRes = await fetch(`/api/tasks/${task.id}`);
      if (taskRes.ok) {
        updateTask(await taskRes.json());
      }

      const passed = result.passed === true;
      addEvent({
        id: crypto.randomUUID(),
        type: 'task_status_changed',
        task_id: task.id,
        message: passed
          ? `Tests passed for "${task.title}" — moved to review`
          : `Tests failed for "${task.title}" — sent back for fixes`,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to run tests:', error);
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Change a task's status via PATCH and refresh local state.
   */
  const handleStatusAction = async (newStatus: TaskStatus, actionKey: string) => {
    if (!task) return;
    setActionLoading(actionKey);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        const updatedTask = await res.json();
        updateTask(updatedTask);
      }
    } catch (error) {
      console.error('Failed to update task status:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const statuses: TaskStatus[] = ['planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'done'];
  const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: null },
    { id: 'planning' as TabType, label: 'Planning', icon: <ClipboardList className="w-4 h-4" /> },
    { id: 'activity' as TabType, label: 'Activity', icon: <Activity className="w-4 h-4" /> },
    { id: 'deliverables' as TabType, label: 'Deliverables', icon: <Package className="w-4 h-4" /> },
    { id: 'sessions' as TabType, label: 'Sessions', icon: <Bot className="w-4 h-4" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-mc-border flex-shrink-0">
          <h2 className="text-lg font-semibold">
            {task ? task.title : 'Create New Task'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-mc-bg-tertiary rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs - only show for existing tasks */}
        {task && (
          <div className="flex border-b border-mc-border flex-shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-mc-accent border-b-2 border-mc-accent'
                    : 'text-mc-text-secondary hover:text-mc-text'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Status Action Bar — shown for testing/review statuses across all tabs */}
        {task && task.status === 'testing' && (
          <div className="flex items-center gap-3 px-4 py-3 bg-amber-500/10 border-b border-amber-500/30 flex-shrink-0">
            <div className="flex-1 text-sm text-amber-300">
              <span className="font-medium">Testing</span> — Awaiting automated tests
            </div>
            <button
              onClick={handleRunTests}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {actionLoading === 'run-tests' ? 'Running...' : 'Run Tests'}
            </button>
            <button
              onClick={() => handleStatusAction('review', 'skip-review')}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-mc-bg hover:bg-mc-bg-tertiary text-mc-text-secondary border border-mc-border rounded text-sm transition-colors disabled:opacity-50"
            >
              <SkipForward className="w-3.5 h-3.5" />
              {actionLoading === 'skip-review' ? 'Skipping...' : 'Skip to Review'}
            </button>
          </div>
        )}

        {task && task.status === 'review' && (
          <div className="flex items-center gap-3 px-4 py-3 bg-blue-500/10 border-b border-blue-500/30 flex-shrink-0">
            <div className="flex-1 text-sm text-blue-300">
              <span className="font-medium">Review</span> — Awaiting your approval
            </div>
            <button
              onClick={() => handleStatusAction('done', 'approve')}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/40 rounded text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              {actionLoading === 'approve' ? 'Approving...' : 'Approve'}
            </button>
            <button
              onClick={() => handleStatusAction('assigned', 'request-changes')}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-mc-bg hover:bg-mc-bg-tertiary text-mc-text-secondary border border-mc-border rounded text-sm transition-colors disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {actionLoading === 'request-changes' ? 'Sending back...' : 'Request Changes'}
            </button>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              placeholder="What needs to be done?"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
              placeholder="Add details..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Status */}
            <div>
              <label className="block text-sm font-medium mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ').toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <label className="block text-sm font-medium mb-1">Priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Assigned Agent */}
          <div>
            <label className="block text-sm font-medium mb-1">Assign to</label>
            <select
              value={form.assigned_agent_id}
              onChange={(e) => {
                if (e.target.value === '__add_new__') {
                  setShowAgentModal(true);
                } else {
                  setForm({ ...form, assigned_agent_id: e.target.value });
                }
              }}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
            >
              <option value="">Unassigned</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.avatar_emoji} {agent.name} - {agent.role}
                </option>
              ))}
              <option value="__add_new__" className="text-mc-accent">
                ➕ Add new agent...
              </option>
            </select>
          </div>

          {/* Due Date */}
          <div>
            <label className="block text-sm font-medium mb-1">Due Date</label>
            <input
              type="datetime-local"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
            />
          </div>
            </form>
          )}

          {/* Planning Tab */}
          {activeTab === 'planning' && task && (
            <PlanningTab 
              taskId={task.id} 
              onSpecLocked={async () => {
                // Re-fetch task data and update store instead of full page reload
                try {
                  const res = await fetch(`/api/tasks/${task.id}`);
                  if (res.ok) {
                    const updatedTask = await res.json();
                    updateTask(updatedTask);
                  }
                } catch (err) {
                  console.error('Failed to refresh task after planning:', err);
                }
              }}
            />
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && task && (
            <ActivityLog taskId={task.id} />
          )}

          {/* Deliverables Tab */}
          {activeTab === 'deliverables' && task && (
            <DeliverablesList taskId={task.id} />
          )}

          {/* Sessions Tab */}
          {activeTab === 'sessions' && task && (
            <SessionsList taskId={task.id} />
          )}
        </div>

        {/* Footer - only show on overview tab */}
        {activeTab === 'overview' && (
          <div className="flex items-center justify-between p-4 border-t border-mc-border flex-shrink-0">
            <div className="flex gap-2">
              {task && (
                <>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="flex items-center gap-2 px-3 py-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded text-sm"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Nested Agent Modal for inline agent creation */}
      {showAgentModal && (
        <AgentModal
          workspaceId={workspaceId}
          onClose={() => setShowAgentModal(false)}
          onAgentCreated={(agentId) => {
            // Auto-select the newly created agent
            setForm({ ...form, assigned_agent_id: agentId });
            setShowAgentModal(false);
          }}
        />
      )}
    </div>
  );
}

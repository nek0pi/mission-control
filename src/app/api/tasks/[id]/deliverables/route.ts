/**
 * Task Deliverables API
 * Endpoints for managing task deliverables (files, URLs, artifacts)
 *
 * Supports two modes for file deliverables:
 *
 * 1. **Content upload** (recommended for remote agents):
 *    POST with `content` + `relative_path` – the server saves the file
 *    locally under PROJECTS_BASE and records the resolved absolute path.
 *
 * 2. **Path-only** (legacy / co-located agents):
 *    POST with `path` – the server records it and warns if the file is
 *    missing on its filesystem.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import nodePath from 'path';
import type { TaskDeliverable } from '@/lib/types';

// Base directory for all project files (matches /api/files/upload)
const PROJECTS_BASE = (process.env.PROJECTS_PATH || '~/projects').replace(
  /^~/,
  process.env.HOME || ''
);

/**
 * GET /api/tasks/[id]/deliverables
 * Retrieve all deliverables for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const db = getDb();

    const deliverables = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE task_id = ?
      ORDER BY created_at DESC
    `).all(taskId) as TaskDeliverable[];

    return NextResponse.json(deliverables);
  } catch (error) {
    console.error('Error fetching deliverables:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deliverables' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks/[id]/deliverables
 * Add a new deliverable to a task
 *
 * Body fields:
 *   - deliverable_type: 'file' | 'url' | 'artifact'  (required)
 *   - title: string                                    (required)
 *   - description?: string
 *
 * For file deliverables, one of:
 *   A) content + relative_path  – server saves the file and sets `path`
 *   B) path                     – absolute path (legacy, must be local)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const body = await request.json();

    const {
      deliverable_type,
      title,
      path: rawPath,
      description,
      content,
      relative_path,
    } = body;

    if (!deliverable_type || !title) {
      return NextResponse.json(
        { error: 'deliverable_type and title are required' },
        { status: 400 }
      );
    }

    // ── Resolve the final file path ────────────────────────────────
    let resolvedPath: string | null = rawPath || null;
    let fileExists = true;
    let fileSaved = false;

    if (deliverable_type === 'file') {
      if (content !== undefined && content !== null) {
        // ── Mode A: content upload ──────────────────────────────
        // Determine relative path for saving
        let relPath = relative_path;
        if (!relPath) {
          // Fallback: derive from title
          const safeName = title.replace(/[^a-zA-Z0-9._-]+/g, '-');
          relPath = `task-${taskId}/${safeName}`;
        }

        // Security: normalise and prevent traversal
        const normalizedRelPath = nodePath.normalize(relPath);
        if (normalizedRelPath.startsWith('..') || nodePath.isAbsolute(normalizedRelPath)) {
          return NextResponse.json(
            { error: 'Invalid relative_path: must be relative and cannot traverse upward' },
            { status: 400 }
          );
        }

        const fullPath = nodePath.join(PROJECTS_BASE, normalizedRelPath);

        // Ensure directories exist
        const parentDir = nodePath.dirname(fullPath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        // Write the file
        writeFileSync(fullPath, content, { encoding: 'utf-8' });
        console.log(`[DELIVERABLE] Saved file: ${fullPath} (${Buffer.byteLength(content, 'utf-8')} bytes)`);

        resolvedPath = fullPath;
        fileExists = true;
        fileSaved = true;
      } else if (resolvedPath) {
        // ── Mode B: path-only (legacy) ──────────────────────────
        // Expand tilde
        resolvedPath = resolvedPath.replace(/^~/, process.env.HOME || '');
        fileExists = existsSync(resolvedPath);
        if (!fileExists) {
          console.warn(`[DELIVERABLE] Warning: File does not exist locally: ${resolvedPath}`);
        }
      }
    }

    const db = getDb();
    const id = crypto.randomUUID();

    // Insert deliverable – always store the resolved (absolute) path
    db.prepare(`
      INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      deliverable_type,
      title,
      resolvedPath || null,
      description || null
    );

    // Get the created deliverable
    const deliverable = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE id = ?
    `).get(id) as TaskDeliverable;

    // Broadcast to SSE clients
    broadcast({
      type: 'deliverable_added',
      payload: deliverable,
    });

    // Build response
    const responseBody: Record<string, unknown> = { ...deliverable };

    if (fileSaved) {
      responseBody.file_saved = true;
      responseBody.saved_path = resolvedPath;
    } else if (deliverable_type === 'file' && !fileExists) {
      responseBody.warning = `File does not exist at path: ${resolvedPath}. The file may be on a remote host.`;
    }

    return NextResponse.json(responseBody, { status: 201 });
  } catch (error) {
    console.error('Error creating deliverable:', error);
    return NextResponse.json(
      { error: 'Failed to create deliverable' },
      { status: 500 }
    );
  }
}

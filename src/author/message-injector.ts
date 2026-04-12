import type { OrchestratorDB } from '../db/database.js';
import type { AgentPool } from '../acp/pool.js';
import type { PendingAuthorMessage } from '../types/instance.js';
import { ensureSession } from '../api/routes/agent-utils.js';
import { buildAuthorSessionConfig } from '../api/routes/author-session-config.js';
import { broadcast } from '../api/websocket.js';

export interface AuthorInjectionDeps {
  db: OrchestratorDB;
  authorPool: AgentPool;
}

export interface AuthorInjectionResult {
  /** true if pushed to a live session */
  delivered: boolean;
  /** true if written to pending_author_messages */
  buffered: boolean;
}

/**
 * Push a synthetic message into the author ACP session for a workflow.
 *
 * Strategy:
 *   - Ensure the session is alive and event-wired via `ensureSession` (the
 *     same setup `sendChatMessage` uses for `/api/author/chat`).
 *   - Fire `client.prompt(text)` directly so the agent receives the message
 *     as a user turn AND its streaming response is captured by the wired
 *     `agent_message_chunk` / `tool_call` / `done` handlers.
 *   - Skip the segment persistence + `${prefix}:user_message` broadcast that
 *     `sendChatMessage` does — those are appropriate for human-typed messages
 *     (which the user wants to see styled as their own bubble) but not for
 *     synthetic system notifications (which we render via the ephemeral
 *     `author:system_message` path with distinct amber styling).
 *
 * If the editor is closed (no live session), buffer in `pending_author_messages`
 * for the frontend to flush on the next AuthorChat mount.
 */
export async function injectAuthorMessage(
  deps: AuthorInjectionDeps,
  workflowId: string,
  text: string,
  opts?: { kind?: 'system' | 'user' },
): Promise<AuthorInjectionResult> {
  const kind = opts?.kind ?? 'system';

  const live = deps.authorPool.getClient('author', workflowId);
  if (!live) {
    deps.db.addPendingAuthorMessage({ workflow_id: workflowId, text, kind });
    return { delivered: false, buffered: true };
  }

  try {
    // ensureSession is idempotent — for a live session it just returns the
    // existing client without re-wiring events. We call it for safety in
    // case the session was spawned via a path that bypassed event wiring.
    const config = buildAuthorSessionConfig(deps.authorPool, workflowId);
    const { client } = await ensureSession(config, deps.db);

    // Fire-and-forget: the agent will start streaming a response which the
    // wired event handlers will route into the chat. We do not await the
    // turn — that would block the listener for the entire agent response.
    client.prompt(text).catch((err: Error) => {
      console.error(`[message-injector] prompt() failed for workflow ${workflowId}:`, err);
    });

    // Render the synthetic message in the live UI with distinct system styling.
    // This is ephemeral (not persisted) — on refresh the user sees only the
    // agent's response to the injection, not the injection text itself.
    broadcast(
      'author:system_message',
      { workflowId, text, kind, timestamp: new Date().toISOString() },
      { workflowId },
    );

    return { delivered: true, buffered: false };
  } catch (err) {
    console.error(`[message-injector] injection failed for workflow ${workflowId}, buffering:`, err);
    deps.db.addPendingAuthorMessage({ workflow_id: workflowId, text, kind });
    return { delivered: false, buffered: true };
  }
}

/**
 * Flush buffered messages for a workflow: return them AND delete them atomically.
 * Called by the frontend on AuthorChat mount.  Idempotent under concurrent calls
 * (the second call returns []).
 */
export function flushPendingAuthorMessages(
  deps: { db: OrchestratorDB },
  workflowId: string,
): PendingAuthorMessage[] {
  return deps.db.flushPendingAuthorMessages(workflowId);
}

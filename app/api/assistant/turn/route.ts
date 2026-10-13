// POST /api/assistant/turn -- one assistant turn (STATE item 87).
//
// A plain route handler, not a Server Action, with its own session check, for
// the reason the polling routes give (app/api/discovery-search-runs/[id]):
// repeated Server Action calls were implicated in a production React error.
// A turn is ONE fetch from the client, which waits for the answer; there is no
// polling loop. `maxDuration` is this route's own time budget -- the loop's
// constants (lib/assistant/loop.ts) are chosen so a turn cannot outlive it:
// MAX_STEPS x PER_CALL_TIMEOUT_MS is 150 s, TURN_DEADLINE_MS is 120 s.
//
// The literal below must stay a literal (Next reads it statically);
// scripts/test-assistant.ts asserts the loop's worst case fits inside it.
//
// This file authenticates and hands the session client to handleAssistantTurn,
// which holds every ordering guarantee. It never throws to the client.

import { createClient } from "@/lib/supabase/server";
import { handleAssistantTurn } from "@/lib/assistant/turn";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

// A request body larger than any legal turn is refused before it is parsed.
const MAX_BODY_CHARS = 8000;

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return json({ ok: false, error: "Unauthorized", code: "unauthorized" }, 401);

    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return json({ ok: false, error: "That request is too large.", code: "too_large" }, 413);
    let body: { message?: unknown; threadId?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return json({ ok: false, error: "That request could not be read.", code: "bad_request" }, 400);
    }
    if (body === null || typeof body !== "object") return json({ ok: false, error: "That request could not be read.", code: "bad_request" }, 400);

    const outcome = await handleAssistantTurn({ supabase, userId: user.id, threadId: body.threadId, message: body.message });
    return json(outcome.body, outcome.status);
  } catch (err) {
    console.error("[assistant] route failed:", err instanceof Error ? err.message : err);
    return json({ ok: false, error: "The assistant hit an unexpected error. Nothing was changed.", code: "internal" }, 500);
  }
}

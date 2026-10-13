import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveAssistantAccess, isMissingRelation, SETUP_PENDING_MESSAGE } from "@/lib/assistant/access";
import { readProviderConfig, PROVIDER_LABEL } from "@/lib/assistant/config";
import { PROPOSAL_COLUMNS, rowToView, type ProposalRow } from "@/lib/assistant/proposals";
import type { Card } from "@/lib/assistant/types";
import { colors, spacing, type as typeScale, sectionStyle } from "@/lib/ui";
import AssistantThread, { type MessageView } from "./assistant-thread";

// The page itself reads a thread and renders it; the model is called from the
// turn route (app/api/assistant/turn/route.ts), which carries its own
// maxDuration, and approving a proposal is a quick write. Nothing here needs a
// long time budget.

function Plain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Assistant</h1>
      <div style={{ ...sectionStyle, marginTop: spacing.lg }}>
        <h2 style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>{title}</h2>
        <p style={{ margin: 0, color: colors.textMuted, fontSize: typeScale.body }}>{children}</p>
      </div>
    </div>
  );
}

export default async function AssistantPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const access = await resolveAssistantAccess(supabase, user.id);
  if (!access.enabled) {
    return (
      <Plain title="The assistant is not switched on for your organization">
        It is turned on per organization by the platform owner. Nothing is sent to an AI provider from this page until it is.
      </Plain>
    );
  }

  const provider = readProviderConfig();
  if (!provider.ok) {
    return (
      <Plain title="The assistant is switched on, but its model connection is not set up yet">
        The owner needs to finish configuring the connection to the model provider. Nothing has been sent anywhere.
      </Plain>
    );
  }

  // The latest conversation of THIS user (RLS also scopes by author: a
  // teammate's conversations are not visible here).
  const { data: thread, error: threadError } = await supabase
    .from("assistant_threads")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (threadError) {
    if (isMissingRelation(threadError)) return <Plain title="Setup pending">{SETUP_PENDING_MESSAGE}</Plain>;
    return <Plain title="The assistant could not load">Reload the page. If it keeps happening, tell the owner.</Plain>;
  }

  let messages: MessageView[] = [];
  let proposals: ReturnType<typeof rowToView>[] = [];
  if (thread) {
    const threadId = thread.id as string;
    const [{ data: messageRows }, { data: proposalRows }] = await Promise.all([
      supabase
        .from("assistant_messages")
        .select("id, role, content, status, cards, stop_reason, created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true })
        .limit(200),
      supabase.from("assistant_proposals").select(PROPOSAL_COLUMNS).eq("thread_id", threadId).order("created_at", { ascending: true }),
    ]);
    messages = ((messageRows ?? []) as { id: string; role: "user" | "assistant"; content: string; status: string; cards: Card[]; stop_reason: string | null; created_at: string }[]).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      status: m.status as MessageView["status"],
      cards: Array.isArray(m.cards) ? m.cards : [],
      createdAt: m.created_at,
    }));
    proposals = ((proposalRows ?? []) as unknown as ProposalRow[]).map(rowToView);
  }

  return (
    <AssistantThread
      initialThreadId={(thread?.id as string | undefined) ?? null}
      initialMessages={messages}
      initialProposals={proposals}
      providerLabel={PROVIDER_LABEL}
      modelName={provider.config.model}
    />
  );
}

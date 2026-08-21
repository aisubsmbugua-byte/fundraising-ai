"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type AutoSearchSettings = {
  id: string;
  enabled: boolean;
  queue_threshold: number;
  updated_by: string | null;
  updated_at: string;
};

export async function getAutoSearchSettings(): Promise<AutoSearchSettings | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("auto_search_settings")
    .select("*")
    .limit(1)
    .maybeSingle<AutoSearchSettings>();
  return data ?? null;
}

// Singleton, same "update existing row if any, insert only if none"
// pattern as org_profile -- enforced in application code, not a DB
// constraint. updated_by is more than an audit trail here: the cron
// route has no user session of its own, so it attributes every
// automated run's created_by to whoever last saved these settings.
export async function updateAutoSearchSettings(enabled: boolean, queueThreshold: number) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: existing } = await supabase.from("auto_search_settings").select("id").limit(1).maybeSingle();

  const payload = {
    enabled,
    queue_threshold: queueThreshold,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };

  const { error } = existing
    ? await supabase.from("auto_search_settings").update(payload).eq("id", existing.id)
    : await supabase.from("auto_search_settings").insert(payload);
  if (error) throw new Error(error.message);

  revalidatePath("/settings");
}

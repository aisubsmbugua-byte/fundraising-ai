"use server";

// STATE item 119 (rulings 0051 and 0052 clause 5): a person adds ONE funder that files no return to their own organization's queue.
//
// This creates one pending candidate and nothing else: no prospect, no contact, no draft, no message, no stage change. The lead is read
// again here, through the signed-in user's own session, so the record kept on the candidate is what the database holds and not what a
// form said.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { isUniqueViolation } from "@/lib/candidate-intake";
import { LEAD_PAGE_SIZE, buildLeadBasis, channelForLead, displayLeadName, leadKindLabel, normalizeLead, type NoFilingLead, type RawLead } from "@/lib/funder-reference/nofiling-leads";

export type AddLeadResult = { ok: true; id: string } | { error: string };

export async function addNoFilingLead(leadKey: string): Promise<AddLeadResult> {
  if (typeof leadKey !== "string" || leadKey.length < 3 || leadKey.length > 300 || !leadKey.includes("|")) return { error: "That funder could not be identified." };
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session has expired. Sign in again." };

  // The caller's own list, page by page, until the lead is found: the same function the page reads, so nothing differs from what was shown.
  let lead: NoFilingLead | undefined;
  for (let page = 0; page < 20 && !lead; page++) {
    const { data, error } = await supabase.rpc("reference_nofiling_leads", { p_limit: 100, p_offset: page * 100 });
    if (error) return { error: error.message };
    const rows = ((data ?? []) as RawLead[]).map(normalizeLead);
    lead = rows.find((r) => r.lead_key === leadKey);
    if (rows.length < 100) break;
  }
  if (!lead) return { error: "That funder is no longer in the list, or is already in your queue." };

  const name = displayLeadName(lead);
  const candidate = {
    name,
    funder_name: name,
    channel: channelForLead(lead),
    funder_type: `${leadKindLabel(lead)} (no return in the database)`,
    location: [lead.city ? (lead.curated ? lead.city : lead.city.charAt(0) + lead.city.slice(1).toLowerCase()) : null, lead.state].filter(Boolean).join(", ") || null,
    // The EIN only where a filing states it; a curated record's EIN is a listing by name and city, kept in the basis, not asserted here.
    ein: lead.curated ? null : lead.stated_ein,
    website: lead.curated?.website ?? null,
    source: "reference_leads",
    raw: null,
  };

  const { data: rules } = await supabase.from("screening_rules").select("*").eq("active", true);
  const { tier } = screenProspect(candidate, (rules ?? []) as ScreeningRule[]);

  const { data: inserted, error: insertError } = await supabase
    .from("candidates")
    .insert({
      ...candidate,
      dedupe_key: `lead:${lead.lead_key}`,
      suggested_tier: tier,
      status: "pending",
      reference_basis: buildLeadBasis(lead, new Date().toISOString()),
    })
    .select("id")
    .single();
  if (insertError) {
    if (isUniqueViolation(insertError)) return { error: "That funder is already in your discovery queue." };
    return { error: insertError.message };
  }

  revalidatePath("/discovery");
  return { ok: true, id: inserted.id as string };
}

export const LEAD_ADD_PAGE_SIZE = LEAD_PAGE_SIZE;

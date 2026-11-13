"use server";

// STATE item 117 (ruling 0049 clause 2): a person adds ONE funder from the national database to their own queue.
//
// This creates one pending candidate and nothing else: no prospect, no contact, no draft, no message, no stage change.
// Nothing the page sent is trusted for a figure: the funder's numbers are read again here, through the signed-in
// user's own session, so the record kept on the candidate is what the database holds and not what a form said.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { isUniqueViolation } from "@/lib/candidate-intake";
import {
  ENOUGH_TO_GO_ON,
  bandFromBudget,
  buildBasis,
  channelFor,
  kindLabel,
  normalizeSuggestion,
  readableName,
  stateFromLocation,
  type Suggestion,
  type SuggestionSource,
} from "@/lib/funder-reference/suggestions";

export type AddSuggestedResult = { ok: true; id: string } | { error: string };

const FUNDER_TYPE: Record<string, string> = {
  "Private foundation": "Private foundation (per IRS filing)",
  "Donor-advised fund sponsor": "Donor-advised fund sponsor (per IRS filing)",
  "Grantmaking public charity": "Grantmaking public charity (per IRS filing)",
};

export async function addSuggestedFunder(ein: string, source: SuggestionSource): Promise<AddSuggestedResult> {
  if (!/^\d{9}$/.test(ein) || (source !== "private_foundation" && source !== "public_charity")) return { error: "That funder could not be identified." };
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session has expired. Sign in again." };

  const { data: profile } = await supabase.from("org_profile").select("annual_budget, hq_location").limit(1).maybeSingle();
  const band = bandFromBudget(profile?.annual_budget ?? null);
  const orgState = stateFromLocation(profile?.hq_location ?? null);

  // The funder's own row, as the suggestions would show it now. Asking for a wide page and picking the EIN keeps the
  // figures identical to what the person saw and avoids a second, differently-defined query.
  const { data, error } = await supabase.rpc("reference_funder_suggestions", {
    p_band_lo: band?.lo ?? null,
    p_band_hi: band?.hi ?? null,
    p_state: orgState,
    p_limit: 100,
    p_offset: 0,
  });
  if (error) return { error: error.message };
  let s: Suggestion | undefined = ((data ?? []) as Parameters<typeof normalizeSuggestion>[0][]).map(normalizeSuggestion).find((r) => r.ein === ein && r.source === source);
  if (!s) {
    // Beyond the first hundred, or no longer offered: read the stored row directly instead of refusing a valid funder.
    const { data: g } = await supabase.from("funder_reference_faith_giving").select("*").eq("ein", ein).eq("source", source).maybeSingle();
    const dir =
      source === "private_foundation"
        ? await supabase.from("funder_reference_directory").select("name, city, state, contributions_paid_per_books_amt, figures_period_end, only_preselected_charities_box_checked").eq("ein", ein).maybeSingle()
        : await supabase.from("charity_reference_directory").select("name, city, state, is_daf_sponsor, grants_domestic_orgs_amt, figures_period_end").eq("ein", ein).maybeSingle();
    if (!g || !dir.data) return { error: "That funder is no longer in the database's suggestions." };
    const d = dir.data as Record<string, unknown>;
    const amounts = ((g.faith_amounts ?? []) as Array<number | string>).map(Number);
    s = normalizeSuggestion({
      ein,
      source,
      name: (d.name as string) ?? null,
      city: (d.city as string) ?? null,
      state: (d.state as string) ?? null,
      is_daf_sponsor: Boolean(d.is_daf_sponsor),
      grants_counted: g.grants_counted,
      periods_counted: g.periods_counted,
      faith_count: g.faith_count,
      faith_in_band_count: band ? amounts.filter((a) => a >= band.lo && a <= band.hi).length : g.faith_count,
      faith_share: g.grants_counted ? Math.round((Number(g.faith_count) / Number(g.grants_counted)) * 10000) / 10000 : null,
      faith_last_period_end: g.faith_last_period_end,
      faith_in_state_count: orgState ? Number((g.faith_by_state ?? {})[orgState] ?? 0) : null,
      giving_amt: (d.contributions_paid_per_books_amt ?? d.grants_domestic_orgs_amt ?? null) as number | null,
      giving_period_end: (d.figures_period_end as string) ?? null,
      takes_no_unsolicited: source === "private_foundation" ? Boolean(d.only_preselected_charities_box_checked) : null,
      meets_floor: (band ? amounts.filter((a) => a >= band.lo && a <= band.hi).length : Number(g.faith_count)) >= ENOUGH_TO_GO_ON,
      faith_amounts_capped: g.faith_amounts_capped,
      faith_sample: g.faith_sample ?? [],
      rule_version: g.rule_version,
      total_matches: 1,
    });
  }

  const label = kindLabel(s);
  const name = readableName(s.name) || `EIN ${ein}`;
  const candidate = {
    name,
    funder_name: name,
    channel: channelFor(s),
    funder_type: FUNDER_TYPE[label],
    location: [readableName(s.city), s.state].filter(Boolean).join(", ") || null,
    ein,
    source: "reference_database",
    raw: null,
  };

  const { data: rules } = await supabase.from("screening_rules").select("*").eq("active", true);
  const { tier } = screenProspect(candidate, (rules ?? []) as ScreeningRule[]);

  const { data: inserted, error: insertError } = await supabase
    .from("candidates")
    .insert({
      ...candidate,
      // One open candidate per funder per organization: the EIN is the identity here, not a web page.
      dedupe_key: `ein:${ein}`,
      suggested_tier: tier,
      status: "pending",
      reference_basis: buildBasis(s, band, orgState, new Date().toISOString()),
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

// Server-side loader for the prospect page's "Who can open this door" panel
// (STATE items 76 and 103, rulings 0033 and 0040). Reads only the organization's own network
// tables and the APPROVED-intelligence payload -- never research_claims
// directly -- so the anchoring fact shown beside a path is read through the
// same single gate the finder reads through.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadApprovedIntelligence } from "@/lib/prospect-intelligence";
import { anchorKindLabel, selectAnchorClaims, type NetworkConnection, type NetworkPathSuggestion } from "@/lib/network";
import { NETWORK_PATHS_MAX_CONSIDERED } from "@/lib/network-shortlist";
import { countConnections } from "@/lib/network-store";

export type NetworkPanelItem = {
  suggestion: NetworkPathSuggestion;
  person: Pick<NetworkConnection, "person_name" | "affiliation" | "strength"> | null;
  // The funder-side fact the path anchors to, as approved (a corrected claim
  // shows its corrected text). Null when the claim is no longer in the
  // prospect's approved intelligence -- the panel says so rather than guessing.
  anchor: { kind: string; text: string } | null;
};

export type NetworkPanelData = {
  // The tables could not be read (e.g. migration 0077 not applied yet).
  unavailable: boolean;
  // The EXACT number of people recorded (a head count, not the length of a
  // fetched page -- the database returns at most 1000 rows to a plain select).
  connectionCount: number;
  // True when more people are recorded than one look considers, so paths are
  // looked for among a shortlist (ruling 0040 clause 7).
  narrowing: boolean;
  limit: number;
  anchorCount: number;
  items: NetworkPanelItem[];
};

export async function loadNetworkPanel(supabase: SupabaseClient, prospectId: string): Promise<NetworkPanelData> {
  const [recorded, suggestionsResult, approved] = await Promise.all([
    countConnections(supabase, ""),
    supabase.from("network_path_suggestions").select("*").eq("prospect_id", prospectId).order("created_at", { ascending: false }),
    loadApprovedIntelligence(supabase, prospectId),
  ]);
  const unavailable = { unavailable: true, connectionCount: 0, narrowing: false, limit: NETWORK_PATHS_MAX_CONSIDERED, anchorCount: 0, items: [] };
  if (recorded === null || suggestionsResult.error) return unavailable;
  const suggestions = (suggestionsResult.data ?? []) as NetworkPathSuggestion[];

  // Only the people the listed suggestions name -- not the whole network.
  const personIds = Array.from(new Set(suggestions.map((s) => s.network_connection_id)));
  let people: Pick<NetworkConnection, "id" | "person_name" | "affiliation" | "strength">[] = [];
  if (personIds.length > 0) {
    const peopleResult = await supabase.from("network_connections").select("id, person_name, affiliation, strength").in("id", personIds);
    if (peopleResult.error) return unavailable;
    people = (peopleResult.data ?? []) as typeof people;
  }
  const byConnection = new Map(people.map((c) => [c.id, c]));
  const anchors = approved ? selectAnchorClaims(approved.claims) : [];
  const byClaim = new Map((approved?.claims ?? []).map((c) => [c.claimId, c]));

  const items = suggestions.map((suggestion) => {
    const person = byConnection.get(suggestion.network_connection_id) ?? null;
    const claim = byClaim.get(suggestion.funder_claim_id);
    return {
      suggestion,
      person: person ? { person_name: person.person_name, affiliation: person.affiliation, strength: person.strength } : null,
      anchor: claim ? { kind: anchorKindLabel(claim.claimKey), text: claim.claim } : null,
    };
  });

  return {
    unavailable: false,
    connectionCount: recorded,
    narrowing: recorded > NETWORK_PATHS_MAX_CONSIDERED,
    limit: NETWORK_PATHS_MAX_CONSIDERED,
    anchorCount: anchors.length,
    items,
  };
}

// Server-side loader for the prospect page's "Who can open this door" panel
// (STATE item 76, ruling 0033). Reads only the organization's own network
// tables and the APPROVED-intelligence payload -- never research_claims
// directly -- so the anchoring fact shown beside a path is read through the
// same single gate the finder reads through.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadApprovedIntelligence } from "@/lib/prospect-intelligence";
import { anchorKindLabel, selectAnchorClaims, type NetworkConnection, type NetworkPathSuggestion } from "@/lib/network";

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
  connectionCount: number;
  anchorCount: number;
  items: NetworkPanelItem[];
};

export async function loadNetworkPanel(supabase: SupabaseClient, prospectId: string): Promise<NetworkPanelData> {
  const [connectionsResult, suggestionsResult, approved] = await Promise.all([
    supabase.from("network_connections").select("id, person_name, affiliation, strength"),
    supabase.from("network_path_suggestions").select("*").eq("prospect_id", prospectId).order("created_at", { ascending: false }),
    loadApprovedIntelligence(supabase, prospectId),
  ]);
  if (connectionsResult.error || suggestionsResult.error) {
    return { unavailable: true, connectionCount: 0, anchorCount: 0, items: [] };
  }
  const connections = (connectionsResult.data ?? []) as Pick<NetworkConnection, "id" | "person_name" | "affiliation" | "strength">[];
  const byConnection = new Map(connections.map((c) => [c.id, c]));
  const anchors = approved ? selectAnchorClaims(approved.claims) : [];
  const byClaim = new Map((approved?.claims ?? []).map((c) => [c.claimId, c]));

  const items = ((suggestionsResult.data ?? []) as NetworkPathSuggestion[]).map((suggestion) => {
    const person = byConnection.get(suggestion.network_connection_id) ?? null;
    const claim = byClaim.get(suggestion.funder_claim_id);
    return {
      suggestion,
      person: person ? { person_name: person.person_name, affiliation: person.affiliation, strength: person.strength } : null,
      anchor: claim ? { kind: anchorKindLabel(claim.claimKey), text: claim.claim } : null,
    };
  });

  return { unavailable: false, connectionCount: connections.length, anchorCount: anchors.length, items };
}

-- A finding the run believes but could not cite.
--
-- Making evidence_ids required removed unevidenced claims, but created a
-- worse failure: with no captured fragment supporting a specific detail, the
-- model still had to cite SOMETHING, so it attached the nearest one. One real
-- run produced ten named grants each citing the foundation's mission
-- statement; another cited ProPublica's generic database blurb for four exact
-- financial figures. Every upstream guarantee passed -- the fragment was
-- real, exactly captured, and from the confirmed entity -- because the defect
-- was the pairing, not the evidence.
--
-- Forcing a citation is what caused it, so the fix is to stop forcing one. A
-- claim may now honestly say "I found this and could not cite it": it stays
-- visible to a human, is capped at low confidence, and is barred from
-- downstream use. That is strictly better than an invented pairing, which
-- reads as corroborated.
--
-- Null on every pre-existing row, which is correct: those runs could not
-- express this state.
alter table research_claims add column evidence_missing boolean;

create index research_claims_evidence_missing_idx on research_claims (evidence_missing) where evidence_missing;

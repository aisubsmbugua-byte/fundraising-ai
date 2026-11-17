-- STATE item 119 (ruling 0052, clause 2 as corrected): the first version of the lead rule (no-filing-lead-v1), run on the real
-- data, offered 5,068 leads of which the most-named were the Metropolitan Museum of Art, the Red Cross and the Salvation Army. The
-- cause: ANY grant whose stated purpose mentioned a donor advised fund, re-granting or grantmaking made its recipient a lead, but
-- such a purpose usually describes how the giver decided, not what the recipient is. The Solomon Foundation (the case this was built
-- for) is the other kind: a giver wrote "contribution to a donor advised fund" and the recipient's name is a foundation's.
--
-- no-filing-lead-v2: a recipient is a lead when (a) its own name says it is a church extension fund, loan fund, gift fund, charitable
-- gift fund or donor advised fund, OR (b) its name is fund-like (foundation, fund, trust, endowment) AND a giver's stated purpose says
-- the gift went INTO a donor advised or gift fund (contribution, gift, transfer, deposit to; establish, create, open or seed one; a
-- fund contribution or account). The weak words (re-granting, grantmaking) and a bare mention of "donor advised" no longer qualify.
-- A rule change is a new version and a full recompute: the derived tables are cleared by the owner's refresh script, not here.

create or replace function funder_reference_nofiling_rule_version() returns text language sql immutable as $$ select 'no-filing-lead-v2' $$;

create or replace function funder_reference_nofiling_purpose_signal(p text) returns boolean language sql immutable as $$
  select coalesce(
    p ~* '\y(contribut\w*|gifts?|donat\w*|transfer\w*|deposit\w*|grants?)\s+(to|into)\s+(a|an|the|their|his|her|our)?\s*(donor[ -]?advised|gift|charitable gift)\s+(fund|account)'
    or p ~* '\y(establish\w*|creat\w*|open\w*|seed\w*|fund\w*)\s+(a|an|the)?\s*(new\s+)?(donor[ -]?advised|gift)\s+(fund|account)'
    or p ~* '\y(donor[ -]?advised|gift)\s+fund\s+(contribution|deposit|account)',
    false)
$$;
comment on function funder_reference_nofiling_purpose_signal(text) is
  'no-filing-lead-v2: true when a stated purpose says the gift went into a donor advised or gift fund: contribution/gift/donation/transfer/deposit/grant to or into one; establish/create/open/seed/fund one; a donor advised or gift fund contribution, deposit or account.';

create function funder_reference_nofiling_funder_like(p text) returns boolean language sql immutable as $$
  select coalesce(p ~* '\y(foundation|fund|funds|trust|endowment)\y', false)
$$;
comment on function funder_reference_nofiling_funder_like(text) is
  'no-filing-lead-v2: true when a recipient name contains foundation, fund(s), trust or endowment as a whole word.';

create or replace function funder_reference_nofiling_scan_keys(p_from text, p_to text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into funder_reference_nofiling_keys (lead_key)
  select distinct funder_reference_name_key(x.recipient_name_line1) || '|' || coalesce(upper(btrim(x.recipient_state)), '')
  from funder_reference_grants x
  where x.kind = 'paid_during_year' and x.ein >= p_from and x.ein < p_to
    and funder_reference_name_key(x.recipient_name_line1) is not null
    and (funder_reference_nofiling_name_signal(x.recipient_name_line1)
         or (funder_reference_nofiling_funder_like(x.recipient_name_line1) and funder_reference_nofiling_purpose_signal(x.purpose_as_stated)))
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into funder_reference_nofiling_keys (lead_key)
  select distinct funder_reference_name_key(x.recipient_name_line1) || '|' || coalesce(upper(btrim(x.recipient_state)), '')
  from charity_reference_grants x
  where x.ein >= p_from and x.ein < p_to
    and funder_reference_name_key(x.recipient_name_line1) is not null
    and (funder_reference_nofiling_name_signal(x.recipient_name_line1)
         or (funder_reference_nofiling_funder_like(x.recipient_name_line1) and funder_reference_nofiling_purpose_signal(x.purpose_as_stated)))
  on conflict do nothing;
  return n;
end;
$$;
revoke all on function funder_reference_nofiling_scan_keys(text, text) from public, anon, authenticated;
grant execute on function funder_reference_nofiling_scan_keys(text, text) to service_role;

-- the derived rows and leads of the superseded rule are cleared here so a read can never mix versions; the keys, rows and leads are
-- recomputed by the owner's refresh (the curated table is not touched)
delete from funder_reference_nofiling_leads;
delete from funder_reference_nofiling_rows;
delete from funder_reference_nofiling_keys;

-- STATE item 116 (ruling 0047): let the loader store a very large Form 990 return in pieces. Additive:
-- one new write function; no table, column, policy or existing function changes.
--
-- Why: the California trial found a donor-advised fund sponsor whose two returns list 46,203 and
-- 55,292 recipients, over the loader's 16 MB limit for one database call, so both were recorded as
-- unread. The loader now writes such a return in two or more calls: charity_reference_apply_filing
-- (0089) for everything except the recipient rows, then this function for the recipient rows, a piece
-- at a time. If any piece fails, the loader records the return as unread again, so a return is never
-- left looking complete with some recipients missing.
--
-- Access is exactly 0089's: the service role only, no policy for anyone else.

create function charity_reference_append_grants(grants jsonb)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  insert into charity_reference_grants
  select * from jsonb_populate_recordset(null::charity_reference_grants, coalesce(grants, '[]'::jsonb));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function charity_reference_append_grants(jsonb) from public, anon, authenticated;
grant execute on function charity_reference_append_grants(jsonb) to service_role;

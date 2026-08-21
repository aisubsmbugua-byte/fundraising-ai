-- One-time cleanup: lib/contacts.ts's upsertContact previously had no
-- way to dedupe a contact with no email (the "Dan Green" / "Michael
-- VanHuis" duplicates reported after the People backfill), so the
-- same no-email person turning up again just kept inserting new rows.
-- That gap is now fixed in application code (matches by name +
-- organization instead); this cleans up the rows it already produced,
-- keeping the newest per (name, organization) group.
delete from contacts a
using contacts b
where a.email is null
  and b.email is null
  and lower(a.name) = lower(b.name)
  and coalesce(a.organization, '') = coalesce(b.organization, '')
  and (a.created_at, a.id) < (b.created_at, b.id);

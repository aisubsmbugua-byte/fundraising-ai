-- lib/contacts.ts previously fell back to the raw email/URL string as
-- the display name when no person name was known (e.g. "Michael
-- VanHuis" was fine, but a contact with only "info@theaterchurch.com"
-- on file showed that as its name). Now fixed to prefer organization
-- over email as the fallback; this backfills the rows already created
-- under the old rule.
update contacts
set name = organization
where organization is not null
  and trim(organization) <> ''
  and email is not null
  and lower(trim(name)) = lower(trim(email));

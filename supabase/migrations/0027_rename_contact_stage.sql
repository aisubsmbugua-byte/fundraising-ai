-- "Contact" (the stage) and "Contacts" (the People/contacts directory,
-- being renamed from "People" in this same change) read as the same
-- thing in the nav. Renaming the stage to "Outreach" -- it's the
-- first-touch stage anyway, so the name fits -- resolves the
-- collision from the other side instead. Safe rename, not an add:
-- 0 prospects have ever occupied "contact" (verified before writing
-- this), so there's nothing to backfill.
alter type stage rename value 'contact' to 'outreach';

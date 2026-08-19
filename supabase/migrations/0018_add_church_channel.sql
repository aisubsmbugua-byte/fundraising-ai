-- Adds a 7th channel: Individual Church. Distinct from
-- "Denomination & Network Fund" -- many churches are standalone or
-- not meaningfully denomination-affiliated, giving from their own
-- missions/outreach budget directly, decided by a pastor or missions
-- committee rather than a formal denominational grants process.
--
-- Postgres can't use a newly-added enum value in the same
-- transaction it was added in, so this migration only adds the
-- value -- nothing else in the same script references it.

alter type channel add value 'church';

-- Design-review pass: pipeline cards need an ask amount and a
-- scheduled next action to show real numbers/dates instead of the
-- mockup's fabricated ones. Health status ("On track"/"Due soon"/
-- "Stalled") is deliberately NOT a stored column -- it's derived from
-- next_action_due at render time (see lib/prospects.ts), same
-- pattern already used for days-in-stage, so it can never drift out
-- of sync with the date it's supposed to reflect.
alter table prospects
  add column ask_amount numeric,
  add column next_action text,
  add column next_action_due date;

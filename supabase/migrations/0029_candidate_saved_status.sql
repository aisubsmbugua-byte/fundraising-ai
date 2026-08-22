-- Donor Finder's split-pane rebuild adds a "Saved" tab (mockup shows
-- To review / Saved / Dismissed) -- a genuinely useful third outcome
-- between "act on it now" and "not interested", not just a mockup
-- flourish, so it's a real status rather than something faked in the UI.
alter type candidate_status add value 'saved';

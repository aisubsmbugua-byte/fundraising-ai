# Review 0024 — Friday walkthrough: everything shipped this week, clicked by a human

Decision space, 2026-09-25, for the walkthrough on the morning of 2026-09-26.
Purpose: unit tests cannot see what a first real click does. The first live
send found three problems no suite had. This list walks every user-facing
thing built since Monday, in an order where each step sets up the next.

For every step, note one of: worked / odd / broken. Screenshots welcome for
anything ugly. Do not fix anything in the moment; note it.

## Setup (10 minutes)

1. Apply the network migration (0077) in the Supabase SQL editor and read the
   two probe numbers: 2 tables, 3 triggers.
2. Run the tenant-isolation suite once more so the network tables' cross-org
   locks and the delete-cascades execute for real.
3. Organization page: upload the VWI logo and set two brand colors. The Brand
   assets card should show them.

## A. Sending (10 minutes)

1. Admin, Organizations: VWI shows Sending on.
2. A prospect, Strategy tab, Compose email. Contact email must be your own
   address. Write a short note, save, Approve.
3. Send: the confirmation must show To (you), From (Village Worship
   Initiative, from your verified domain) and Replies go to (your login email).
4. Confirm. Check your inbox: arrived, and in the inbox rather than junk?
5. Switch VWI off in Admin. Reload the prospect: the Send button should be
   replaced by a calm note. Switch it back on.

## B. Proposal, feedback and PDF (20 minutes)

1. A prospect with an approved strategy: Draft Grant Proposal.
2. Read it: does it read as letterhead lines, then sections? Any bracketed
   placeholder anywhere (there must be none)? Is the date real?
3. Type a feedback note (for example: lead with the existing partnership and
   shorten the need statement) and press Revise. Did the revision follow it?
   Is it still in the same section format?
4. Approve. Open View proposal. Judge it honestly: logo, colors, typography,
   spacing. This is the page you asked to be beautiful. Print, Save as PDF, open
   the PDF, and tell me what you would change.
5. Un-approve it (confirm step). It should return to editable, and the View
   proposal link should stop working until approved again.

## C. Deck (10 minutes)

1. Draft Deck Outline. Edit a line in the outline text. Approve. Open the deck.
2. One slide per page? Evidence footnotes sensible? Print, Save as PDF.

## D. Decline and retract (5 minutes)

1. A test prospect: record a decline with Never revisit. It should leave Due
   now but show Declined with its reason on the Pipeline card.
2. Retract it. It should come back.

## E. Nurture (5 minutes)

1. Follow-up, Nurture tab. Your stewardship prospect appears only if it has
   had no contact for over 30 days; an empty tab may be correct.
2. If a row shows: Suggest next step and Compose email both work.

## F. Network (15 minutes)

1. Sidebar, Network. Read the sentence about what is shared with the AI: is it
   clear and honest?
2. Add three people you actually know (name, where they work or serve, how you
   know them, close or warm or acquaintance). Edit one. Delete one with the
   confirm step.
3. A prospect whose research has been approved and names key people: Strategy
   tab, Who can open this door, Find paths. Either you get paths (each showing
   the person, who at the funder it anchors to, reasoning, and a confidence
   labelled as the AI's estimate) or an honest none. Both are valid results.
   If no prospect has approved research with named people yet, the panel should
   say what is missing. That is the test.
4. Accept one path and dismiss another. Confirm nothing was sent and no stage
   moved.

## G. Afterwards (5 minutes, mine)

Tell me you are done. I read the run ledger directly and confirm every AI
action you took was recorded with its tokens: research, proposal draft and
revision, deck, and path-finding. I also check your sends and decisions landed
in the database as the screens claimed.

## Before Saturday

Testers' organizations stay switched off for sending. Decide whether to switch
the cron search back on (delete the pause setting in Vercel).

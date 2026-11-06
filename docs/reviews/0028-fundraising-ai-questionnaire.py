#!/usr/bin/env python3
"""The Fundraising AI account-setup questionnaire, as a fillable PDF.

Source for ~/Downloads/Fundraising AI Questionnaire.pdf. Questions only, no
explanation: the organization already has the backstory. Answers are typed
into form fields (or the page is printed), and the completed form is sent back.

Styled to match scripts/md-to-pdf.py. Usage:
    python3 docs/reviews/0028-fundraising-ai-questionnaire.py [out.pdf]
"""
import sys
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER, landscape
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#4b5563")
RULE = colors.HexColor("#d1d5db")
BAND = colors.HexColor("#f3f4f6")
FIELD_BORDER = colors.HexColor("#9ca3af")

PORTRAIT = LETTER
LANDSCAPE = landscape(LETTER)

out = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / "Downloads" / "Fundraising AI Questionnaire.pdf"
c = canvas.Canvas(str(out), pagesize=PORTRAIT)
c.setTitle("Fundraising AI questionnaire")
form = c.acroForm

MARGIN = 0.7 * inch
state = {"size": PORTRAIT, "y": 0.0, "n": 0, "page": 0}


def W():
    return state["size"][0]


def H():
    return state["size"][1]


def content_w():
    return W() - 2 * MARGIN


def footer():
    c.setFont("Helvetica", 8)
    c.setFillColor(MUTED)
    c.drawString(MARGIN, 0.4 * inch, "Fundraising AI questionnaire")
    c.drawRightString(W() - MARGIN, 0.4 * inch, f"Page {state['page']}")


def new_page(size=None):
    if state["page"] > 0:
        footer()
        c.showPage()
    state["size"] = size or state["size"]
    c.setPageSize(state["size"])
    state["page"] += 1
    state["y"] = H() - MARGIN


def ensure(h):
    if state["y"] - h < 0.75 * inch:
        new_page()


def name(prefix):
    state["n"] += 1
    return f"{prefix}_{state['n']}"


def text(s, font="Helvetica", size=9.5, color=INK, leading=None, after=0):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawString(MARGIN, state["y"] - size, s)
    state["y"] -= (leading or size * 1.4) + after


def wrap(s, font, size, width):
    words, lines, cur = s.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if c.stringWidth(t, font, size) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def paragraph(s, size=9.5, color=INK, font="Helvetica", after=6):
    lines = wrap(s, font, size, content_w())
    ensure(len(lines) * size * 1.45 + after)
    for ln in lines:
        c.setFont(font, size)
        c.setFillColor(color)
        c.drawString(MARGIN, state["y"] - size, ln)
        state["y"] -= size * 1.45
    state["y"] -= after


def section(title):
    ensure(60)
    state["y"] -= 8
    c.setFont("Helvetica-Bold", 12.5)
    c.setFillColor(INK)
    c.drawString(MARGIN, state["y"] - 12.5, title)
    state["y"] -= 20
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(MARGIN, state["y"], W() - MARGIN, state["y"])
    state["y"] -= 9


def field_row(items, h=22, multiline=False):
    """items: list of (label, width_fraction). One row of labelled text fields."""
    ensure(h + 18)
    gap = 10
    total_frac = sum(f for _, f in items)
    avail = content_w() - gap * (len(items) - 1)
    x = MARGIN
    top = state["y"]
    for label, frac in items:
        w_ = avail * frac / total_frac
        c.setFont("Helvetica-Bold", 8.5)
        c.setFillColor(INK)
        c.drawString(x, top - 8.5, label)
        form.textfield(
            name=name("f"), tooltip=label, x=x, y=top - 13 - h, width=w_, height=h,
            borderStyle="solid", borderColor=FIELD_BORDER, fillColor=colors.white, textColor=INK,
            forceBorder=True, fontSize=9, borderWidth=0.75, maxlen=2000 if multiline else 300,
            fieldFlags="multiline" if multiline else "",
        )
        x += w_ + gap
    state["y"] = top - 13 - h - 9


def question(label, h=46, hint=None):
    """A full-width multi-line answer box."""
    extra = 11 if hint else 0
    ensure(h + 18 + extra)
    top = state["y"]
    c.setFont("Helvetica-Bold", 8.5)
    c.setFillColor(INK)
    c.drawString(MARGIN, top - 8.5, label)
    if hint:
        c.setFont("Helvetica", 8)
        c.setFillColor(MUTED)
        c.drawString(MARGIN, top - 19, hint)
    form.textfield(
        name=name("q"), tooltip=label, x=MARGIN, y=top - 13 - extra - h, width=content_w(), height=h,
        borderStyle="solid", borderColor=FIELD_BORDER, fillColor=colors.white, textColor=INK,
        forceBorder=True, fontSize=9, borderWidth=0.75, maxlen=3000, fieldFlags="multiline",
    )
    state["y"] = top - 13 - extra - h - 9


def checks(label, options, cols=2, other=None):
    rows = (len(options) + cols - 1) // cols
    h = rows * 15 + 4
    ensure(h + 18)
    top = state["y"]
    c.setFont("Helvetica-Bold", 8.5)
    c.setFillColor(INK)
    c.drawString(MARGIN, top - 8.5, label)
    col_w = content_w() / cols
    for i, opt in enumerate(options):
        r, k = divmod(i, cols)
        x = MARGIN + k * col_w
        yy = top - 13 - (r + 1) * 15 + 3
        form.checkbox(
            name=name("c"), tooltip=f"{label}: {opt}", x=x, y=yy, size=10, buttonStyle="check",
            borderColor=FIELD_BORDER, fillColor=colors.white, textColor=INK, forceBorder=True, borderWidth=0.75,
            fieldFlags="",
        )
        c.setFont("Helvetica", 9)
        c.setFillColor(INK)
        c.drawString(x + 15, yy + 1.5, opt)
    state["y"] = top - 13 - rows * 15 - 6


def grid(columns, widths, rows, row_h=24, header_h=26, start_num=None):
    ensure(header_h + row_h * rows + 10)
    if start_num is not None:
        columns = ["#"] + list(columns)
        widths = [0.25] + list(widths)
    total = sum(widths)
    col_w = [wd / total * content_w() for wd in widths]
    top = state["y"]
    x = MARGIN
    c.setFillColor(BAND)
    c.rect(MARGIN, top - header_h, content_w(), header_h, stroke=0, fill=1)
    c.setFillColor(INK)
    for label, cw in zip(columns, col_w):
        lines = wrap(label, "Helvetica-Bold", 8.5, cw - 10)
        ty = top - 11 if len(lines) == 1 else top - 9
        for ln in lines[:2]:
            c.setFont("Helvetica-Bold", 8.5)
            c.drawString(x + 5, ty, ln)
            ty -= 10
        x += cw
    for r in range(rows):
        x = MARGIN
        ytop = top - header_h - r * row_h
        for ci, (label, cw) in enumerate(zip(columns, col_w)):
            if start_num is not None and ci == 0:
                c.setFont("Helvetica", 9)
                c.setFillColor(MUTED)
                c.drawString(x + 5, ytop - row_h / 2 - 3, str(start_num + r))
                c.setStrokeColor(RULE)
                c.setLineWidth(0.5)
                c.rect(x, ytop - row_h, cw, row_h, stroke=1, fill=0)
                x += cw
                continue
            form.textfield(
                name=name("g"), tooltip=f"{label}, row {r + 1}", x=x, y=ytop - row_h, width=cw, height=row_h,
                borderStyle="solid", borderColor=RULE, fillColor=colors.white, textColor=INK,
                forceBorder=True, fontSize=9, borderWidth=0.5, maxlen=300,
            )
            x += cw
    state["y"] = top - header_h - rows * row_h - 8


# ---------------------------------------------------------------- page 1
new_page(PORTRAIT)
c.setFont("Helvetica-Bold", 19)
c.setFillColor(INK)
c.drawString(MARGIN, state["y"] - 19, "Fundraising AI questionnaire")
state["y"] -= 28
paragraph(
    "To help set up your account. Answer what you can and leave the rest blank; we will follow up on anything missing. "
    "Type straight into the boxes, or print it and write. Please leave out sensitive personal details about individuals.",
    size=9.5, color=MUTED, after=2,
)

section("1. About your organization")
field_row([("Organization name (as funders should see it)", 0.55), ("Year founded", 0.15), ("Annual operating budget (US$)", 0.3)])
field_row([("Website", 0.4), ("HQ location (city, state)", 0.3), ("Area you serve", 0.3)])
checks("Legal / tax status", ["501(c)(3) Public Charity", "501(c)(3) Private Foundation", "Fiscally Sponsored", "Church / Religious Organization", "Other"], cols=2)
question("What problem do you exist to solve?", h=44)
question("Your mission (and vision, if you have one)", h=44)
question("What you do: programs, services, activities", h=52)
question("Who you serve (be specific about who they are and what they face)", h=52)
question("Your current funding need or gap", h=34, hint="For example: $150k general operating gap for FY26.")
checks("Cause areas (tick any that apply)", [
    "Education", "Health and Wellness", "Human Services", "Environment and Conservation",
    "Arts, Culture and Humanities", "Economic and Community Development", "Human and Civil Rights", "Youth Development",
    "Disaster Relief and Public Safety", "International and Foreign Affairs", "Christian Faith Based", "Animal Welfare",
], cols=3)
question("Core values or guiding principles", h=40)
question("Your best results, with real numbers (one per line)", h=64)
question("Leadership: name and role for each (founder, executive director, board chair and others)", h=64, hint="Add a phone number only if you are happy for it to appear in email signatures and be shared with the AI.")
question("Notable past or current funders (name, city and state)", h=50)
field_row([("Primary brand color (hex, such as #0b1f3a)", 0.5), ("Accent color (hex)", 0.5)])
paragraph("Please also send us your logo file (PNG, JPEG, SVG or WebP, under 5 MB) and any documents your team should be able to find, such as your 990 or annual report.", size=9, color=MUTED, after=0)

# ---------------------------------------------------------------- proof
section("2. Proof funders may be shown")
paragraph("Up to three stories, results or testimonials you are happy for us to show funders. The AI only ever uses proof you have approved.", size=9, color=MUTED)
for i in (1, 2, 3):
    ensure(150)
    c.setFont("Helvetica-Bold", 9.5)
    c.setFillColor(INK)
    c.drawString(MARGIN, state["y"] - 9.5, f"Item {i}")
    state["y"] -= 16
    field_row([("Title", 0.6), ("Type (outcome, story or testimonial)", 0.4)])
    question("Describe it as you would want a funder to read it", h=58)
    checks("May we show this to funders?", ["Yes, safe to show funders", "No, keep it internal"], cols=2)
    state["y"] -= 4

# ---------------------------------------------------------------- funders table
new_page(LANDSCAPE)
section("3. Grant givers you know or want us to pursue")
paragraph("One grant giver per row. Kinds of funder: Foundation and Family Trust, Regranting Ministry, Christian Business, Denomination and Network Fund, Individual Church, Donor-Advised Fund, Major Donor.", size=9, color=MUTED)
grid(
    ["Grant giver (organization)", "Kind of funder", "Person to reach, and their role", "Email", "Where it stands today", "Notes"],
    [1.8, 1.3, 1.6, 1.8, 1.4, 1.5], rows=11, row_h=30,
)

# ---------------------------------------------------------------- people who could open a door
new_page(LANDSCAPE)
section("4. People who can speak well of your ministry")
paragraph(
    "Minimum 20 names of people who can speak positively and with confidence about your ministry: board members, major donors, pastors and church leaders, partner organizations, volunteers, former colleagues, local leaders. "
    "You do not need to know whether they connect to any funder. The platform searches for how they do. "
    "The more exactly you describe each person (employer, title, city and state), the more surely the platform finds the right one. "
    "Please leave out email addresses, phone numbers and social media links; they are not stored.",
    size=9, color=MUTED,
)
NET_COLS = ["Full name", "Employer or organization", "Title or role", "City, state", "How you know them", "Close, warm or acquaintance"]
NET_W = [1.6, 1.8, 1.4, 1.2, 1.9, 1.1]
grid(NET_COLS, NET_W, rows=11, row_h=30, start_num=1)
new_page(LANDSCAPE)
paragraph("People who can speak well of your ministry, continued. Add more on a separate sheet if you have more than 20.", size=9, color=MUTED)
grid(NET_COLS, NET_W, rows=9, row_h=30, start_num=12)

# ---------------------------------------------------------------- guidelines
new_page(PORTRAIT)
section("5. How we should approach funders for you")
checks("Kinds of funder we may approach", [
    "Foundation and Family Trust", "Regranting Ministry", "Christian Business", "Denomination and Network Fund",
    "Individual Church", "Donor-Advised Fund", "Major Donor",
], cols=2)
question("Limits on geography, size or cause", h=34)
question("Funders or people we must never contact (conflicts, existing relationships, past declines)", h=44)
checks("Tone", ["Formal", "Warm", "Faith-forward", "Other"], cols=4)
question("Words or phrases to use, or to avoid", h=34)
field_row([("Messages are signed by (name)", 0.5), ("Title", 0.5)])
field_row([("Smallest ask (US$)", 0.25), ("Largest ask (US$)", 0.25), ("Any ask above this amount comes to you (US$)", 0.5)])
field_row([("Most follow-ups per funder", 0.5), ("Days between follow-ups", 0.5)])
checks("Always ask you first before we", [
    "Send any grant proposal or deck", "Propose an ask above your limit",
    "Make a claim about your results not in your approved proof", "Answer any reply from a funder",
    "Agree to a call, meeting or site visit", "Approach a funder you already know personally",
    "Approach a kind of funder not ticked above", "Other",
], cols=2)
checks("Best way to reach you for a quick decision", ["Email", "Text", "Phone", "WhatsApp"], cols=4)
field_row([("Best address or number", 0.6), ("Usual reply time", 0.4)])

# ---------------------------------------------------------------- sending + logins
new_page(PORTRAIT)
section("6. Sending from your own address (for later)")
paragraph("No email is sent from the platform for you during the beta. These details let us set that up when it is ready.", size=9, color=MUTED)
field_row([("Name funders should see", 0.5), ("Address funders should reply to", 0.5)])
field_row([("Who manages your email domain (name)", 0.5), ("Their email", 0.5)])
checks("May we send from your organization's domain once it is set up?", ["Yes", "Not yet"], cols=2)

section("7. Logins")
question("Who at your organization should have a login? Name and email for each.", h=90, hint="They sign in with an emailed link. There is no password.")

section("8. Anything else we should know")
question("", h=90)

footer()
c.save()
print("wrote", out, "fields:", state["n"], "pages:", state["page"])

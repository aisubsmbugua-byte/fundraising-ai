#!/usr/bin/env python3
"""Render a markdown review document to PDF.

We produce these repeatedly -- briefs written for external review, where the
reader is not in this repo and cannot run anything. Keeping the source as
markdown in docs/reviews/ means the argument is versioned alongside the code
it describes; this renders that same file for someone outside.

Deliberately narrow. It supports exactly what our review docs use:
headings, paragraphs, bullet and numbered lists, pipe tables, horizontal
rules, and inline **bold** / `code`. It is not a general markdown engine,
and it says so by failing visibly on anything else rather than silently
dropping it.

Output goes to ~/Downloads by default. That is where these get picked up to
attach to a chat or an email; a path inside the project tree is not somewhere
anyone browses, and a brief nobody can find has not been delivered.

Usage: python3 scripts/md-to-pdf.py docs/reviews/0001-review-burden.md [out.pdf]
"""

import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#4b5563")
RULE = colors.HexColor("#d1d5db")
BAND = colors.HexColor("#f3f4f6")


def styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=19, leading=24, textColor=INK, alignment=TA_LEFT, spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "subtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=9.5, leading=13, textColor=MUTED, spaceAfter=16,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=13, leading=17, textColor=INK, spaceBefore=16, spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontName="Helvetica",
            fontSize=10, leading=14.5, textColor=INK, spaceAfter=8,
        ),
        "cell": ParagraphStyle(
            "cell", parent=base["Normal"], fontName="Helvetica",
            fontSize=8.5, leading=11.5, textColor=INK,
        ),
        "cellhead": ParagraphStyle(
            "cellhead", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=8.5, leading=11.5, textColor=INK,
        ),
    }


def inline(text):
    """Markdown inline -> reportlab markup. Order matters: escape first."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`(.+?)`", r'<font face="Courier" size="9">\1</font>', text)
    return text


def is_table_row(line):
    return line.startswith("|") and line.endswith("|")


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def build_table(rows, st, width):
    header, body = rows[0], rows[1:]
    data = [[Paragraph(inline(c), st["cellhead"]) for c in header]]
    data += [[Paragraph(inline(c), st["cell"]) for c in r] for r in body]

    # First column carries the labels and needs the room; the rest share
    # what's left evenly.
    n = len(header)
    first = width * (0.34 if n > 2 else 0.5)
    rest = (width - first) / max(n - 1, 1)
    table = Table(data, colWidths=[first] + [rest] * (n - 1), hAlign="LEFT")
    table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), BAND),
            ("LINEBELOW", (0, 0), (-1, 0), 0.75, RULE),
            ("LINEBELOW", (0, 1), (-1, -2), 0.25, RULE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ])
    )
    return table


def convert(md_path: Path, pdf_path: Path):
    lines = md_path.read_text().split("\n")
    st = styles()
    width = LETTER[0] - 2 * inch
    flow = []
    i = 0
    seen_title = False
    pending_list = []
    list_ordered = False

    def flush_list():
        nonlocal pending_list
        if not pending_list:
            return
        flow.append(
            ListFlowable(
                [ListItem(Paragraph(inline(t), st["body"]), leftIndent=14) for t in pending_list],
                bulletType="1" if list_ordered else "bullet",
                bulletFontSize=8,
                leftIndent=16,
                spaceAfter=8,
            )
        )
        pending_list = []

    while i < len(lines):
        line = lines[i].rstrip()

        if not line.strip():
            flush_list()
            i += 1
            continue

        if line.startswith("# "):
            flush_list()
            flow.append(Paragraph(inline(line[2:]), st["title"]))
            seen_title = True
            i += 1
            continue

        if line.startswith("## "):
            flush_list()
            flow.append(Paragraph(inline(line[3:]), st["h2"]))
            i += 1
            continue

        if line.strip() == "---":
            flush_list()
            flow.append(Spacer(1, 4))
            flow.append(HRFlowable(width="100%", thickness=0.5, color=RULE))
            flow.append(Spacer(1, 8))
            i += 1
            continue

        if is_table_row(line):
            flush_list()
            rows = []
            while i < len(lines) and is_table_row(lines[i].rstrip()):
                cells = split_row(lines[i].rstrip())
                # The |---|---| separator carries no content.
                if not all(set(c) <= set("-: ") for c in cells):
                    rows.append(cells)
                i += 1
            if rows:
                flow.append(Spacer(1, 2))
                flow.append(build_table(rows, st, width))
                flow.append(Spacer(1, 12))
            continue

        bullet = re.match(r"^[-*]\s+(.*)$", line)
        numbered = re.match(r"^\d+\.\s+(.*)$", line)
        if bullet or numbered:
            ordered = numbered is not None
            if pending_list and ordered != list_ordered:
                flush_list()
            list_ordered = ordered
            pending_list.append((numbered or bullet).group(1))
            i += 1
            continue

        # A line immediately under the title, before any section, is the
        # standfirst rather than body copy.
        flush_list()
        style = st["subtitle"] if (seen_title and not any(f.style.name == "h2" for f in flow if hasattr(f, "style"))) else st["body"]
        flow.append(Paragraph(inline(line), style))
        i += 1

    flush_list()

    SimpleDocTemplate(
        str(pdf_path),
        pagesize=LETTER,
        leftMargin=inch,
        rightMargin=inch,
        topMargin=0.9 * inch,
        bottomMargin=0.9 * inch,
        title=md_path.stem,
    ).build(flow)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = Path(sys.argv[1])
    if not src.exists():
        print(f"No such file: {src}")
        sys.exit(1)
    if len(sys.argv) > 2:
        out = Path(sys.argv[2]).expanduser()
    else:
        # Title-cased from the filename, dropping any numeric prefix:
        # "0001-review-burden.md" -> "~/Downloads/Review Burden.pdf".
        stem = re.sub(r"^\d+[-_]", "", src.stem).replace("-", " ").replace("_", " ")
        out = Path.home() / "Downloads" / f"{stem.title()}.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    convert(src, out)
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")

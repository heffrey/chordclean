#!/usr/bin/env python3
"""
chordclean.py - Clean up a guitar tab PDF into a plain chord-over-lyric sheet.

The problem with naive text extraction from tab-site PDFs is that chords and
lyrics live on separate visual lines, and most extractors either mash them
together or float the chords off to the end of the block. This script works off
word bounding boxes instead of the text stream, so a chord that sat above the
third syllable of a line lands above the third syllable in the output.

It also strips the surrounding page furniture: ad slots, nav, comments, footers.

Usage:
    python chordclean.py input.pdf
    python chordclean.py input.pdf -o clean.txt
    python chordclean.py input.pdf --format md
    python chordclean.py input.pdf --debug        # show line classification

Requires: pdfplumber  (pip install pdfplumber)
"""

import argparse
import re
import statistics
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber is required.  pip install pdfplumber")


# --------------------------------------------------------------------------
# Chord recognition
# --------------------------------------------------------------------------

CHORD_RE = re.compile(
    r"""^
    [A-G][#b]?                                  # root
    (?:maj|min|aug|dim|sus|add|alt|m|M|\+|-|°|ø)*
    \d*
    (?:(?:maj|min|sus|add|no|omit)\d+)*
    (?:[#b+-]\d+)*
    (?:\(\w+\))?
    (?:/[A-G][#b]?)?                            # slash bass
    $""",
    re.VERBOSE,
)

# Tokens that are legal inside a chord line without being chords themselves.
CHORD_LINE_EXTRAS = re.compile(
    r"^(?:N\.?C\.?|x\d+|\d+x|\||\|\||%|/+|\(|\)|\[|\]|-+|~|\*|:|,)$", re.I
)

# Words that parse as chords but are overwhelmingly likely to be English.
AMBIGUOUS = {"A", "a", "Am", "Add", "add", "Bad", "Dad", "Cab", "Fab", "Ebb", "Age"}


def is_chord_token(tok: str) -> bool:
    tok = tok.strip(".,;:!?\"'")
    if not tok:
        return False
    if CHORD_LINE_EXTRAS.match(tok):
        return True
    return bool(CHORD_RE.match(tok))


def is_chord_line(tokens, min_ratio=0.85):
    """A line is a chord line if essentially every token on it is a chord."""
    real = [t for t in tokens if t.strip()]
    if not real:
        return False
    chordish = [t for t in real if is_chord_token(t)]
    if not chordish:
        return False
    # A lone ambiguous token ("A", "Bad") on an otherwise wordy page is a lyric.
    if len(real) == 1 and real[0] in AMBIGUOUS:
        return False
    return (len(chordish) / len(real)) >= min_ratio


# --------------------------------------------------------------------------
# Junk filtering
# --------------------------------------------------------------------------

JUNK_EXACT = {
    "advertisement", "skip ad", "view in app", "open in app", "play", "send",
    "reply", "transpose", "listen", "pdf", "print", "report bad tab",
    "show all", "versions", "related tabs", "hot chords", "all artists",
    "about ug", "site rules", "advertise", "terms of service", "privacy policy",
    "dmca", "accessibility statement", "upgrade to pro", "articles staff",
    "fresh tabs", "musehub", "guitar tuner", "discover", "other language",
    "english", "search", "comments", "chords", "strumming", "guitar",
    "español", "indonesia", "favorites", "create correction",
}

JUNK_PATTERNS = [
    re.compile(r"^\s*$"),
    re.compile(r"^\d+\s*comments?$", re.I),
    re.compile(r"^\d+(?:\.\d+)?\s*bpm$", re.I),           # tempo readout
    re.compile(r"^(?=.*&)[\d\s&+]+$"),                    # "1 & 2 & 3 & 4 &"
    re.compile(r"^ver\s*\d+\s*\d*$", re.I),
    re.compile(r"^official\s+\d+$", re.I),
    re.compile(r"^©\s*\d{4}", re.I),
    re.compile(r"all rights reserved", re.I),
    re.compile(r"^please rate this tab$", re.I),
    re.compile(r"^what do you think about this tab", re.I),
    re.compile(r"^\d[\d,]*\s+views", re.I),
    re.compile(r"^rating:", re.I),
    re.compile(r"^added to favorites", re.I),
    re.compile(r"^[#\s]*(?:[A-Z]\s+){10,}[A-Z]\s*$"),   # A B C D ... index row
    re.compile(r"^[\d,\s+]+$"),                          # stray counters
    re.compile(r"^\+\d+$"),
    re.compile(r"^\w{3}\s+\d{1,2},\s+\d{4}$"),           # comment timestamps
    re.compile(r"^_+$"),
]

# Once one of these appears, everything after it is page furniture.  The
# optional "print" prefix covers the footer arriving as one merged line.
HARD_STOP = re.compile(
    r"^(?:print|(?:print\s+)?report bad tab|please rate this tab"
    r"|\d+\s*comments?|related tabs)$",
    re.I,
)


def is_junk(text: str) -> bool:
    t = text.strip()
    if t.lower() in JUNK_EXACT:
        return True
    return any(p.match(t) for p in JUNK_PATTERNS)


# --------------------------------------------------------------------------
# Token-level junk filtering
# --------------------------------------------------------------------------
#
# Tab sites interleave UI chrome with the tab itself, so furniture does not
# reliably occupy a line of its own -- an ad label lands mid chord line
# ("C OPEN IN APP Dm") and the footer arrives merged ("Print Report Bad Tab").
# Whole-line matching misses both, so these walk the token sequence instead.

# Multi-word chrome.  No lyric says these, so they are stripped unconditionally.
JUNK_PHRASES = [
    "open in app", "view in app", "skip ad", "report bad tab",
    "add to favorites", "added to favorites", "upgrade to pro",
    "show all", "related tabs", "other language",
]

# Single words that are chrome on a tab page but ordinary English in a lyric.
# Only stripped when the word is set in a non-body font (see is_body_word).
JUNK_WORDS = {
    "play", "print", "transpose", "listen", "pdf", "send", "reply",
    "search", "favorites", "advertisement", "discover", "versions",
}

_JUNK_PHRASE_TOKENS = sorted(
    (p.split() for p in JUNK_PHRASES), key=len, reverse=True  # longest match wins
)

# The chord/lyric grid only survives in a monospace face; everything the site
# wraps around it is proportional.
_BODY_FONTS = ("Menlo", "Courier", "Mono")


def is_body_word(w) -> bool:
    return any(f in w.get("fontname", "") for f in _BODY_FONTS)


def strip_junk_tokens(words, use_font=True):
    """Drop page-furniture tokens from one line's word list.

    `use_font` is disabled for documents that render nothing in a monospace
    face, where the body/chrome distinction cannot be trusted; multi-word
    phrases are still removed.
    """
    if not words:
        return words

    toks = [w["text"].strip(".,:;").lower() for w in words]
    keep = [True] * len(words)

    i = 0
    while i < len(words):
        for phrase in _JUNK_PHRASE_TOKENS:
            n = len(phrase)
            if toks[i:i + n] == phrase:
                keep[i:i + n] = [False] * n
                i += n
                break
        else:
            if use_font and toks[i] in JUNK_WORDS and not is_body_word(words[i]):
                keep[i] = False
            i += 1

    return [w for w, k in zip(words, keep) if k]


# --------------------------------------------------------------------------
# Layout reconstruction
# --------------------------------------------------------------------------

def attach_fonts(words, chars, y_tol=1.0):
    """Record each word's dominant fontname as w['fontname'].

    Passing "fontname" to extract_words would do this for free, but it also
    makes pdfplumber start a new word wherever the font changes mid-token --
    ligatures come from a different subset, so "Difficulty:" arrives as
    "Di" + "ffi" + "culty:".  Reading the fonts back off the chars keeps words
    whole.
    """
    rows = {}
    for c in chars:
        rows.setdefault(round(c["top"] / y_tol), []).append(c)

    for w in words:
        key = round(w["top"] / y_tol)
        candidates = rows.get(key, []) + rows.get(key - 1, []) + rows.get(key + 1, [])
        names = [
            c["fontname"]
            for c in candidates
            if c["x0"] >= w["x0"] - 0.5 and c["x1"] <= w["x1"] + 0.5
        ]
        w["fontname"] = max(set(names), key=names.count) if names else ""
    return words


def extract_lines(pdf_path, y_tol=2.5):
    """Return [{'y':float,'page':int,'words':[{'text','x0','x1'}]}] in reading order."""
    lines = []
    with pdfplumber.open(pdf_path) as pdf:
        for pageno, page in enumerate(pdf.pages):
            words = page.extract_words(
                use_text_flow=False,
                keep_blank_chars=False,
                extra_attrs=["non_stroking_color", "size"],
            )
            attach_fonts(words, page.chars)
            words.sort(key=lambda w: (round(w["top"], 1), w["x0"]))
            buckets = []
            for w in words:
                for b in buckets:
                    if abs(b["y"] - w["top"]) <= y_tol:
                        b["words"].append(w)
                        break
                else:
                    buckets.append({"y": w["top"], "page": pageno, "words": [w]})
            for b in buckets:
                b["words"].sort(key=lambda w: w["x0"])
            lines.extend(sorted(buckets, key=lambda b: b["y"]))
    return lines


def char_width(lines):
    """Median rendered width of one character, used to map x -> column."""
    widths = []
    for ln in lines:
        for w in ln["words"]:
            n = len(w["text"])
            if n >= 3:
                widths.append((w["x1"] - w["x0"]) / n)
    return statistics.median(widths) if widths else 6.0


def left_margin(lines):
    xs = [ln["words"][0]["x0"] for ln in lines if ln["words"]]
    if not xs:
        return 0.0
    xs.sort()
    return xs[len(xs) // 10]  # 10th percentile, ignores stray indents


def body_font_lines(lines):
    """Lines restricted to words set in the tab's body (monospace) font.

    Page chrome in a proportional font -- nav links, sidebars, widget labels
    -- often starts well to the left of the tab's own column. Left uncut, it
    drags the 10th-percentile margin down to whatever the chrome's left edge
    is instead of the tab's, and every real line comes out over-indented.
    Restricting the statistics to body-font words keeps them reading the tab
    grid, not the page around it.
    """
    out = []
    for ln in lines:
        words = [w for w in ln["words"] if is_body_word(w)]
        if words:
            out.append({"y": ln["y"], "page": ln["page"], "words": words})
    return out


def render_chord_line(words, margin, cw):
    """Place each chord token at the column matching its x position."""
    out = ""
    for w in words:
        col = max(0, int(round((w["x0"] - margin) / cw)))
        if col < len(out):
            col = len(out) + 1  # never overwrite a previous chord
        out += " " * (col - len(out)) + w["text"]
    return out.rstrip()


def render_text_line(words, margin, cw, preserve_indent=True):
    if not preserve_indent:
        return " ".join(w["text"] for w in words).rstrip()
    indent = max(0, int(round((words[0]["x0"] - margin) / cw)))
    return (" " * indent + " ".join(w["text"] for w in words)).rstrip()


# --------------------------------------------------------------------------
# Main pipeline
# --------------------------------------------------------------------------

SECTION_RE = re.compile(r"^\[[^\]]{1,40}\]$")

# Sections that document the song rather than being part of it.  Dropped whole,
# which takes the fingering diagrams and their explanatory prose with them.
INFO_SECTIONS = re.compile(
    r"^\[\s*(?:chords?|chord diagrams?|tuning|key|capo|intro notes?|notes?)\s*\]$",
    re.I,
)

# A fingering diagram: chord name followed by a per-string fret row, "C x3555x".
DIAGRAM_RE = re.compile(r"^[A-G][#b]?\S*\s+[0-9xX]{4,6}$")


def starts_alternating_body(kept, i, pairs=2):
    """Does `kept[i]` open a run of alternating chord/lyric lines?

    Used to sanity-check the no-section-header fallback, which otherwise
    starts the body at the *first* line matching `is_chord_line` -- a chord
    row from real tab content, but also anything else on the page shaped
    like one. Ultimate Guitar's per-instrument "PLAY THIS TAB" preview
    widget prints a bare chord line above the real tab (e.g. `Am Bb`), and
    it isn't followed by lyrics, only by more widget chrome. Real content
    alternates chord/lyric/chord/lyric; furniture doesn't, so require a
    couple of pairs of it before trusting a candidate start.
    """
    window = kept[i : i + pairs * 2]
    if len(window) < pairs * 2:
        return True  # too little left on the page to check -- trust it
    kinds = [
        "CHORD" if is_chord_line([w["text"] for w in ln["words"]]) else "LYRIC"
        for ln in window
    ]
    return all(a != b for a, b in zip(kinds, kinds[1:]))


def clean(pdf_path, fmt="txt", debug=False):
    raw = extract_lines(pdf_path)
    if not raw:
        return ""

    # Only trust the font signal if this PDF actually sets the tab in monospace.
    use_font = any(is_body_word(w) for ln in raw for w in ln["words"])

    metrics_lines = body_font_lines(raw) if use_font else raw
    cw = char_width(metrics_lines)
    margin = left_margin(metrics_lines)

    # Pass 1: drop junk tokens, then junk lines, stopping at the footer.
    kept = []
    for ln in raw:
        text = " ".join(w["text"] for w in ln["words"]).strip()
        if HARD_STOP.match(text):
            break
        ln["words"] = strip_junk_tokens(ln["words"], use_font=use_font)
        text = " ".join(w["text"] for w in ln["words"]).strip()
        if is_junk(text):
            continue
        kept.append(ln)

    if not kept:
        return ""

    # Pass 2: keep only the song itself -- section headers, chord lines, lyrics.
    # Everything before the first section header is page header and metadata;
    # a section header is a far more reliable start than the first chord line,
    # which also matches the chord-diagram row above the tab.
    start = next(
        (
            i for i, ln in enumerate(kept)
            if SECTION_RE.match(" ".join(w["text"] for w in ln["words"]).strip())
        ),
        None,
    )
    if start is None:  # no section headers at all -- fall back to the first chord line
        start = next(
            (i for i, ln in enumerate(kept)
             if is_chord_line([w["text"] for w in ln["words"]])
             and starts_alternating_body(kept, i)),
            None,
        )
        if start is None:  # nothing passed that check either -- take the bare first match
            start = next(
                (i for i, ln in enumerate(kept)
                 if is_chord_line([w["text"] for w in ln["words"]])),
                0,
            )

    body = []
    in_info = False
    for ln in kept[start:]:
        text = " ".join(w["text"] for w in ln["words"]).strip()
        if SECTION_RE.match(text):
            in_info = bool(INFO_SECTIONS.match(text))
        if in_info or DIAGRAM_RE.match(text):
            continue
        body.append(ln)

    if not body:
        return ""

    # Pass 3: render, using vertical gaps to restore stanza breaks.
    gaps = [
        b["y"] - a["y"]
        for a, b in zip(body, body[1:])
        if b["page"] == a["page"] and 0 < b["y"] - a["y"] < 100
    ]
    normal_gap = statistics.median(gaps) if gaps else 14.0

    out = []
    prev = None
    prev_kind = None
    for ln in body:
        toks = [w["text"] for w in ln["words"]]
        text = " ".join(toks).strip()

        if SECTION_RE.match(text):
            kind = "SECTION"
        elif is_chord_line(toks):
            kind = "CHORD"
        else:
            kind = "LYRIC"

        if prev is not None:
            gap = ln["y"] - prev["y"]
            # A chord row and the lyric under it are one unit, so nothing may be
            # inserted between them. This matters at a page boundary: y resets,
            # so the gap arithmetic is meaningless and a page break is treated as
            # a stanza break outright. A tab that runs out of page between a
            # chord row and its words would otherwise be split, leaving the
            # chords hanging off the end of the stanza above.
            paired = prev_kind == "CHORD" and kind == "LYRIC"
            if not paired and (ln["page"] != prev["page"] or gap > normal_gap * 1.6):
                if out and out[-1] != "":
                    out.append("")

        if kind == "SECTION":
            if out and out[-1] != "":
                out.append("")
            out.append(text)
        elif kind == "CHORD":
            out.append(render_chord_line(ln["words"], margin, cw))
        else:
            out.append(render_text_line(ln["words"], margin, cw))

        if debug:
            print(f"[{kind:7}] {text[:70]}", file=sys.stderr)
        prev = ln
        prev_kind = kind

    # Collapse runs of blank lines.
    collapsed = []
    for line in out:
        if line == "" and (not collapsed or collapsed[-1] == ""):
            continue
        collapsed.append(line)

    result = "\n".join(collapsed).rstrip() + "\n"

    if fmt == "md":
        title = Path(pdf_path).stem.replace("_", " ")
        result = f"# {title}\n\n```\n{result}```\n"

    return result


def main():
    ap = argparse.ArgumentParser(
        description="Strip a tab-site PDF down to chords over lyrics."
    )
    ap.add_argument("pdf", help="input PDF")
    ap.add_argument("-o", "--out", help="output file (default: stdout)")
    ap.add_argument("--format", choices=["txt", "md"], default="txt")
    ap.add_argument("--debug", action="store_true",
                    help="print per-line classification to stderr")
    args = ap.parse_args()

    text = clean(args.pdf, fmt=args.format, debug=args.debug)

    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"Wrote {args.out} ({len(text.splitlines())} lines)", file=sys.stderr)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()

# CLAUDE.md

Notes for Claude Code working in this repo. See README.md for what the tool
does and how the filtering is layered.

## Running it

Homebrew's Python is externally managed, so installing into it fails. Use the
venv:

```
.venv/bin/python chordclean.py "<file>.pdf"
```

Rebuild with `python3 -m venv .venv && .venv/bin/pip install pdfplumber`.

Test PDFs sit in this directory and are gitignored, along with `*.txt` output.
`--debug` prints per-line classification to stderr and is the fastest way to
see why a line survived or vanished.

## Things that will bite you

**Printing the `.txt` output can split a chord row from its lyric, and
`--lines-per-page` is the opt-in answer.** TextEdit's (and most plain-text
print pipelines') pagination just counts a fixed number of lines per page,
driven by font size and page height, with no idea that a chord row and the
lyric under it are one unit -- it doesn't even respect the blank lines
chordclean uses for stanza breaks. Confirmed on a real file: a page broke
between a chord line and its lyric at line 50/51 of the output.

`paginate()` answers it with the only lever plain text has, the form feed
(`\f`), spent at stanza boundaries. Two things about it are load-bearing.
The budget is a *maximum*, so the break goes on the last boundary that
fits, never the next one past it -- overrunning would quietly hand the page
back to the printer's own line count, which is the whole thing being
avoided.
And the budget is a guess about a page chordclean cannot see, so the error
direction matters: too low costs a short page, too high lets the printer
break first. Hence opt-in and off by default -- the default output is
unchanged, and the web build and anything else parsing the text never sees
a form feed unless it asks.

**Never pass `fontname` to `page.extract_words(extra_attrs=...)`.** pdfplumber
starts a new word wherever any extra attribute changes mid-token, and ligature
glyphs come from a different font subset — `Difficulty:` comes back as `Di` +
`ffi` + `culty:`, and a chord token can split the same way. `attach_fonts()`
reads fonts off `page.chars` after extraction instead, which keeps words whole.

**The two tiers of the junk filter are not interchangeable.** `JUNK_PHRASES`
(multi-word) is stripped unconditionally. `JUNK_WORDS` (`play`, `print`,
`listen`, …) is stripped only when the word is in a non-body font, because
those are ordinary English that appears in lyrics. Moving an entry from the
second list to the first will quietly eat words out of lyrics. A single word
that could never appear in a lyric can go in `JUNK_PHRASES` as a one-word
entry; that's the escape hatch.

**`char_width` and `left_margin` are computed on the raw lines, before token
stripping.** Chord column positions derive from both. Recomputing them later
shifts every chord in the output, so eyeball the alignment if you touch pass 1
of `clean()`. They're computed over `body_font_lines(raw)`, not `raw` itself,
when the document has a detectable body font: proportional-font chrome (nav,
sidebars, widget labels) can start far to the left of the tab's own column,
and folding it into the 10th-percentile margin drags every real line's
indent out with it — see the `left_margin` docstring. Fall back to `raw`
only for documents with no monospace text at all, same as `use_font`
elsewhere.

**Section detection sets the scope.** `clean()` starts the body at the first
`[Section]` header rather than the first chord line: the chord-diagram row
above the tab matches `is_chord_line`, and starting there let the entire header
block leak through. The fallback to the first chord line exists only for PDFs
with no section headers at all, and it has the same failure mode one level
down: a PDF whose page furniture includes its own chord-shaped snippet (e.g.
Ultimate Guitar's per-instrument "PLAY THIS TAB" preview widget, which prints
something like `Am Bb` above the real tab) can make the fallback start there
instead of at the real first line, leaking the furniture between the two
through as unrecognized LYRIC. `starts_alternating_body()` guards against
this: a candidate start only counts if it opens a run of alternating
chord/lyric lines, which furniture like the preview widget doesn't (it's
followed by more widget chrome, not a lyric). If nothing satisfies that
check, the fallback still takes the bare first `is_chord_line` match rather
than giving up.

## Verifying a change

There is no test suite. Run against a real PDF and check three things.

```
.venv/bin/python chordclean.py "<file>.pdf" -o clean.txt
```

1. No furniture survived:

```
grep -niE "open in app|transpose|listen|report bad|bpm|submitted|x3555x" clean.txt
```

2. Every line classifies as one of the three kinds — this prints nothing:

```
.venv/bin/python chordclean.py "<file>.pdf" --debug 2>/tmp/dbg.txt >/dev/null
grep -vE "^\[(SECTION|CHORD|LYRIC) *\]" /tmp/dbg.txt
```

3. Chords still sit over the right syllables. Read the output. No automated
   check covers this, and it is the thing most likely to break silently.

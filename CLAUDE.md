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
of `clean()`.

**Section detection sets the scope.** `clean()` starts the body at the first
`[Section]` header rather than the first chord line: the chord-diagram row
above the tab matches `is_chord_line`, and starting there let the entire header
block leak through. The fallback to the first chord line exists only for PDFs
with no section headers at all.

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

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
of `clean()`. They're computed over `body_font_lines(raw)`, not `raw` itself,
when the document has a detectable body font: proportional-font chrome (nav,
sidebars, widget labels) can start far to the left of the tab's own column,
and folding it into the 10th-percentile margin drags every real line's
indent out with it — see the `left_margin` docstring. Fall back to `raw`
only for documents with no monospace text at all, same as `use_font`
elsewhere.

**Chord rows do not always share the lyrics' grid.** `char_width` and
`left_margin` describe the *lyric* face. UG sets the chord rows in that same
face, so they share one grid; GuitarTuna sets chords in a proportional UI face
on a grid of its own — about 1% narrower, indented half a character — and
measuring those against the lyric grid walks a chord a full column left of its
syllable by the right-hand edge of the page. `chord_grid()` derives a separate
origin and pitch, but only for a document whose chord rows and lyric rows are
in different faces. Make it fire unconditionally and you will shift every
chord in every UG sheet.

**`drift` is the other half of that.** The proportional face spends half a
column extra on each character past the first, so a single `Am` used to leave
the rest of its row sitting half a column right of the syllables it belonged
to. `chord_grid()` measures whether a document actually shows that slip rather
than assuming it, and ties go to no correction. `render_chord_line` also
rounds half-up instead of `round()`'s half-to-even, so a chord landing exactly
between two columns is placed the same way every time.

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

**Not every site brackets its headers.** GuitarTuna writes them bare —
`Verse 1`, `Outro 1` — so `PLAIN_SECTION_RE` matches a fixed vocabulary of
section names and `section_header()` normalises them into brackets. Match a
vocabulary, never a shape like "a short line of its own", or one-word lyrics
get promoted to headers. Keep emitting the bracketed form: the web build
labels output lines with `SECTION_RE`, so a bare header would render as a
lyric.

## Verifying a change

There is no test suite. Run against a real PDF and check four things. Use one
PDF from each site — the two exports differ enough that a change can look fine
on one and wreck the other.

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

4. The sheets that already worked are untouched. Anything that goes near the
   grid has to leave them alone, so capture the output *before* editing and
   diff it after:

```
.venv/bin/python chordclean.py "<ug file>.pdf" -o /tmp/before.txt   # before
.venv/bin/python chordclean.py "<ug file>.pdf" -o /tmp/after.txt    # after
diff /tmp/before.txt /tmp/after.txt
```

   For a change that is meant to affect only one site's PDFs, that diff should
   be empty for the other's.

# chordclean

Turns a guitar-tab PDF from a site like Ultimate Guitar into a plain text chord
sheet: section headers, chord lines, and lyrics, with each chord still sitting
above the syllable it belongs to.

Naive text extraction from these PDFs fails one of two ways. Either chords and
lyrics get mashed onto one line, or the chords float off to the end of the
block — chords and lyrics are separate visual rows in the source, and the text
stream doesn't record which row was above which. `chordclean` reads word
bounding boxes instead, so a chord that sat above the third syllable lands
above the third syllable.

It also drops the page furniture the site prints around the tab.

## Install

pdfplumber is the only dependency. On a Homebrew Python you need a venv, since
the interpreter is externally managed and refuses a bare `pip install`:

```
python3 -m venv .venv
.venv/bin/pip install pdfplumber
```

## Usage

```
.venv/bin/python chordclean.py input.pdf
.venv/bin/python chordclean.py input.pdf -o clean.txt
.venv/bin/python chordclean.py input.pdf --format md
.venv/bin/python chordclean.py input.pdf --debug
```

`--debug` prints how every line was classified (SECTION / CHORD / LYRIC) to
stderr. Reach for it when a line is missing from the output, or when a lyric
line got read as chords.

## What survives

Section headers, chord lines, and lyrics. Everything else is cut, including:

- the metadata block: tuning, key, difficulty, last-edit date
- fingering diagrams like `C x3555x`, and the `[Chords]` section holding them
- title, artist, and submitter lines
- site controls: ads, transpose/listen/print, tempo readouts, strum-count rows,
  comments, footer

## How the filtering works

Three signals, listed in the order they're trusted.

**Font.** The tab body is set in a monospace face; everything the site wraps
around it is proportional. That one distinction does most of the work. It is
also what makes it safe to treat a word like `play` or `print` as chrome —
only when it isn't in the body font, so a lyric containing "play" survives. A
PDF with no monospace text at all turns this signal off rather than guessing.

**Token sequence.** Furniture doesn't reliably get a line to itself. An ad
label lands mid chord line (`C OPEN IN APP Dm`); the footer arrives merged as
`Print Report Bad Tab`. So `strip_junk_tokens` walks each line's words instead
of matching the line whole. Multi-word phrases like `open in app` go
unconditionally, since no lyric says them. Single ambiguous words need the font
check above.

**Structure.** The song starts at the first `[Section]` header. Sections named
`[Chords]`, `[Tuning]` and the like are dropped entire, which removes the
fingering diagrams and their explanatory prose in one move.

## Limits

- Tuned against Ultimate Guitar's PDF export. Another site's furniture needs
  its own entries in `JUNK_PHRASES` and `JUNK_WORDS`.
- Chord detection is a regex (`CHORD_RE`). Unusual spellings may fall through
  to lyrics; `--debug` shows you.
- A chord line made entirely of words that are also English (`A`, `Am`, `Add`)
  can be misread. `AMBIGUOUS` holds the current exceptions.

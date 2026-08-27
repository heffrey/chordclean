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

What comes out is a lead sheet, so it is as useful at a piano or for singing as
it is with a guitar in your hands.

There is a hosted version at **<https://chordclean.com>** if you would rather
not install anything. It runs this same script in your browser; the PDF is
never uploaded.

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

## The website

`web/` holds [chordclean.com](https://chordclean.com). There is no server and no
API: `chordclean.py` is served as a static file and run **unmodified** in the
visitor's browser by [Pyodide](https://pyodide.org), inside a Web Worker. The
PDF never leaves the machine it was dropped on, so nothing is uploaded, stored,
or logged, and there is nothing to bill per request.

Two details make that work. `pdfplumber` declares `pypdfium2` and Pillow, but
both are reachable only through its `to_image()` path, which this script never
calls. `pypdfium2` has no Emscripten wheel at all, so the worker stubs both
out. And the Pyodide runtime is self-hosted rather than pulled from a CDN,
which keeps PyPI out of the request path and lets the site run under a
same-origin CSP.

```
cd web
npm install
npm run dev            # local, at http://localhost:8788
npm run deploy         # to Cloudflare
```

Both commands first copy `chordclean.py` in from the repo root and assemble the
runtime under `public/pyodide/` (~22MB, gitignored), so the site cannot drift
from the CLI tool.

Output is verified by hashing: the browser and a local venv produce
byte-identical text for the same PDF.

### The link preview

`web/og/og.html` is the source for the card that Slack, iMessage and the rest
show when someone pastes the link: a real cleaned verse, at a size that still
reads once the card is scaled down to a thumbnail. Edit that file and re-render:

```
cd web
npm run build:og      # writes public/og.png, 1200x630
```

It drives whatever Chrome or Chromium is already on the machine, so there is
nothing to install; set `CHROME_PATH` if it cannot find one. `public/og.png` is
committed, so a deploy never needs a browser.

## Support

chordclean is free. If it saved you some typing,
[buy me a coffee](https://ko-fi.com/jeffwhi).

## License

MIT. See [LICENSE](LICENSE).

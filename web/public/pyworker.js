// Runs chordclean.py under Pyodide, off the main thread.
//
// Living in a Web Worker is not an optimisation -- it is what makes a
// pathological PDF survivable. pdfminer can spin for a long time on a
// malformed file, and on the main thread that freezes the tab with no way
// out. Here the page stays responsive and can terminate() us outright.

// This is a module worker, and it has to be: Pyodide 314 refuses to load in a
// classic worker ("Classic web workers are not supported"), so importScripts
// is not an option and app.js must construct us with { type: "module" }.
//
// The runtime is served from this origin (see scripts/build-runtime.mjs)
// rather than a CDN, which keeps PyPI out of the request path at runtime and
// lets the site run under a same-origin-only CSP.
import { loadPyodide } from "/pyodide/pyodide.mjs";

const RUNTIME = "/pyodide/";

// The one piece of glue the browser build needs. It reuses chordclean's own
// predicates to label each output line rather than re-deriving them in JS --
// a second implementation of is_chord_line would drift from the first.
const GLUE = `
import json
import chordclean

def render(path):
    text = chordclean.clean(path)
    if not text.strip():
        return json.dumps({"lines": []})
    lines = []
    for line in text.rstrip("\\n").split("\\n"):
        stripped = line.strip()
        if not stripped:
            kind = "blank"
        elif chordclean.SECTION_RE.match(stripped):
            kind = "section"
        elif chordclean.is_chord_line(stripped.split()):
            kind = "chord"
        else:
            kind = "lyric"
        lines.append({"kind": kind, "text": line})
    return json.dumps({"lines": lines, "text": text})
`;

let pyodide = null;
let renderFn = null;

const status = (stage, detail) => postMessage({ type: "status", stage, detail });

async function boot() {
  status("boot", "starting Python");
  pyodide = await loadPyodide({ indexURL: RUNTIME });

  status("boot", "loading pdfplumber");
  await pyodide.loadPackage("micropip");

  // Wheel filenames carry versions, so the build script emits them rather
  // than having a version string to keep in sync in two places.
  const wheels = await fetch(`${RUNTIME}wheels.json`).then((r) => r.json());
  // Passed as JSON rather than a JS array so Python gets a real list instead
  // of a proxy it has to unwrap.
  pyodide.globals.set("_wheel_urls", JSON.stringify(wheels.pypi.map((f) => RUNTIME + f)));

  // pdfplumber declares pypdfium2 and Pillow, but both are reachable only
  // through display.py (to_image), which page.py imports lazily inside its
  // methods. chordclean never calls it. pypdfium2 has no Emscripten wheel at
  // all, so stubbing is not merely an optimisation -- it is the only way this
  // runs in a browser. Verified byte-identical against a native venv run.
  await pyodide.runPythonAsync(`
import micropip, sys, types, json
for _stub in ("pypdfium2", "PIL", "PIL.Image", "PIL.ImageDraw"):
    sys.modules[_stub] = types.ModuleType(_stub)
_plumber, _miner = json.loads(_wheel_urls)
# deps=False on pdfplumber skips pypdfium2/Pillow, which are stubbed above.
# pdfminer.six keeps its deps; they resolve out of the local lockfile.
await micropip.install(_plumber, deps=False)
await micropip.install(_miner)
`);

  status("boot", "loading chordclean");
  const src = await fetch("/chordclean.py").then((r) => {
    if (!r.ok) throw new Error(`chordclean.py: HTTP ${r.status}`);
    return r.text();
  });
  pyodide.FS.writeFile("/chordclean.py", src);
  await pyodide.runPythonAsync(`import sys; sys.path.insert(0, "/")`);

  renderFn = await pyodide.runPythonAsync(`${GLUE}\nrender`);
  status("ready");
}

const booted = boot().catch((err) => {
  postMessage({ type: "fatal", message: String(err && err.message ? err.message : err) });
  throw err;
});

onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== "clean") return;

  try {
    await booted;
    pyodide.FS.writeFile("/in.pdf", new Uint8Array(msg.buf));
    let json;
    try {
      json = renderFn("/in.pdf");
    } finally {
      // Never leave a visitor's document sitting in the VM between runs.
      try { pyodide.FS.unlink("/in.pdf"); } catch (_) {}
    }
    postMessage({ type: "result", id: msg.id, ...JSON.parse(json) });
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    // Pyodide surfaces the whole Python traceback; the last line is the part
    // that means anything to someone holding a PDF that did not work.
    const last = text.trim().split("\n").filter(Boolean).pop() || text;
    postMessage({ type: "error", id: msg.id, message: last });
  }
};

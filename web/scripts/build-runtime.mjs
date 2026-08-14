// Assembles a self-contained Pyodide runtime under public/pyodide/.
//
// Everything is served same-origin on purpose. A worker cannot reliably
// importScripts() from a cross-origin CDN -- Chrome refuses it even when the
// page can fetch the identical URL -- and pulling wheels from PyPI at runtime
// would put a third party in the path of every visit and leak usage to them.
// Self-hosting also lets the site run under a same-origin-only CSP.
//
// Run: npm run build:runtime   (idempotent; skips files already downloaded)

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const OUT = path.join(WEB, "public", "pyodide");
const PYODIDE_DIR = path.join(WEB, "node_modules", "pyodide");

const VERSION = JSON.parse(
  await fs.readFile(path.join(PYODIDE_DIR, "package.json"), "utf8"),
).version;
const CDN = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full`;

// Core runtime, copied straight out of the npm package. pyodide.mjs is the
// ESM entrypoint the module worker imports -- the classic pyodide.js build is
// deliberately not shipped, because Pyodide 314 cannot load in a classic
// worker at all.
const RUNTIME = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

// Resolved empirically: the closure required for `import pdfplumber` to
// succeed with PIL and pypdfium2 stubbed out. See pyworker.js.
const FROM_LOCK = [
  "micropip", "cffi", "charset-normalizer", "cryptography", "pycparser", "six",
];

// Pure-Python, not in Pyodide's distribution.
const FROM_PYPI = ["pdfplumber", "pdfminer.six"];

async function download(url, dest) {
  if (existsSync(dest)) return { skipped: true, dest };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return { skipped: false, dest };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  for (const name of RUNTIME) {
    await fs.copyFile(path.join(PYODIDE_DIR, name), path.join(OUT, name));
  }
  console.log(`runtime: ${RUNTIME.length} files from pyodide@${VERSION}`);

  const lock = JSON.parse(await fs.readFile(path.join(OUT, "pyodide-lock.json"), "utf8"));
  for (const name of FROM_LOCK) {
    const entry = lock.packages[name] || lock.packages[name.replace(/-/g, "_")];
    if (!entry) throw new Error(`not in pyodide-lock.json: ${name}`);
    const { skipped } = await download(`${CDN}/${entry.file_name}`, path.join(OUT, entry.file_name));
    console.log(`  ${skipped ? "have" : "get "} ${entry.file_name}`);
  }

  const pypiNames = [];
  for (const pkg of FROM_PYPI) {
    const meta = await fetch(`https://pypi.org/pypi/${pkg}/json`).then((r) => r.json());
    const wheel = meta.urls.find(
      (u) => u.packagetype === "bdist_wheel" && u.filename.endsWith("-py3-none-any.whl"),
    );
    if (!wheel) throw new Error(`no pure-python wheel for ${pkg}`);
    const { skipped } = await download(wheel.url, path.join(OUT, wheel.filename));
    console.log(`  ${skipped ? "have" : "get "} ${wheel.filename}`);
    pypiNames.push(wheel.filename);
  }

  // The worker needs the exact wheel filenames; versions move, so emit them
  // rather than hard-coding a version string in two places.
  await fs.writeFile(
    path.join(OUT, "wheels.json"),
    JSON.stringify({ pyodideVersion: VERSION, pypi: pypiNames }, null, 2) + "\n",
  );

  let total = 0;
  for (const f of await fs.readdir(OUT)) {
    total += (await fs.stat(path.join(OUT, f))).size;
  }
  console.log(`\npublic/pyodide/ = ${(total / 1048576).toFixed(1)}MB`);
}

await main();

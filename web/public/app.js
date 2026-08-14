(() => {
  "use strict";

  const MAX_BYTES = 12 * 1024 * 1024;   // a tab sheet is ~100KB; 12MB is absurd already
  const CLEAN_TIMEOUT_MS = 60_000;

  const drop = document.getElementById("drop");
  const fileInput = document.getElementById("file");
  const statusEl = document.getElementById("status");
  const outputEl = document.getElementById("output");
  const sheetEl = document.getElementById("sheet");
  const songnameEl = document.getElementById("songname");
  const intakeEl = document.getElementById("intake");

  let worker = null;
  let booted = false;
  let fatal = null;
  let pending = null;      // { id, timer, name }
  let nextId = 1;
  let lastText = "";
  let lastName = "chords";

  // ---------------------------------------------------------------- worker

  function spawn() {
    // Must be a module worker -- Pyodide 314 refuses to load in a classic one.
    worker = new Worker("pyworker.js", { type: "module" });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => die(e.message || "the Python runtime failed to start");
  }

  // A worker that died during boot is never coming back on its own, and the
  // failure is silent from the visitor's side. Latch it, so the next drop
  // reports the real reason instead of spinning on "Working…" forever.
  function die(message) {
    fatal = message;
    setBusy(false);
    clearPending();
    fail(`chordclean couldn't start — ${message}`);
  }

  // A hung parse cannot be cancelled from inside Python, so the only real
  // recovery is to throw the whole worker away and boot a fresh one.
  function restart(reason) {
    if (worker) worker.terminate();
    clearPending();
    booted = false;
    fatal = null;
    spawn();
    fail(reason);
  }

  function clearPending() {
    if (pending && pending.timer) clearTimeout(pending.timer);
    pending = null;
  }

  function onWorkerMessage(event) {
    const msg = event.data;

    if (msg.type === "status") {
      if (msg.stage === "ready") {
        booted = true;
        if (!pending) setStatus("");
        return;
      }
      // Show boot progress even before a file is chosen: it is a ~10MB
      // download, and silence for ten seconds reads as a broken page.
      setStatus(msg.detail ? `Warming up — ${msg.detail}…` : "Warming up…");
      return;
    }
    if (msg.type === "fatal") { die(msg.message); return; }
    if (!pending || msg.id !== pending.id) return;   // stale reply, ignore

    if (msg.type === "error") {
      clearPending();
      setBusy(false);
      fail(`Couldn't read that PDF — ${msg.message}`);
      return;
    }

    if (msg.type === "result") {
      const name = pending.name;
      clearPending();
      setBusy(false);
      if (!msg.lines || msg.lines.length === 0) {
        fail("No chords or lyrics found in that PDF. Is it a tab sheet?");
        return;
      }
      show(msg.lines, msg.text, name);
    }
  }

  // ------------------------------------------------------------------ ui

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function fail(message) { setStatus(message, true); }

  function setBusy(busy) { drop.classList.toggle("busy", busy); }

  function show(lines, text, name) {
    lastText = text;
    lastName = name.replace(/\.pdf$/i, "") || "chords";

    // Built as nodes, never as an HTML string. Every character here came out
    // of an untrusted PDF, and "render the txt nicely" is exactly the wish
    // that tempts you into innerHTML and a script tag smuggled in a chord.
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const div = document.createElement("div");
      div.className = `ln ${line.kind}`;
      div.textContent = line.text;
      frag.appendChild(div);
    }
    sheetEl.replaceChildren(frag);

    songnameEl.textContent = lastName;
    outputEl.hidden = false;
    setStatus("");
    outputEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function reset() {
    outputEl.hidden = true;
    sheetEl.replaceChildren();
    fileInput.value = "";
    setStatus("");
    intakeEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // --------------------------------------------------------------- intake

  function handle(file) {
    if (!file) return;
    if (pending) return;
    if (fatal) { fail(`chordclean couldn't start — ${fatal}`); return; }

    const looksPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!looksPdf) { fail("That's not a PDF."); return; }
    if (file.size > MAX_BYTES) {
      fail(`That file is ${(file.size / 1048576).toFixed(1)}MB — the limit is 12MB.`);
      return;
    }

    setBusy(true);
    setStatus("Reading…");

    file.arrayBuffer().then((buf) => {
      const id = nextId++;
      pending = {
        id,
        name: file.name,
        timer: setTimeout(() => {
          setBusy(false);
          restart("That PDF took too long and was stopped. It may be malformed.");
        }, CLEAN_TIMEOUT_MS),
      };
      setStatus("Working…");
      worker.postMessage({ type: "clean", id, buf }, [buf]);
    }).catch(() => {
      setBusy(false);
      fail("Couldn't read that file off disk.");
    });
  }

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => handle(fileInput.files[0]));

  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, () => drop.classList.remove("over"));
  }
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    handle(e.dataTransfer.files[0]);
  });

  // Dropping anywhere but the zone should not make the browser navigate away
  // to the PDF, which looks exactly like the app crashing.
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (e) => e.preventDefault());
  }

  // --------------------------------------------------------------- actions

  document.getElementById("copy").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(lastText);
      const btn = e.currentTarget;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 1400);
    } catch {
      fail("Clipboard blocked — select the text and copy manually.");
    }
  });

  document.getElementById("download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([lastText], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lastName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("again").addEventListener("click", reset);

  // Boot Python immediately rather than on first drop: the download is the
  // slow part, and it overlaps with the visitor finding their file.
  spawn();
})();

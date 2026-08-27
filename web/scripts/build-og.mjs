// Renders og/og.html to public/og.png, the 1200x630 link-preview card.
//
// Run: npm run build:og
//
// The output is committed, so this only needs running when og/og.html
// changes -- a deploy never touches it.
//
// It drives a local Chromium over the DevTools protocol rather than shelling
// out to `chromium --screenshot`. New headless sizes --window-size as the
// window, not the viewport, so the page gets a viewport ~87px shorter than
// asked for and the screenshot comes back with the bottom of the card unpainted.
// Emulation.setDeviceMetricsOverride sets the viewport itself, which is the
// only way to be sure the PNG is exactly 1200x630 on any machine.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIDTH = 1200;
const HEIGHT = 630;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const SOURCE = path.join(WEB, "og", "og.html");
const OUT = path.join(WEB, "public", "og.png");

// `npm install` here does not fetch a browser, so this looks for one the
// machine already has. CHROME_PATH wins; a Playwright download is worth
// checking for, since a repo checkout often has one lying around.
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PLAYWRIGHT_BROWSERS_PATH && path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);

async function findChrome() {
  for (const candidate of CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(
    "no Chrome or Chromium found. Set CHROME_PATH to one:\n" +
    "  CHROME_PATH=/path/to/chrome npm run build:og",
  );
}

// Chromium prints the port it actually bound to into the profile directory.
// Asking for port 0 and reading it back beats guessing a free one.
async function readPort(profile) {
  const file = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    try {
      const [port] = (await fs.readFile(file, "utf8")).split("\n");
      if (port) return Number(port);
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chromium never reported a DevTools port");
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const waiting = new Map();
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && waiting.has(msg.method)) {
      waiting.get(msg.method)();
      waiting.delete(msg.method);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), { once: true });
  });

  return {
    ready,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolve) => waiting.set(method, resolve));
    },
  };
}

const chrome = await findChrome();
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "chordclean-og-"));

const args = [
  "--headless",
  "--remote-debugging-port=0",
  // Larger than the card on purpose. The emulated viewport below can be
  // smaller than the real window but not larger: ask for more than the window
  // holds and the capture samples the undersized surface, tiling the card
  // across the frame instead of clipping it.
  `--window-size=${WIDTH},${HEIGHT + 200}`,
  `--user-data-dir=${profile}`,
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--disable-gpu",
  "about:blank",
];
// Chromium refuses to run sandboxed as root, which is the normal case inside
// a container. Nothing but a local file of ours is ever loaded here.
if (process.getuid?.() === 0) args.push("--no-sandbox");

const browser = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore"] });
const exited = new Promise((resolve) => browser.once("exit", resolve));
let cdp;

try {
  const port = await readPort(profile);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("Chromium opened no page target");

  cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;

  // The viewport, set explicitly. This is the whole reason for the protocol.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send("Page.enable");
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: pathToFileURL(SOURCE).href });
  // A build that hangs forever is worse than one that fails.
  await Promise.race([
    loaded,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("og.html never finished loading")), 20_000)),
  ]);

  // A resized viewport needs a frame to compose before it can be read back.
  await cdp.send("Runtime.evaluate", {
    expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    awaitPromise: true,
  });

  // captureBeyondViewport re-renders the clip rather than reading back the
  // compositor surface. Without it the window's own smaller surface is what
  // gets sampled, and the card comes back tiled across the 1200x630 frame.
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    captureBeyondViewport: true,
  });

  const png = Buffer.from(data, "base64");
  await fs.writeFile(OUT, png);
  console.log(`og.png  ${WIDTH}x${HEIGHT}  ${(png.length / 1024).toFixed(0)}KB`);
} finally {
  cdp?.close();
  browser.kill();
  // Chromium is still flushing its profile directory as it goes down, and
  // removing the tree out from under it races into an ENOTEMPTY.
  await exited;
  await fs.rm(profile, { recursive: true, force: true });
}

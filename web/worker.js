// Static assets, plus one counter.
//
// Requests that match a file in public/ are served straight from the asset
// store without invoking this Worker at all, so the only thing that actually
// runs here is /api/cleaned.

const DAY = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cleaned") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      // Count only calls the site itself made. This stops stray curls and
      // crawlers from inflating the number; it will not stop someone
      // determined, and the tally is not worth defending harder than this.
      if (request.headers.get("Origin") !== url.origin) {
        return new Response(null, { status: 204 });
      }

      try {
        await env.DB.prepare(
          "INSERT INTO cleans (day, n) VALUES (?, 1) " +
          "ON CONFLICT(day) DO UPDATE SET n = n + 1",
        ).bind(DAY()).run();
      } catch {
        // A counter is never worth failing a visitor's request over.
      }

      return new Response(null, { status: 204 });
    }

    return env.ASSETS.fetch(request);
  },
};

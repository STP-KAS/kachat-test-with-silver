import { defineConfig } from "vite";
import http from "node:http";
import https from "node:https";

// Same-origin Nextcloud proxy. The desktop app runs in a browser, and stock Nextcloud sends no
// CORS headers on WebDAV/OCS — so ui/nextcloud.js routes every API call through
//   /nc-proxy/<encodeURIComponent(origin)>/<path>
// and this middleware forwards it server-side, where CORS doesn't exist. Public /s/TOKEN share
// links are NOT proxied — recipients open those on the real server.
//
// Note: with `--host 0.0.0.0` this proxy is reachable from the LAN like the rest of the dev
// server — it forwards only to the origin encoded in each request's own path (no ambient
// credentials; the browser supplies the Authorization header per request).
function nextcloudProxy() {
  // One handler, mounted on BOTH the dev server and the preview server. `configureServer` alone
  // meant the proxy existed only while running `vite dev`, which is why the deployment ran the dev
  // server - a dev server serving the public site, with no minification and no content-hashed
  // filenames, so a returning visitor could be handed a stale module. `vite build` + `vite preview`
  // hashes every asset (permanent cache-busting, no hand-maintained ?v= numbers) and this hook is
  // what lets Nextcloud keep working there.
  const mount = (server) => {
    server.middlewares.use("/nc-proxy", (req, res) => {
        // connect strips the "/nc-proxy" mount prefix, so req.url is "/<origin>/<path>?<query>".
        const match = /^\/([^/]+)(\/.*)?$/.exec(req.url || "");
        let origin = null;
        try {
          origin = match ? new URL(decodeURIComponent(match[1])) : null;
        } catch { /* handled below */ }
        if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:")) {
          res.statusCode = 400;
          res.end("Bad proxy target");
          return;
        }
        // SSRF guard: this proxy is reachable from the LAN (--host 0.0.0.0) and, through the
        // reverse proxy, from the internet — so it must never forward into the dev machine
        // itself or the link-local/cloud-metadata range. RFC1918 LAN targets stay allowed on
        // purpose (a self-hosted Nextcloud on the LAN is a supported setup). Note: a public
        // DNS name resolving to a blocked address (rebinding) is not caught here — this is a
        // dev-server hardening layer, not a security boundary for production.
        const host = origin.hostname.toLowerCase();
        const blockedHost = host === "localhost" || host === "0.0.0.0" || host.endsWith(".localhost")
          || /^127\./.test(host) || host === "::1" || host === "[::1]"
          || /^169\.254\./.test(host) || host === "metadata.google.internal";
        if (blockedHost) {
          res.statusCode = 403;
          res.end("Proxy target not allowed");
          return;
        }
        const headers = { ...req.headers, host: origin.host };
        // The browser's origin/referer would confuse some reverse-proxy setups — drop them.
        delete headers.origin;
        delete headers.referer;
        // Link-preview scrape (x-preview): use a crawler User-Agent so sites emit their og:image /
        // og:title the way they do for Facebook/Slack unfurlers (a plain browser UA increasingly
        // gets a login/consent wall). Mirrors iOS LinkPreviewService's facebookexternalhit UA.
        // EXCEPTION: Twitter/X 404s the crawler UA but DOES serve Open Graph tags to a real browser
        // UA (the opposite of Instagram/Facebook) - so use a browser UA there. iOS/Android already
        // scrape non-Meta hosts like x.com with a browser UA, which is why they preview it fine.
        if (headers["x-preview"] === "1") {
          const host = origin.hostname.replace(/^www\./, "").toLowerCase();
          const browserUaHosts = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
          headers["user-agent"] = browserUaHosts.has(host)
            ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
            : "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
          delete headers.accept;
          headers.accept = "text/html,application/xhtml+xml";
        }
        delete headers["x-preview"];
        // Opt-in "soft 404": APIs that use 404 to mean "not found, and that's normal" (KNS
        // primary-name lookups for addresses without domains) make the browser console scream
        // red for every answer. When the caller sends x-proxy-soft-404, an upstream 404 is
        // returned as 200 with x-upstream-status: 404 so the client can still detect it.
        const soft404 = headers["x-proxy-soft-404"] === "1";
        delete headers["x-proxy-soft-404"];

        // Redirects are followed SERVER-SIDE (GET/HEAD, capped hops): passing a 3xx through
        // hands the browser a cross-origin Location it follows directly and gets CORS-blocked
        // on (seen with maps.apple short links in link previews).
        const MAX_REDIRECT_HOPS = 5;
        function forward(target, hop) {
          const client = target.protocol === "http:" ? http : https;
          const upstream = client.request(
            {
              protocol: target.protocol,
              hostname: target.hostname,
              port: target.port || (target.protocol === "http:" ? 80 : 443),
              method: req.method,
              path: `${target.pathname}${target.search}` || "/",
              headers: { ...headers, host: target.host },
            },
            (upstreamRes) => {
              const status = upstreamRes.statusCode || 502;
              const location = upstreamRes.headers.location;
              if (location && status >= 300 && status < 400 && hop < MAX_REDIRECT_HOPS
                  && (req.method === "GET" || req.method === "HEAD")) {
                upstreamRes.resume(); // discard the redirect body
                let next = null;
                try { next = new URL(location, target); } catch { next = null; }
                // A redirect must obey the same SSRF guard as the original target.
                const nextHost = (next?.hostname || "").toLowerCase();
                const nextBlocked = !next || nextHost === "localhost" || nextHost === "0.0.0.0"
                  || nextHost.endsWith(".localhost") || /^127\./.test(nextHost) || nextHost === "::1"
                  || nextHost === "[::1]" || /^169\.254\./.test(nextHost) || nextHost === "metadata.google.internal";
                if (!nextBlocked && (next.protocol === "http:" || next.protocol === "https:")) {
                  forward(next, hop + 1);
                  return;
                }
              }
              const mask404 = soft404 && upstreamRes.statusCode === 404;
              const responseHeaders = { ...upstreamRes.headers };
              if (mask404) responseHeaders["x-upstream-status"] = "404";
              res.writeHead(mask404 ? 200 : status, responseHeaders);
              upstreamRes.pipe(res);
            },
          );
          upstream.on("error", (error) => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
            res.end(`Proxy error: ${error.message}`);
          });
          // Only the FIRST hop carries the browser's request body; redirect hops are GET/HEAD.
          if (hop === 0) req.pipe(upstream);
          else upstream.end();
        }
        forward(new URL(match[2] || "/", `${origin.protocol}//${origin.host}`), 0);
    });
  };
  return {
    name: "kachat-nextcloud-proxy",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  plugins: [nextcloudProxy()],
  server: {
    // Vite rejects unknown Host headers by default; allow access via the
    // DuckDNS domain fronted by Nginx Proxy Manager.
    allowedHosts: [".duckdns.org"],
  },
  // Same allowance for the built site, which is what the public deployment should serve.
  preview: {
    host: "0.0.0.0",
    allowedHosts: [".duckdns.org"],
  },
});

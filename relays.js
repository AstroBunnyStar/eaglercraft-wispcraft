/* Curated WISP relays for the launcher. One entry per distinct backend.
   Dropped on review: 18 links.gointospace.app wildcard-DNS aliases (one gateway service,
   any subdomain resolves), three sslip.io aliases of the same IP, and a relay that
   answers 401. Each duplicate only cost a socket and a slot in the pre-flight probe. */
window.WispRelays = (function () {
  var KEY = "wispcraft_wispurl";
  var DEFAULT = "wss://anura.pro/";
  var LIST = [
    "wss://anura.pro/",
    "wss://us-east.wisp.q13x.com/",
    "wss://truffled.lol/wisp/",
    "wss://fern.best/wisp/",
    "wss://admin.proxy.hydrovolter.com/wisp/",
    "wss://bare-server.fly.dev/wisp/",
    "wss://linuxontab-net.fly.dev/wisp/",
    "wss://myproxy-zeta.vercel.app/wisp/",
    "wss://daydreamx.pro/wisp/",
    "wss://studyworkandmore.uk/wisp/",
    "wss://motor-cycle-part.org/wisp/",
    "wss://wisp.anjomous.workers.dev/",
    "wss://speedster.heavengtwashere.workers.dev/wisp/",
    "wss://civil.quartinal.me/wisp/",
    "wss://zodiac.icu/wisp/",
    "wss://orbitweb.org/campus/",
    "wss://wisp.terbiumon.top/wisp/",
    "wss://vibeos.sh/api/wisp/",
    "wss://invisiproxy.com/wisp/",
    "wss://xh4r26oz8gg460od.oid76seqraqkbvwx.mvd.hi.stack.ddnsfree.com/wisp/",
    "wss://api.hfhj.links.gointospace.app/wisp/",
    "wss://dkwmkvruzebnqlmvwzhy.supabase.co/functions/v1/proxy-wisp/"
  ];

  function normalize(url) {
    if (!url) return null;
    try {
      var u = new URL(String(url).trim());
      if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
      if (!u.pathname.endsWith("/")) u.pathname += "/";
      return u.href;
    } catch (e) { return null; }
  }

  function host(url) {
    try { return new URL(normalize(url) || url).host; } catch (e) { return String(url); }
  }

  function stored() {
    try { return normalize(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  /* the bundle falls back to its own default when nothing was chosen */
  function current() { return stored() || DEFAULT; }

  function set(url) {
    var n = normalize(url);
    if (!n) return null;
    try { localStorage.setItem(KEY, n); } catch (e) { return null; }
    return n;
  }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

  /* A relay is usable if it accepts the WebSocket handshake. That is the same test the
     game performs, and a timeout is reported as unreachable rather than as broken. */
  function probe(url, timeout) {
    var target = normalize(url);
    return new Promise(function (resolve) {
      if (!target) return resolve({ url: String(url), ok: false, ms: 0 });
      var started = Date.now(), done = false, ws = null, timer = null;
      function finish(ok) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { if (ws) ws.close(); } catch (e) {}
        resolve({ url: target, ok: ok, ms: Date.now() - started });
      }
      timer = setTimeout(function () { finish(false); }, timeout || 3500);
      try { ws = new WebSocket(target); } catch (e) { finish(false); return; }
      ws.onopen = function () { finish(true); };
      ws.onerror = function () { finish(false); };
      ws.onclose = function () { finish(false); };
    });
  }

  /* Resolves with whatever settled, so one relay that never answers cannot stall the
     caller (timeouts are heavily throttled while the tab is in the background). */
  function probeAll(timeout) {
    var t = timeout || 3500;
    return new Promise(function (resolve) {
      var out = [], left = LIST.length, done = false;
      function finish() { if (done) return; done = true; resolve(out.filter(Boolean)); }
      LIST.forEach(function (u, i) {
        probe(u, t).then(function (r) { out[i] = r; if (--left === 0) finish(); });
      });
      setTimeout(finish, t + 500);
    });
  }

  return { DEFAULT: DEFAULT, host: host, stored: stored, current: current,
           set: set, clear: clear, probe: probe, probeAll: probeAll };
})();

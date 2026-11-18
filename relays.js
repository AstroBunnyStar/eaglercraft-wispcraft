/* Curated WISP relays for the launcher. One entry per distinct backend.
   Dropped on review: 18 links.gointospace.app wildcard-DNS aliases (one gateway service,
   any subdomain resolves), three sslip.io aliases of the same IP, and a relay that
   answers 401. Each duplicate only cost a socket and a slot in the pre-flight probe. */
window.WispRelays = (function () {
  var KEY = "wispcraft_wispurl";
  /* Used only until the player picks a relay. The list is ordered for reading, not precedence:
     the launcher ranks relays by its own probe. Why this one, how it was measured and how to
     refresh it are in PATCHES.md ("Relay default"); tools/patch-wispcraft.mjs reads this value
     so the bundle's pinned fallback cannot drift from it. */
  var DEFAULT = "wss://linuxontab-net.fly.dev/wisp/";
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

  /* A relay is only usable if it can carry traffic. Accepting the WebSocket handshake is not
     enough: a relay can accept the socket and then never open a stream, which is how the old
     "does it open?" test passed on relays that stalled in game. This opens a real TCP stream,
     sends a request and waits for the reply, so a silent relay fails here instead.
     Both protocol versions share one packet layout - [type][streamID u32 LE][payload], all
     little-endian (wisp-protocol, "Packet format"); v2 only adds an INFO handshake. The greeting
     is a CONTINUE for stream 0 and must arrive before the client sends anything. */
  var TEST_HOST = "example.com";
  var TEST_PORT = 80;
  var TEST_REQUEST = "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n";
  var CONTINUE = 0x03, DATA = 0x02, CLOSE = 0x04;

  function probe(url, timeout) {
    var target = normalize(url);
    return new Promise(function (resolve) {
      if (!target) return resolve({ url: String(url), ok: false, ms: 0 });
      var started = Date.now(), done = false, ws = null, timer = null, sent = false;
      function finish(ok) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        /* closing a socket that is still connecting logs a browser warning, so let a late open
           close itself instead */
        try { if (ws && ws.readyState === 1) ws.close(); } catch (e) {}
        resolve({ url: target, ok: ok, ms: Date.now() - started });
      }
      function hostBytes() {
        var out = new Uint8Array(TEST_HOST.length);
        for (var i = 0; i < TEST_HOST.length; i++) out[i] = TEST_HOST.charCodeAt(i);
        return out;
      }
      function send() {
        if (sent || done) return;
        sent = true;
        var connectHead = [0x01, 1, 0, 0, 0];                   /* type, then stream ID 1 */
        var dataHead = [0x02, 1, 0, 0, 0];
        var connect = new Uint8Array(connectHead.length + 3 + TEST_HOST.length);
        connect.set(connectHead, 0);
        connect[connectHead.length] = 0x01;                       /* stream type: TCP */
        connect[connectHead.length + 1] = TEST_PORT & 255;
        connect[connectHead.length + 2] = (TEST_PORT >> 8) & 255;
        connect.set(hostBytes(), connectHead.length + 3);
        var request = new Uint8Array(dataHead.length + TEST_REQUEST.length);
        request.set(dataHead, 0);
        for (var i = 0; i < TEST_REQUEST.length; i++) {
          request[dataHead.length + i] = TEST_REQUEST.charCodeAt(i) & 255;
        }
        try { ws.send(connect); ws.send(request); } catch (e) { finish(false); }
      }
      timer = setTimeout(function () { finish(false); }, timeout || 3500);
      try { ws = new WebSocket(target); } catch (e) { finish(false); return; }
      ws.binaryType = "arraybuffer";
      /* a relay that opens and never greets is broken: the greeting is mandatory */
      ws.onopen = function () { if (done) { try { ws.close(); } catch (e) {} } };
      ws.onmessage = function (ev) {
        var d = new Uint8Array(ev.data);
        if (d[0] === CONTINUE) { send(); return; }
        if (d[0] === DATA) {
          var at = 5, head = "";
          for (var i = 0; i < 5 && at + i < d.length; i++) head += String.fromCharCode(d[at + i]);
          finish(head === "HTTP/");
          return;
        }
        if (d[0] === CLOSE) finish(false);
      };
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

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

  /* Sign-in pre-flight. Microsoft sign-in is a TLS stream the client sends *through the relay*,
     so a relay whose egress cannot complete that handshake leaves the player looking at
     `hyper ... tls handshake eof` with no device code at all - a failure the plain-HTTP check
     below cannot see. This sends a real TLS 1.2 ClientHello for login.microsoftonline.com
     (269 bytes, captured from a TLS stack, not hand-written: a hand-built one is rejected and
     every relay then looks broken) and passes only on a ServerHello record. Counting any bytes
     back is not enough: a TLS alert also crosses in both directions, so it would turn "Microsoft
     refused this connection" into a green sign-in test the client cannot actually use.
     The hello is queued straight after CONNECT instead of after a CONTINUE on the new stream:
     several relays in LIST never send that CONTINUE, and waiting for it made healthy relays
     time out. The host is in the hello's SNI, so one fixed byte string works for every relay;
     test/relays-signin.test.mjs parses the constant and fails if that stops being true. */
  var SIGNIN_HOST = "login.microsoftonline.com";
  var SIGNIN_PORT = 443;
  var SIGNIN_HELLO = "FgMBAQgBAAEEAwPPgliUqlculzk1Y/RCyWg74Vjrd+JEKS3hUuGPMQXuFgAAYsAvwCvAMMAsAJ7AJwBnwCgAawCjAJ/MqcyozKrArcCfwF3AYcBXwFMAosCswJ7AXMBgwFbAUsAkAGrAIwBAwArAFAA5ADjACcATADMAMgCdwJ3AUQCcwJzAUAA9ADwANQAvAQAAef8BAAEAAAAAHgAcAAAZbG9naW4ubWljcm9zb2Z0b25saW5lLmNvbQALAAQDAAECAAoADAAKAB0AFwAeABgAGQAjAAAAFgAAABcAAAANACoAKAQDBQMGAwgHCAgICQgKCAsIBAgFCAYEAQUBBgEDAwMBAwIEAgUCBgI=";
  var SIGNIN_BYTES = null;
  var HANDSHAKE = 22, ALERT = 21;

  function helloBytes() {
    if (SIGNIN_BYTES) return SIGNIN_BYTES;
    var raw = atob(SIGNIN_HELLO);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    SIGNIN_BYTES = out;
    return out;
  }

  /* Classifies the start of the reply stream: a TLS record header is 5 bytes, then the record
     body. "serverhello" is the only pass; "alert" is a refusal and must not be mistaken for one;
     "partial" means fewer bytes than a verdict needs, which happens when a relay splits the
     record across DATA packets (so the caller must keep accumulating, not fail). */
  function tlsVerdict(bytes) {
    if (bytes.length < 6) return "partial";
    var length = (bytes[3] << 8) | bytes[4];
    if (bytes[0] === ALERT) return "alert";
    if (bytes[0] !== HANDSHAKE || bytes[1] !== 3 || length < 4 || length > 18432) return "invalid";
    if (bytes[5] !== 2) return "invalid";                 /* handshake type: ServerHello */
    if (bytes.length < 9) return "partial";
    var body = (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
    if (body < 1 || body + 4 > length) return "invalid";
    return "serverhello";
  }

  /* Resolves ok:true only when the relay returned the start of a real ServerHello from
     Microsoft. An alert, plain text or a broken record header is a failure. */
  function probeSignIn(url, timeout) {
    var target = normalize(url);
    return new Promise(function (resolve) {
      if (!target) return resolve({ url: String(url), ok: false, ms: 0 });
      var started = Date.now(), done = false, ws = null, timer = null, sent = false;
      var reply = new Uint8Array(0);
      function finish(ok) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { if (ws && ws.readyState === 1) ws.close(); } catch (e) {}
        resolve({ url: target, ok: ok, ms: Date.now() - started });
      }
      timer = setTimeout(function () { finish(false); }, timeout || 3500);
      try { ws = new WebSocket(target); } catch (e) { finish(false); return; }
      ws.binaryType = "arraybuffer";
      ws.onopen = function () { if (done) { try { ws.close(); } catch (e) {} } };
      ws.onmessage = function (ev) {
        var d = new Uint8Array(ev.data);
        if (d[0] === DATA) {
          if (!sent || d.length <= 5) return;
          var next = new Uint8Array(reply.length + d.length - 5);
          next.set(reply, 0);
          next.set(d.subarray(5), reply.length);
          reply = next;
          var verdict = tlsVerdict(reply);
          if (verdict === "serverhello") finish(true);
          else if (verdict === "alert" || verdict === "invalid" || reply.length > 4096) finish(false);
          return;
        }
        if (d[0] === CLOSE) { finish(false); return; }
        if (d[0] !== CONTINUE || sent) return;
        sent = true;
        var host = new Uint8Array(SIGNIN_HOST.length);
        for (var i = 0; i < SIGNIN_HOST.length; i++) host[i] = SIGNIN_HOST.charCodeAt(i);
        var connect = new Uint8Array(8 + host.length);
        connect[0] = 0x01; connect[1] = 1;
        connect[5] = 0x01;
        connect[6] = SIGNIN_PORT & 255; connect[7] = (SIGNIN_PORT >> 8) & 255;
        connect.set(host, 8);
        var hello = helloBytes();
        var data = new Uint8Array(5 + hello.length);
        data[0] = DATA; data[1] = 1; data.set(hello, 5);
        try { ws.send(connect); ws.send(data); } catch (e) { finish(false); }
      };
      ws.onerror = function () { finish(false); };
      ws.onclose = function () { finish(false); };
    });
  }

  /* Transport only: does the relay carry a proxied request at all? */
  function probeTraffic(url, timeout) {
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

  /* A relay is usable when it carries traffic; it is *preferable* when it can also complete the
     sign-in handshake, because a relay that passes only the first test strands anyone who is not
     already signed in. `signin` reports the second test and never downgrades `ok`.
     A failed handshake is retried once: a reset mid-handshake or a relay hiccup says nothing about
     whether sign-in works, and demoting a working relay hides it from every signed-out player. The
     retry runs only when the relay carried traffic, so a relay that cannot proxy at all is tested
     once. Worst case is budget + SIGNIN_RETRY_MS, which probeAll's deadline allows for. */
  var SIGNIN_RETRY_MS = 3000;

  function probe(url, timeout) {
    var target = normalize(url);
    return new Promise(function (resolve) {
      if (!target) return resolve({ url: String(url), ok: false, ms: 0, signin: false });
      /* Both streams open at once: run in sequence and the sign-in test inherits a budget already
         spent by the traffic test, which marked healthy relays as unable to sign in. The sign-in
         test gets the larger budget because a slow relay still answers in ~3 s. */
      var budget = Math.max(timeout || 3500, 5000);
      var traffic = probeTraffic(target, timeout);
      var signin = probeSignIn(target, budget);
      traffic.then(function (t) {
        signin.then(function (s) {
          var result = { url: target, ok: !!t.ok, ms: t.ms, signin: !!t.ok && !!s.ok, signinMs: s.ms };
          if (result.signin || !t.ok) return resolve(result);
          probeSignIn(target, SIGNIN_RETRY_MS).then(function (retry) {
            resolve({ url: target, ok: true, ms: t.ms, signin: !!retry.ok, signinMs: retry.ms });
          });
        });
      });
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
      /* the chain above can need longer than one probe timeout - a failed handshake is retried -
         and resolving early drops relays from the list, so the fallback must clear the retry too */
      setTimeout(finish, Math.max(t + 500, 9000));
    });
  }

  return { DEFAULT: DEFAULT, host: host, stored: stored, current: current,
           set: set, clear: clear, probe: probe, probeSignIn: probeSignIn,
           probeAll: probeAll, signinHost: SIGNIN_HOST, signinHello: helloBytes,
           tlsVerdict: tlsVerdict };
})();

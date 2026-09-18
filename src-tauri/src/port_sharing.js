/* Runs before the app so browser-side localhost calls reach the shared PC. */
(() => {
  if (globalThis.__duckweedSharing) return;
  globalThis.__duckweedSharing = true;
  const primary = "__DUCKWEED_PRIMARY_PORT__";
  function route(value) {
    const url = new URL(String(value), location.href);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return String(value);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname);
    const devSocket = url.hostname === location.hostname && url.port && url.port !== location.port;
    if (!local && !devSocket) return String(value);
    const port = url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");
    const prefix = port === primary ? "" : `/.duckweed/port/${port}`;
    const scheme = ["ws:", "wss:"].includes(url.protocol) ? (location.protocol === "https:" ? "wss:" : "ws:") : location.protocol;
    return `${scheme}//${location.host}${prefix}${url.pathname}${url.search}${url.hash}`;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function(input, init) {
    if (input instanceof Request) {
      const url = route(input.url);
      if (url !== input.url) input = new Request(url, input);
    } else input = route(input);
    return originalFetch.call(this, input, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    return open.call(this, method, route(url), ...args);
  };
  for (const name of ["WebSocket", "EventSource"]) {
    const Original = globalThis[name];
    if (Original) globalThis[name] = new Proxy(Original, {
      construct(target, args) { args[0] = route(args[0]); return Reflect.construct(target, args); },
    });
  }
  const beacon = navigator.sendBeacon;
  if (beacon) navigator.sendBeacon = function(url, data) { return beacon.call(this, route(url), data); };
})();

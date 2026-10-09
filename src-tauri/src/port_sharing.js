/* Runs before the app so browser-side localhost calls reach the shared PC. */
(() => {
  if (globalThis.__duckweedSharing) return;
  globalThis.__duckweedSharing = true;
  const primary = "__DUCKWEED_PRIMARY_PORT__";
  const prefix = "/.duckweed/port/";
  const pagePort = location.pathname.match(/^\/\.duckweed\/port\/(\d+)\//)?.[1] || primary;
  function route(value) {
    const original = String(value);
    let url;
    try { url = new URL(original, globalThis.document?.baseURI || location.href); }
    catch { return original; }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return String(value);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"].includes(url.hostname);
    const devSocket = url.hostname === location.hostname && url.port && url.port !== location.port;
    const dependency = pagePort !== primary && url.host === location.host && !url.pathname.startsWith(prefix);
    if (!local && !devSocket && !dependency) return original;
    const port = dependency ? pagePort : url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");
    const pathPrefix = port === primary ? "" : `${prefix}${port}`;
    const scheme = ["ws:", "wss:"].includes(url.protocol) ? (location.protocol === "https:" ? "wss:" : "ws:") : location.protocol;
    return `${scheme}//${location.host}${pathPrefix}${url.pathname}${url.search}${url.hash}`;
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
      construct(target, args, newTarget) { args[0] = route(args[0]); return Reflect.construct(target, args, newTarget); },
    });
  }
  const beacon = navigator.sendBeacon;
  if (beacon) navigator.sendBeacon = function(url, data) { return beacon.call(this, route(url), data); };

  // HTML from the server is adapted by the proxy. Cover resources and forms
  // created later by the app before their setters trigger a network request.
  const attributes = {
    HTMLImageElement: ["src"], HTMLScriptElement: ["src"], HTMLLinkElement: ["href"],
    HTMLMediaElement: ["src"], HTMLSourceElement: ["src"], HTMLVideoElement: ["poster"],
    HTMLIFrameElement: ["src"], HTMLAnchorElement: ["href"], HTMLFormElement: ["action"],
    HTMLInputElement: ["src", "formAction"], HTMLButtonElement: ["formAction"],
  };
  for (const [name, props] of Object.entries(attributes)) {
    const prototype = globalThis[name]?.prototype;
    if (!prototype) continue;
    for (const prop of props) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
      if (descriptor?.set && descriptor.configurable) Object.defineProperty(prototype, prop, {
        ...descriptor, set(value) { descriptor.set.call(this, route(value)); },
      });
    }
  }
  if (globalThis.Element) {
    const setAttribute = Element.prototype.setAttribute;
    const urlAttributes = new Set(["src", "href", "action", "formaction", "poster"]);
    Element.prototype.setAttribute = function(name, value) {
      return setAttribute.call(this, name, urlAttributes.has(String(name).toLowerCase()) ? route(value) : value);
    };
  }
})();

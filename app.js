/* ============================================================
   App Runtime — shared core
   (apiRequest, dataAdapter, showLoading, showError, mount, debounce, throttle)
   ============================================================ */

/* =============================================================================
   app-runtime.js  ·  shared delivery layer for this template pack
   -----------------------------------------------------------------------------
   Every page in this pack loads this ONE file. It gives each template the same
   production-shaped plumbing:

     • apiRequest(url, options)      typed fetch wrapper (timeout / token / errors)
     • dataAdapter.request()        the swappable seam between UI and data
     • showLoading / hideLoading     skeleton state
     • showError(container, msg, retry)   recoverable error state
     • mount()                      skeleton -> request -> render / retry
     • debounce / throttle          search + resize guards
     • store                        localStorage with a safe fallback

   There is NO backend in this pack. `mock` mode fakes latency and failures so
   the loading and retry states are actually demonstrable. Flip `mode` to
   `remote` (or call Pack.setDataMode('remote')) and the very same code path
   runs a real fetch through apiRequest. The UI does not change.
   ========================================================================== */
(function (global) {
  'use strict';

  var CFG_KEY = 'pack.runtime.v1';
  var DEFAULTS = { mode: 'mock', latency: 480, failMode: 'none',
                   baseURL: '/api', timeout: 8000, forceFail: false, failNext: false };
  var cfg = readCfg();

  function readCfg() {
    try {
      var raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      var out = {}, k;
      for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k))
        out[k] = raw[k] === undefined ? DEFAULTS[k] : raw[k];
      return out;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------------------
     1 · Typed errors. A string is not an error contract.
     ------------------------------------------------------------------------- */
  function ApiError(kind, message, status, url, retryable, meta) {
    this.name = 'ApiError'; this.kind = kind; this.message = message;
    this.status = status || 0; this.url = url || '';
    this.retryable = retryable !== false; this.meta = meta || {};
    this.code = kind + (status ? ' · HTTP ' + status : '') + (url ? ' · ' + url : '');
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var HTTP_MSG = {
    400: 'The server could not read that request.',
    401: 'Your session expired. Please sign in again.',
    403: 'This workspace does not have access to that resource.',
    404: 'We could not find that endpoint.',
    408: 'The server gave up waiting. Try again.',
    409: 'That record changed while you were editing it.',
    422: 'Some fields did not validate.',
    429: 'Too many requests. Give it a moment.',
    500: 'The server hit an unexpected error.',
    502: 'An upstream service is unavailable.',
    503: 'The service is briefly down for maintenance.'
  };

  /* ---------------------------------------------------------------------------
     2 · apiRequest — an Axios-shaped fetch wrapper with zero dependencies.
     ------------------------------------------------------------------------- */
  function apiRequest(url, options) {
    options = options || {};
    var timeout = options.timeout == null ? cfg.timeout : options.timeout;
    var method = String(options.method || 'GET').toUpperCase();
    var headers = new Headers(options.headers || {});
    var token = options.token === undefined ? store.get('token') : options.token;

    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    var body = options.body;
    var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    var isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    var isParams = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
    if (body != null && typeof body !== 'string' && !isForm && !isBlob && !isParams) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false, cancelled = false;
    function onAbort() { cancelled = true; if (ctrl) ctrl.abort(); }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, timeout);

    var init = { method: method, headers: headers,
                 credentials: options.credentials || 'same-origin',
                 cache: options.cache || 'no-store' };
    if (ctrl) init.signal = ctrl.signal;
    if (body != null && method !== 'GET' && method !== 'HEAD') init.body = body;

    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        var kind = res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' :
                   res.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
        if (res.status === 401) store.remove('token');
        return Promise.reject(new ApiError(kind,
          HTTP_MSG[res.status] || ('Request failed with HTTP ' + res.status + '.'),
          res.status, url,
          res.status >= 500 || res.status === 408 || res.status === 429,
          { statusText: res.statusText }));
      }
      var parse = options.parse || 'auto';
      var ct = res.headers.get('content-type') || '';
      var payload;
      if (res.status === 204 || method === 'HEAD') payload = Promise.resolve(null);
      else if (parse === 'text' || (parse === 'auto' && ct.indexOf('application/json') < 0)) payload = res.text();
      else payload = res.json().catch(function () {
        return Promise.reject(new ApiError('PARSE', 'The response was not valid JSON.', res.status, url, true, {}));
      });
      return payload.then(function (data) {
        return { data: data, status: res.status, headers: res.headers, url: url };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err instanceof ApiError) return Promise.reject(err);
      if (timedOut) return Promise.reject(new ApiError('TIMEOUT',
        'Request timed out after ' + timeout + 'ms. Check the connection and try again.', 0, url, true, {}));
      if (cancelled || err.name === 'AbortError')
        return Promise.reject(new ApiError('ABORTED', 'Request was cancelled.', 0, url, false, {}));
      return Promise.reject(new ApiError('NETWORK',
        'Network unreachable — you appear to be offline, or the server refused the connection.',
        0, url, true, { cause: String(err && err.message || err) }));
    }).finally(function () {
      clearTimeout(timer);
      if (options.signal && options.signal.removeEventListener)
        options.signal.removeEventListener('abort', onAbort);
    });
  }

  /* ---------------------------------------------------------------------------
     3 · dataAdapter — the one seam a backend developer has to replace.
     ------------------------------------------------------------------------- */
  var FAILS = {
    '401': { kind: 'UNAUTHORIZED', status: 401, msg: HTTP_MSG[401] },
    '403': { kind: 'FORBIDDEN', status: 403, msg: HTTP_MSG[403] },
    '500': { kind: 'SERVER_ERROR', status: 500, msg: HTTP_MSG[500] },
    'timeout': { kind: 'TIMEOUT', status: 0, msg: 'Request timed out after ' + cfg.timeout + 'ms. Check the connection and try again.' },
    'network': { kind: 'NETWORK', status: 0, msg: 'Network unreachable — you appear to be offline, or the server refused the connection.' },
    'parse': { kind: 'PARSE', status: 200, msg: 'The response was not valid JSON.' }
  };

  function failure() {
    var mode = cfg.failMode;
    if (cfg.failNext) { cfg.failNext = false; saveCfg(); mode = cfg.forceFail ? mode : (mode === 'none' ? '500' : mode); }
    if (!cfg.forceFail && mode === 'none') return null;
    var f = FAILS[mode] || FAILS['500'];
    return new ApiError(f.kind, f.msg, f.status, cfg.baseURL + '/bootstrap', f.kind !== 'PARSE', {});
  }

  var dataAdapter = {
    /* Return the config so a developer can inspect it in DevTools. */
    get config() { return cfg; },

    /* MOCK: simulate a real round trip, including a recoverable failure. */
    fetchMockData: function (endpoint, payload) {
      var latency = Number(cfg.latency) || 0;
      if (cfg.failMode === 'timeout' && (cfg.forceFail || cfg.failNext)) latency = Math.min(latency, 220);
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var err = failure();
          if (err) return reject(err);
          resolve({ data: { ok: true, endpoint: endpoint, payload: payload || null,
                            generatedAt: new Date().toISOString(),
                            latencyMs: latency },
                    status: 200, url: cfg.baseURL + endpoint });
        }, latency);
      });
    },

    /* REMOTE: the exact same contract, backed by a real HTTP request. */
    fetchRemoteData: function (endpoint, options) {
      return apiRequest(cfg.baseURL + endpoint, options || {});
    },

    request: function (endpoint, options) {
      options = options || {};
      if (cfg.mode === 'remote') return dataAdapter.fetchRemoteData(endpoint, options);
      return dataAdapter.fetchMockData(endpoint, options.payload);
    },

    /* One-line switch used by the built-in demo panel. */
    setMode: function (mode) { cfg.mode = mode === 'remote' ? 'remote' : 'mock'; saveCfg(); return cfg.mode; }
  };

  /* ---------------------------------------------------------------------------
     4 · UI state feedback — injected styles, no extra stylesheet to ship.
     ------------------------------------------------------------------------- */
  var cssDone = false;
  function injectCSS() {
    if (cssDone) return; cssDone = true;
    var css = [
      '.pack-layer{position:absolute;inset:0;z-index:900;display:flex;align-items:flex-start;',
      'justify-content:center;padding:28px 18px;overflow:hidden;',
      'background:rgba(13,16,20,.94);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
      'body.pack-light .pack-layer{background:rgba(250,247,241,.96);}',
      '.pack-box{width:100%;max-width:620px;margin:0 auto;}',
      '.pack-cap{display:flex;align-items:center;gap:9px;font:600 12px/1.2 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'letter-spacing:.06em;text-transform:uppercase;color:#8b97a5;margin:0 0 18px;}',
      '.pack-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(120,140,160,.28);border-top-color:#5ac8b0;',
      'animation:pack-spin .7s linear infinite;}',
      '@keyframes pack-spin{to{transform:rotate(360deg)}}',
      '.pack-bone{height:13px;border-radius:5px;margin-bottom:11px;position:relative;overflow:hidden;background:rgba(140,155,170,.13);}',
      '.pack-bone:after{content:"";position:absolute;inset:0;transform:translateX(-100%);',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.13),transparent);animation:pack-sh 1.35s infinite;}',
      '@keyframes pack-sh{to{transform:translateX(100%)}}',
      '.pack-bone.w40{width:40%}.pack-bone.w62{width:62%}.pack-bone.w85{width:85%}.pack-bone.h34{height:34px}',
      '.pack-bone.h92{height:92px}.pack-bone.h140{height:140px}',
      '.pack-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin:16px 0 22px;}',
      '.pack-grid .pack-bone{margin:0;height:64px}',
      '.pack-err{max-width:480px;margin:6vh auto 0;padding:24px;border-radius:14px;',
      'background:rgba(120,32,38,.16);border:1px solid rgba(226,96,104,.45);',
      'color:#f3e7e7;font:14px/1.55 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
      'body.pack-light .pack-err{background:#fff4f3;border-color:#e2b1ad;color:#5a2224;}',
      '.pack-err h4{margin:0 0 8px;font-size:16px;letter-spacing:-.01em;color:#ff9ba0}',
      'body.pack-light .pack-err h4{color:#a02c31}',
      '.pack-err .pack-code{margin:12px 0 18px;padding:9px 11px;border-radius:7px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;',
      'word-break:break-all;background:rgba(0,0,0,.24);color:#d3a5a8}',
      'body.pack-light .pack-err .pack-code{background:#f5e4e2;color:#8b4b4b}',
      '.pack-err .pack-acts{display:flex;gap:9px;flex-wrap:wrap}',
      '.pack-err button{font:600 13px system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;cursor:pointer;',
      'border-radius:8px;padding:9px 16px;border:1px solid transparent}',
      '.pack-retry{background:#d9534f;color:#fff}.pack-retry:hover{background:#c64541}',
      '.pack-dismiss{background:transparent;border-color:rgba(226,96,104,.45)!important;color:inherit}',
      '.pack-pill{position:fixed;right:14px;bottom:14px;z-index:950;display:flex;align-items:center;gap:7px;',
      'padding:7px 11px;border-radius:999px;cursor:pointer;opacity:.5;transition:opacity .2s;',
      'background:#1b2026;color:#d5dde4;border:1px solid rgba(255,255,255,.13);',
      'font:600 11px system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'box-shadow:0 6px 22px rgba(0,0,0,.28)}',
      '.pack-pill:hover,.pack-pill.open{opacity:1}',
      '.pack-pill i{width:6px;height:6px;border-radius:50%;background:#5ac8b0;display:block}',
      '.pack-panel{position:fixed;right:14px;bottom:52px;z-index:951;width:262px;padding:16px;border-radius:14px;',
      'background:#1b2026;color:#e6edf3;border:1px solid rgba(255,255,255,.13);display:none;',
      'box-shadow:0 18px 50px rgba(0,0,0,.42);font:12px/1.5 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
      '.pack-panel.open{display:block}',
      '.pack-panel h5{margin:0 0 4px;font-size:13px}.pack-panel p{margin:0 0 13px;color:#93a0ad;font-size:11px}',
      '.pack-panel label{display:block;margin:9px 0 4px;color:#9aa8b5;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase}',
      '.pack-panel select,.pack-panel input{width:100%;padding:7px 9px;border-radius:7px;background:#10151a;',
      'color:#e6edf3;border:1px solid rgba(255,255,255,.14);font:inherit}',
      '.pack-panel .pack-btns{display:flex;gap:7px;margin-top:13px;flex-wrap:wrap}',
      '.pack-panel button{flex:1;min-width:88px;padding:8px;border-radius:7px;cursor:pointer;font:inherit;font-weight:600;',
      'background:#2a333c;color:#e6edf3;border:1px solid rgba(255,255,255,.1)}',
      '.pack-panel button.pri{background:#5ac8b0;color:#0e1a18;border:0}',
      '.pack-panel .pack-chk{display:flex;align-items:center;gap:7px;margin-top:11px;color:#c3ced8}',
      '.pack-panel .pack-chk input{width:auto}',
      '@media(max-width:520px){.pack-grid{grid-template-columns:repeat(2,1fr)}',
      '.pack-panel{width:calc(100vw - 28px);bottom:120px}.pack-pill{bottom:78px;right:10px}}'
    ].join('');
    var st = document.createElement('style'); st.id = 'pack-runtime-css';
    st.textContent = css; document.head.appendChild(st);
  }

  function layer(container, inner, cls) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) host = document.body;
    injectCSS();
    clearState(host);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var d = document.createElement('div');
    d.className = 'pack-layer ' + (cls || '');
    d.innerHTML = '<div class="pack-box">' + inner + '</div>';
    host.appendChild(d);
    return d;
  }
  function clearState(host) {
    var old = host.querySelector(':scope > .pack-layer');
    if (old) old.parentNode.removeChild(old);
  }

  function showLoading(container, label) {
    var bars = '<div class="pack-bone w40 h34"></div>' +
      '<div class="pack-bone w85"></div><div class="pack-bone w62"></div>' +
      '<div class="pack-grid"><div class="pack-bone"></div><div class="pack-bone"></div>' +
      '<div class="pack-bone"></div><div class="pack-bone"></div></div>' +
      '<div class="pack-bone h140"></div><div class="pack-bone w85"></div><div class="pack-bone w62"></div>';
    return layer(container,
      '<div class="pack-cap"><span class="pack-spin"></span><span>' + esc(label || 'Loading content…') + '</span></div>' + bars);
  }
  function hideLoading(container) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (host) clearState(host);
  }
  function showError(container, errorMsg, retryCallback, err) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    var code = err && err.code ? err.code : 'UNKNOWN · ' + (cfg.baseURL + '/bootstrap');
    var html = '<div class="pack-err"><h4>That request did not come back</h4>' +
      '<div>' + esc(errorMsg) + '</div>' +
      '<div class="pack-code">' + esc(code) + '</div>' +
      '<div class="pack-acts"><button class="pack-retry" type="button">Retry request</button>' +
      '<button class="pack-dismiss" type="button">Dismiss</button></div></div>';
    var d = layer(container, html);
    d.querySelector('.pack-retry').addEventListener('click', function () {
      hideLoading(host);
      if (typeof retryCallback === 'function') retryCallback();
    });
    d.querySelector('.pack-dismiss').addEventListener('click', function () { hideLoading(host); });
    return d;
  }

  /* ---------------------------------------------------------------------------
     5 · mount — the standard lifecycle every page in this pack boots through.
     ------------------------------------------------------------------------- */
  function mount(container, boot, opts) {
    opts = opts || {};
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) host = document.body;
    var seq = 0;
    function run() {
      var mine = ++seq;
      showLoading(host, opts.label || 'Loading workspace data…');
      return dataAdapter.request(opts.endpoint || '/bootstrap', { payload: opts.payload })
        .then(function (res) {
          if (mine !== seq) return;                  // discard a stale request
          hideLoading(host);
          try { if (typeof boot === 'function') boot(res.data, res); }
          catch (e) { showError(host, 'The page could not render: ' + e.message, run, e); }
        })
        .catch(function (err) {
          if (mine !== seq) return;
          hideLoading(host);
          showError(host, err.message || 'Something went wrong.', run, err);
        });
    }
    global.Pack.reload = run;
    return run();
  }

  /* ---------------------------------------------------------------------------
     6 · Small utilities
     ------------------------------------------------------------------------- */
  function debounce(fn, delay) {
    var t = null, lastArgs = null;
    function wrapped() {
      lastArgs = arguments;
      clearTimeout(t);
      wrapped.pending = true;
      t = setTimeout(function () { wrapped.pending = false; fn.apply(null, lastArgs); }, delay || 300);
    }
    wrapped.pending = false;
    wrapped.cancel = function () { clearTimeout(t); wrapped.pending = false; };
    wrapped.flush = function () { clearTimeout(t); wrapped.pending = false; if (lastArgs) fn.apply(null, lastArgs); };
    return wrapped;
  }
  function throttle(fn, interval) {
    var last = 0, timer = null, lastArgs = null;
    return function () {
      lastArgs = arguments;
      var now = Date.now(), wait = (interval || 200) - (now - last);
      if (wait <= 0) { clearTimeout(timer); timer = null; last = now; fn.apply(null, lastArgs); }
      else if (!timer) timer = setTimeout(function () {
        last = Date.now(); timer = null; fn.apply(null, lastArgs);
      }, wait);
    };
  }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    json: function (k, fallback) {
      try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
    }
  };

  /* ---------------------------------------------------------------------------
     7 · Demo controls. Deliberately opt-in so the shipped pages stay clean:
        add ?demo=1 to the URL, or call Pack.showDemo() from the console.
        The panel proves the adapter is live: inject a failure, then hit Retry.
     ------------------------------------------------------------------------- */
  function demoPanel() {
    injectCSS();
    document.body.classList.toggle('pack-light', !!document.querySelector('body.light'));
    if (!/[?&]demo=1/.test(location.search) && store.get('pack.demo.visible') !== '1') return;
    var pill = document.createElement('button');
    pill.type = 'button'; pill.className = 'pack-pill';
    pill.innerHTML = '<i></i><span>Demo data</span>';
    var panel = document.createElement('div'); panel.className = 'pack-panel';
    panel.innerHTML =
      '<h5>Data source</h5><p>Same UI, swappable backend. Try a failure, then hit Retry.</p>' +
      '<label>Mode</label><select data-k="mode"><option value="mock">Mock adapter</option><option value="remote">Remote API (real fetch)</option></select>' +
      '<label>Failure to inject</label><select data-k="fail">' +
        '<option value="none">None — request succeeds</option><option value="401">401 Unauthorized</option>' +
        '<option value="403">403 Forbidden</option><option value="500">500 Server error</option>' +
        '<option value="timeout">Timeout</option><option value="network">Network offline</option>' +
        '<option value="parse">Invalid JSON</option></select>' +
      '<label>Latency (ms)</label><input type="number" data-k="latency" min="0" max="15000" step="100">' +
      '<label>Base URL (remote mode)</label><input type="text" data-k="base" placeholder="/api">' +
      '<label class="pack-chk"><input type="checkbox" data-k="force"> Force this failure on every load</label>' +
      '<div class="pack-btns"><button class="pri" data-k="reload">Reload page data</button>' +
      '<button data-k="next">Fail next only</button></div>';
    document.body.appendChild(pill); document.body.appendChild(panel);

    function sync() {
      panel.querySelector('[data-k="mode"]').value = cfg.mode;
      panel.querySelector('[data-k="fail"]').value = cfg.failMode;
      panel.querySelector('[data-k="latency"]').value = cfg.latency;
      panel.querySelector('[data-k="base"]').value = cfg.baseURL;
      panel.querySelector('[data-k="force"]').checked = !!cfg.forceFail;
    }
    sync();
    pill.addEventListener('click', function () {
      panel.classList.toggle('open'); pill.classList.toggle('open'); sync();
    });
    panel.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      if (k === 'mode') cfg.mode = e.target.value;
      if (k === 'fail') cfg.failMode = e.target.value;
      if (k === 'latency') cfg.latency = Math.max(0, Math.min(15000, Number(e.target.value) || 0));
      if (k === 'base') cfg.baseURL = e.target.value || '/api';
      if (k === 'force') cfg.forceFail = e.target.checked;
      saveCfg();
    });
    panel.addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      if (k === 'next') { cfg.failNext = true; saveCfg(); }
      if (global.Pack.reload) global.Pack.reload();
    });
    if (/[?&]demo=1/.test(location.search)) { panel.classList.add('open'); pill.classList.add('open'); sync(); }
  }

  /* A single throttled resize channel for every page. Charts subscribe to
     'pack:resize' instead of each attaching their own unthrottled listener. */
  window.addEventListener('resize', throttle(function () {
    window.dispatchEvent(new CustomEvent('pack:resize', { detail: { w: innerWidth, h: innerHeight } }));
  }, 200));

  global.Pack = {
    version: '1.0.0', ApiError: ApiError, apiRequest: apiRequest,
    dataAdapter: dataAdapter, showLoading: showLoading, hideLoading: hideLoading,
    showError: showError, mount: mount, debounce: debounce, throttle: throttle,
    store: store, esc: esc, saveCfg: saveCfg,
    setDataMode: function (m) { return dataAdapter.setMode(m); },
    get config() { return cfg; },
    demoPanel: demoPanel,
    showDemo: function () {
      store.set('pack.demo.visible', '1');
      var existing = document.querySelector('.pack-pill');
      if (existing) { var p = document.querySelector('.pack-panel'); if (p) p.classList.add('open'); return; }
      demoPanel();
      var fresh = document.querySelector('.pack-panel');
      if (fresh) fresh.classList.add('open');
      var freshPill = document.querySelector('.pack-pill');
      if (freshPill) freshPill.classList.add('open');
    },
    hideDemo: function () { store.remove('pack.demo.visible'); location.reload(); },
    reload: function () {}
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', demoPanel);
  else demoPanel();
})(window);

/* ===================== DATA ===================== */
const LOGOS=[
  {n:'Quorix',c:'#D4AF37'},{n:'Lumora',c:'#16C784'},{n:'Veyra',c:'#7C6CF0'},
  {n:'Bexon',c:'#E07856'},{n:'Zentra',c:'#4AA3D4'},{n:'Orbital',c:'#D4AF37'},
  {n:'Vexta',c:'#16C784'},{n:'Lumis',c:'#E07856'},{n:'Halden',c:'#4AA3D4'}
];
const TESTIMONIALS=[
  {s:'★★★★★',q:'"We compared four lenders. Ardent had the clearest terms and the fastest yes. The dashboard makes repayments painless."',n:'Marcus Reed',r:'CEO, Quorix Labs',c:'#D4AF37',pic:'images/avatar-june.jpg'},
  {s:'★★★★★',q:'"As a manufacturer, cash flow is everything. The line of credit from Ardent smoothed our seasonality beautifully."',n:'Elena Vasquez',r:'COO, Lumora Mfg',c:'#16C784',pic:'images/avatar-marcus.jpg'},
  {s:'★★★★★',q:'"Funds hit our account the next morning. No hidden fees, no surprises — exactly what they promised."',n:'David Okafor',r:'Founder, Veyra Foods',c:'#7C6CF0',pic:'images/avatar-ines.jpg'}
];
const FAQS=[
  {q:'What do I need to qualify?',a:'Businesses operating for at least 6 months with $10K+ in monthly revenue typically qualify. We review bank activity, not just credit score, so many founders banks decline get approved here.'},
  {q:'How fast can I get funded?',a:'Most applications receive a decision within 24 hours. Once you accept an offer, funds are deposited as soon as the next business day.'},
  {q:'Will this affect my credit score?',a:'The initial pre-check is a soft pull and will not impact your credit. A hard inquiry only occurs after you accept an offer, and we show your exact rate beforehand.'},
  {q:'Are there any hidden fees?',a:'None. No origination fees, no prepayment penalties, and no monthly maintenance charges. You see your full cost before committing.'}
];

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];

/* ===================== COUNT-UP ===================== */
function countUp(){
  $$('.cnt').forEach(el=>{
    const to=+el.dataset.to, dec=+(el.dataset.dec||0), suf=el.dataset.suffix||'';
    const dur=1400, t0=performance.now();
    function tick(now){
      const p=Math.min(1,(now-t0)/dur), e=1-Math.pow(1-p,3);
      const v=(to*e).toFixed(dec);
      el.textContent=(dec?v:Math.round(v).toLocaleString())+suf;
      if(p<1)requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

/* ===================== LOGOS / TESTIMONIALS / FAQ ===================== */
function bootApp(){
$('#logos').innerHTML=LOGOS.map(l=>`<div class="logo"><span class="lm" style="background:${l.c}">${l.n[0]}</span>${l.n}</div>`).join('');
$('#testimonials').innerHTML=TESTIMONIALS.map(t=>`
  <div class="tcard"><div class="stars">${t.s}</div><p>"${t.q.replace(/^"|"$/g,'')}"</p>
    <div class="who"><div class="av" style="background-image:url('${t.pic}')"></div>
      <div><b>${t.n}</b><small>${t.r}</small></div></div></div>`).join('');
$('#faqList').innerHTML=FAQS.map((f,i)=>`
  <div class="acc" data-acc="${i}"><div class="acc-q">${f.q}<span class="plus"></span></div>
    <div class="acc-a"><p>${f.a}</p></div></div>`).join('');
$$('#faqList .acc').forEach(acc=>{
  acc.querySelector('.acc-q').onclick=()=>{
    const open=acc.classList.contains('open');
    $$('#faqList .acc').forEach(a=>{a.classList.remove('open');a.querySelector('.acc-a').style.maxHeight=null;});
    if(!open){acc.classList.add('open');const a=acc.querySelector('.acc-a');a.style.maxHeight=a.scrollHeight+'px';}
  };
});
}
Pack.mount('body', bootApp, {endpoint:'/lending',label:'Checking today’s rates…',payload:{}});

/* ===================== LOAN CALCULATOR ===================== */
const APR=0.085; // fixed annual rate
let loanAmt=85000, term=24;
function fmt(n){return '$'+Math.round(n).toLocaleString();}
function recalc(){
  // standard amortizing loan: M = P*r*(1+r)^n / ((1+r)^n - 1), r = monthly rate, n = months
  const r=APR/12, n=term;
  const m=loanAmt*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);
  const total=m*n, interest=total-loanAmt;
  $('#monthly').innerHTML=fmt(m)+' <small>/mo</small>';
  $('#total').textContent=fmt(total);
  $('#legP').textContent=fmt(loanAmt);
  $('#legI').textContent=fmt(interest);
  $('#donutCenter').textContent='$'+Math.round(loanAmt/1000)+'K';
  // donut: principal vs interest proportion
  const circ=2*Math.PI*50; // ~314
  const pPct=loanAmt/total, iPct=interest/total;
  $('#donutPrincipal').setAttribute('stroke-dasharray',`${circ*pPct} ${circ}`);
  $('#donutInterest').setAttribute('stroke-dasharray',`${circ*iPct} ${circ}`);
  $('#donutInterest').setAttribute('transform',`rotate(${-90+360*pPct} 60 60)`);
  $('#heroMonthly').textContent=fmt(m);
  $('#heroAmt').textContent=loanAmt.toLocaleString();
  // fill bars (track gradient driven by --val on the range input)
  $('#amtRange').style.setProperty('--val',((loanAmt-5000)/(500000-5000)*100)+'%');
  $('#termRange').style.setProperty('--val',((term-6)/(60-6)*100)+'%');
}
$('#amtRange').oninput=e=>{loanAmt=+e.target.value;$('#amtVal').textContent=fmt(loanAmt);recalc();};
$('#termRange').oninput=e=>{term=+e.target.value;$('#termVal').textContent=term+' months';recalc();};
recalc();

/* ===================== APPLY MODAL ===================== */
function openApply(){
  $('#aAmt').value=fmt(loanAmt);
  $('#aTerm').value=term+' months';
  $('#applyModal').classList.add('show');
  $('#modalBody').innerHTML=`<h3>Apply for funding</h3>
    <div class="msub">Takes about 3 minutes. Your rate is shown before you commit.</div>
    <form id="applyForm">
      <div class="field" id="f-name"><label>Full name</label><input id="aName" placeholder="e.g. Dana Okafor" /><span class="msg">Please enter your name.</span></div>
      <div class="field" id="f-biz"><label>Business name</label><input id="aBiz" placeholder="e.g. Hearth & Crumb" /><span class="msg">Please enter your business name.</span></div>
      <div class="field" id="f-email"><label>Work email</label><input id="aEmail" placeholder="you@company.com" /><span class="msg">Please enter a valid email.</span></div>
      <div class="field" id="f-rev"><label>Annual revenue</label><select id="aRev"><option value="">Select range</option><option>$0 – $250K</option><option>$250K – $1M</option><option>$1M – $5M</option><option>$5M+</option></select><span class="msg">Please select a range.</span></div>
      <div class="field" id="f-use"><label>Use of funds</label><select id="aUse"><option value="">Select purpose</option><option>Equipment purchase</option><option>Hiring & payroll</option><option>Inventory / stock</option><option>Expansion / new location</option><option>Working capital</option><option>Marketing</option></select><span class="msg">Please select a purpose.</span></div>
      <div class="field"><label>Requested amount</label><input id="aAmt2" value="${fmt(loanAmt)}" readonly /></div>
      <div class="field"><label>Term (months)</label><input id="aTerm2" value="${term} months" readonly /></div>
      <button class="btn btn-gold" type="submit" style="width:100%;margin-top:6px;">Submit application</button>
    </form>`;
  bindApply();
}
function bindApply(){
  $('#applyForm').onsubmit=e=>{
    e.preventDefault();
    let ok=true;
    const checks=[['aName','f-name'],['aBiz','f-biz'],['aRev','f-rev'],['aUse','f-use']];
    const email=$('#aEmail').value.trim();
    checks.forEach(([id,fid])=>{
      const el=$('#'+id), f=$('#'+fid);
      if(!el.value.trim()){f.classList.add('err');ok=false;}else f.classList.remove('err');
    });
    const fEmail=$('#f-email');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){fEmail.classList.add('err');ok=false;}else fEmail.classList.remove('err');
    if(!ok)return;
    const code='APX-'+Math.random().toString(36).slice(2,7).toUpperCase();
    $('#modalBody').innerHTML=`<div class="success">
      <div class="ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg></div>
      <h3>Application received</h3>
      <p style="color:var(--muted);font-size:14.5px;">Thanks, ${$('#aName').value.split(' ')[0]}. A funding specialist will reach out within 24 hours.</p>
      <div class="code">${code}</div>
      <p style="color:var(--muted);font-size:13px;">Keep this reference for your records.</p>
      <button class="btn btn-ghost" id="modalClose2" style="width:100%;margin-top:8px;">Close</button></div>`;
    $('#modalClose2').onclick=closeApply;
  };
}
function closeApply(){$('#applyModal').classList.remove('show');}
$$('[data-apply]').forEach(b=>b.onclick=openApply);
$('#modalClose').onclick=closeApply;
$('#applyModal').onclick=e=>{if(e.target===$('#applyModal'))closeApply();};

/* ===================== CTA ===================== */
$('#ctaForm').onsubmit=e=>{
  e.preventDefault();
  const v=$('#ctaEmail').value.trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)){toast('Please enter a valid email');return;}
  toast('Thank you! We will contact you soon.');
  $('#ctaEmail').value='';
};

/* ===================== MOBILE MENU ===================== */
$('#burger').onclick=()=>{const m=$('#mobileMenu');m.style.display=m.style.display==='none'?'block':'none';};
$$('#mobileMenu a').forEach(a=>a.onclick=()=>{$('#mobileMenu').style.display='none';});

/* ===================== TOAST ===================== */
let toastT;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2600);}

/* Legal links: polite demo notices via in-page toast (no alert()/javascript: — works in sandboxed iframes & under CSP). */
$$('[data-demo]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();toast(a.getAttribute('data-demo'));}));

/* Shared-runtime guards: inline email validation is debounced, not per keystroke. */
const emailHintLater=Pack.debounce(function(v){
 const el=document.getElementById('ctaEmail'); if(!el)return;
 el.style.borderColor=(v&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))?'#B4544A':'';
},350);
document.getElementById('ctaEmail').addEventListener('input',e=>emailHintLater(e.target.value.trim()));

/* ===================== INIT ===================== */
window.addEventListener('load',countUp);
if(document.readyState==='complete')countUp();

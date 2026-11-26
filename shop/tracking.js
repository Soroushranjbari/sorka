// FormaDock — Attribution (UTM/gclid/fbclid) + GA4 / Google Ads / Meta Pixel loader.
// Loads IDs dynamically from /shop/api/tracking-config so no IDs are hardcoded.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var ATTR_KEY = 'fd_attribution';
  var TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ttclid'];

  function readSaved() {
    try {
      var raw = localStorage.getItem(ATTR_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.ts && Date.now() - parsed.ts > TTL_MS) {
        localStorage.removeItem(ATTR_KEY);
        return null;
      }
      return parsed;
    } catch { return null; }
  }

  function captureAttribution() {
    var existing = readSaved() || {};
    var params = new URLSearchParams(window.location.search || '');
    var found = false;
    var next = Object.assign({}, existing);

    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      var v = (params.get(k) || '').trim().slice(0, 120);
      if (v) {
        next[k] = v;
        found = true;
      }
    }

    if (found || !existing.ts) {
      if (!next.landing) next.landing = (window.location.pathname || '/').slice(0, 120);
      if (!next.referrer && document.referrer) {
        try {
          var refHost = new URL(document.referrer).hostname;
          if (refHost && refHost !== window.location.hostname) {
            next.referrer = refHost.slice(0, 120);
          }
        } catch {}
      }
      next.ts = Date.now();
      try { localStorage.setItem(ATTR_KEY, JSON.stringify(next)); } catch {}
    }
    return next;
  }

  var currentAttr = captureAttribution();

  window.fdAttribution = function () {
    var attr = readSaved() || currentAttr || {};
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (attr[k]) out[k] = attr[k];
    }
    if (attr.referrer) out.referrer = attr.referrer;
    if (attr.landing) out.landing = attr.landing;
    return out;
  };

  var cfg = null;
  var queue = [];
  var ready = false;

  function loadScript(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  function initGtag(ga4Id, adsId) {
    var primary = ga4Id || adsId;
    if (!primary) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    if (ga4Id) window.gtag('config', ga4Id, { send_page_view: true });
    if (adsId) window.gtag('config', adsId);
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(primary));
  }

  function initMetaPixel(pixelId) {
    if (!pixelId || window.fbq) return;
    var n = window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    loadScript('https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', pixelId);
    window.fbq('track', 'PageView');
  }

  function dispatch(name, params) {
    var p = Object.assign({}, params || {});
    if (typeof window.gtag === 'function' && (cfg.ga4Id || cfg.adsId)) {
      window.gtag('event', name, p);
      if (name === 'purchase' && cfg.adsId && cfg.adsPurchaseLabel) {
        window.gtag('event', 'conversion', {
          send_to: cfg.adsId + '/' + cfg.adsPurchaseLabel,
          value: p.value || 0,
          currency: p.currency || 'IRR',
          transaction_id: p.transaction_id || ''
        });
      }
    }
    if (typeof window.fbq === 'function' && cfg.metaPixelId) {
      var fbMap = {
        view_item: 'ViewContent',
        begin_checkout: 'InitiateCheckout',
        purchase: 'Purchase',
        sign_up: 'CompleteRegistration'
      };
      var fbName = fbMap[name];
      if (fbName) {
        window.fbq('track', fbName, {
          value: p.value || 0,
          currency: p.currency || 'IRR',
          content_name: p.plan_id || undefined
        });
      }
    }
  }

  window.fdTrack = function (name, params) {
    if (!name) return;
    if (!ready) {
      queue.push([name, params]);
      return;
    }
    dispatch(name, params);
  };

  fetch('/shop/api/tracking-config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      cfg = data || {};
      initGtag(cfg.ga4Id || '', cfg.adsId || '');
      initMetaPixel(cfg.metaPixelId || '');
    })
    .catch(function () { cfg = {}; })
    .finally(function () {
      ready = true;
      for (var i = 0; i < queue.length; i++) {
        dispatch(queue[i][0], queue[i][1]);
      }
      queue = [];
    });
})();

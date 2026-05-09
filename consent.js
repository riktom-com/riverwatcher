(function () {
  const PUB      = 'ca-pub-2646745084546998';
  const KEY      = 'riktom_consent';
  const PRIVACY  = 'https://riktom.com/privacy.html';

  function stored() { try { return localStorage.getItem(KEY); } catch(e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, v); } catch(e) {} }

  function loadAds() {
    if (document.querySelector('[data-riktom-ads]')) return;
    const s = document.createElement('script');
    s.async = true;
    s.setAttribute('data-riktom-ads', '1');
    s.setAttribute('crossorigin', 'anonymous');
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + PUB;
    document.head.appendChild(s);
  }

  function injectStyles() {
    if (document.getElementById('riktom-consent-css')) return;
    const style = document.createElement('style');
    style.id = 'riktom-consent-css';
    style.textContent = `
      #riktom-consent {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        z-index: 999999;
        background: #1a1a2e;
        color: #e8e8f0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        border-top: 2px solid #4a9eff;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.4);
        animation: rcb-slide-up 0.3s ease;
      }
      @keyframes rcb-slide-up {
        from { transform: translateY(100%); }
        to   { transform: translateY(0); }
      }
      #riktom-consent .rcb-inner {
        max-width: 960px;
        margin: 0 auto;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        gap: 20px;
        flex-wrap: wrap;
      }
      #riktom-consent p {
        margin: 0;
        flex: 1;
        min-width: 220px;
        line-height: 1.5;
        color: #c8c8da;
      }
      #riktom-consent p a {
        color: #4a9eff;
        text-decoration: underline;
      }
      #riktom-consent .rcb-btns {
        display: flex;
        gap: 10px;
        flex-shrink: 0;
        flex-wrap: wrap;
      }
      #riktom-consent button {
        padding: 9px 20px;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      #riktom-consent .rcb-accept {
        background: #4a9eff;
        color: #fff;
      }
      #riktom-consent .rcb-accept:hover { background: #2d7dd2; }
      #riktom-consent .rcb-decline {
        background: transparent;
        color: #8888aa;
        border: 1px solid #444466;
      }
      #riktom-consent .rcb-decline:hover { color: #aaaacc; border-color: #6666aa; }
    `;
    document.head.appendChild(style);
  }

  function dismiss() {
    const el = document.getElementById('riktom-consent');
    if (el) el.remove();
  }

  function accept() {
    store('accepted');
    dismiss();
    loadAds();
  }

  function decline() {
    store('declined');
    dismiss();
  }

  function showBanner() {
    injectStyles();
    const banner = document.createElement('div');
    banner.id = 'riktom-consent';
    banner.innerHTML =
      '<div class="rcb-inner">' +
        '<p>We use <strong>Google AdSense</strong> to show ads that keep our tools free. ' +
        'Ads may be personalized based on your browsing. ' +
        '<a href="' + PRIVACY + '" target="_blank" rel="noopener">Privacy policy</a>.</p>' +
        '<div class="rcb-btns">' +
          '<button class="rcb-decline" id="rcb-decline-btn">Opt Out</button>' +
          '<button class="rcb-accept" id="rcb-accept-btn">Accept &amp; Continue</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);
    document.getElementById('rcb-accept-btn').addEventListener('click', accept);
    document.getElementById('rcb-decline-btn').addEventListener('click', decline);
  }

  function init() {
    const consent = stored();
    if (consent === 'accepted') {
      loadAds();
    } else if (!consent) {
      showBanner();
    }
    // declined → do nothing, no ads loaded
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

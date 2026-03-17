// ============================================================
//  CHAUKAS AI — Content Script v4 (Simple & Reliable)
// ============================================================

console.log('[Chaukas AI] Script loaded on:', window.location.href);

let overlayActive  = false;
let payIntercepted = false;

const session = {
  startTime:       Date.now(),
  keystrokes:      [],
  mouseVelocities: [],
  pasteDetected:   false,
  fieldOrder:      [],
  hesitationMs:    0,
  hesitationStart: null,
  lastMouseX:      0,
  lastMouseY:      0,
  lastMouseTime:   Date.now(),
};

// ── KEYSTROKE ──────────────────────────────────────────────
let lastKey = null;
document.addEventListener('keydown', (e) => {
  const now = Date.now();
  if (lastKey) {
    const diff = now - lastKey;
    if (diff > 0 && diff < 5000) session.keystrokes.push(diff);
  }
  lastKey = now;
}, true);

// ── MOUSE ──────────────────────────────────────────────────
document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - session.lastMouseTime < 50) return;
  const dx    = e.clientX - session.lastMouseX;
  const dy    = e.clientY - session.lastMouseY;
  const dt    = now - session.lastMouseTime;
  const speed = Math.sqrt(dx*dx + dy*dy) / (dt / 1000);
  session.mouseVelocities.push(speed);
  if (session.mouseVelocities.length > 100) session.mouseVelocities.shift();
  session.lastMouseX    = e.clientX;
  session.lastMouseY    = e.clientY;
  session.lastMouseTime = now;
}, true);

// ── PASTE ──────────────────────────────────────────────────
document.addEventListener('paste', () => {
  session.pasteDetected = true;
  console.log('[Chaukas AI] Paste detected');
}, true);

// ── FIELD ORDER ────────────────────────────────────────────
document.addEventListener('focus', (e) => {
  const id = e.target.id;
  if (id && !session.fieldOrder.includes(id)) session.fieldOrder.push(id);
}, true);

// ── PAY BUTTON — watch for it and attach listener ──────────
function attachPayListener() {
  const btn = document.getElementById('pay-btn');
  if (!btn) return;
  if (btn._chaukasAttached) return;
  btn._chaukasAttached = true;

  session.hesitationStart = Date.now();
  console.log('[Chaukas AI] Pay button found — listener attached');

  btn.addEventListener('click', (e) => {
    // Stop everything
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    if (payIntercepted) return;
    payIntercepted = true;

    console.log('[Chaukas AI] Pay button clicked — intercepted');

    // Hesitation
    if (session.hesitationStart) {
      session.hesitationMs = Date.now() - session.hesitationStart;
    }

    // Get amount from sessionStorage
    let amount = 0;
    try {
      const txn = JSON.parse(sessionStorage.getItem('txn') || '{}');
      amount = parseFloat(txn.amount) || 0;
    } catch(err) {}

    // Build signals
    const kArr   = session.keystrokes.filter(k => k > 0);
    const avgKey = kArr.length ? Math.round(kArr.reduce((a,b)=>a+b,0)/kArr.length) : 0;
    const mArr   = session.mouseVelocities.filter(v => v > 0);
    const avgMse = mArr.length ? Math.round(mArr.reduce((a,b)=>a+b,0)/mArr.length) : 0;
    const hour   = new Date().getHours();
    const conn   = navigator.connection || {};

    const signals = {
      amount,
      avgKeystrokeMs:      avgKey,
      avgMouseSpeed:       avgMse,
      copyPasteUsed:       session.pasteDetected,
      fieldOrder:          session.fieldOrder,
      hesitationMs:        session.hesitationMs,
      sessionDurationMs:   Date.now() - session.startTime,
      hourOfDay:           hour,
      isLateNight:         hour >= 23 || hour <= 5,
      networkType:         conn.effectiveType || 'unknown',
      isNewNetwork:        false,
      locationChanged:     false,
      isFirstTimeReceiver: false,
      lat:                 null,
      lng:                 null,
    };

    // Check first time receiver
    try {
      const txn = JSON.parse(sessionStorage.getItem('txn') || '{}');
      if (txn.upi) {
        chrome.storage.local.get('knownReceivers', (data) => {
          const known = data.knownReceivers || [];
          if (!known.includes(txn.upi)) {
            signals.isFirstTimeReceiver = true;
            known.push(txn.upi);
            chrome.storage.local.set({ knownReceivers: known });
          }
        });
      }
    } catch(locErr) {}

    console.log('[Chaukas AI] Signals built:', JSON.stringify(signals));

    // Show analyzing state
    btn.textContent      = 'Analyzing...';
    btn.disabled         = true;
    btn.style.background = '#94A3B8';

    // Get location then send signals
    function sendSignals(finalSignals) {
      chrome.runtime.sendMessage({ type: 'ANALYZE_TRANSACTION', signals: finalSignals }, (res) => {
        console.log('[Chaukas AI] Background response:', res);
      });
    }

    try {
      navigator.geolocation.getCurrentPosition((pos) => {
        signals.lat = pos.coords.latitude;
        signals.lng = pos.coords.longitude;
        chrome.storage.local.get('baseline', (data) => {
          const b = data && data.baseline;
          if (b && b.lastLat && b.lastLng) {
            const dist = getDistanceKm(b.lastLat, b.lastLng, signals.lat, signals.lng);
            console.log('[Chaukas AI] Distance from baseline:', Math.round(dist) + 'km');
            if (dist > 50) {
              signals.locationChanged = true;
            }
          }
          sendSignals(signals);
        });
      }, () => {
        sendSignals(signals);
      }, { timeout: 3000, maximumAge: 60000 });
    } catch(geoErr) {
      sendSignals(signals);
    }

  }, true);
}

// Poll for pay button (it may not exist on page load)
const pollInterval = setInterval(() => {
  const btn = document.getElementById('pay-btn');
  if (btn) {
    attachPayListener();
    clearInterval(pollInterval);
  }
}, 300);

// Firebase database URL
const FB_DATABASE_URL = 'https://chaukas-ai-default-rtdb.firebaseio.com';

// Active polling interval
let fbPollInterval = null;

// ── POLL FIREBASE FOR TRUSTED DEVICE DECISION ──────────────
function startPollingFirebase(txnId) {
  console.log('[Chaukas AI] Polling Firebase for txnId:', txnId);

  fbPollInterval = setInterval(async () => {
    try {
      const res  = await fetch(FB_DATABASE_URL + '/transactions/' + txnId + '/status.json');
      const status = await res.json();
      console.log('[Chaukas AI] Firebase status:', status);

      if (status === 'AUTHORIZED') {
        clearInterval(fbPollInterval);
        overlayActive  = false;
        payIntercepted = false;
        const overlay = document.getElementById('chaukas-overlay');
        if (overlay) overlay.remove();
        showAuthorizedBanner();
        setTimeout(() => { window.location.href = 'success.html'; }, 2000);

      } else if (status === 'BLOCKED') {
        clearInterval(fbPollInterval);
        overlayActive  = false;
        payIntercepted = false;
        const overlay = document.getElementById('chaukas-overlay');
        if (overlay) {
          overlay.querySelector('#ck-sheet').innerHTML +=
            '<div style="background:#FEE2E2;border-radius:12px;padding:14px;margin-top:12px;color:#B91C1C;font-weight:700;text-align:center;">🚫 Blocked by your trusted device</div>';
        }
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 2500);
      }
    } catch(e) {
      console.log('[Chaukas AI] Firebase poll error:', e.message);
    }
  }, 2000);
}

function showAuthorizedBanner() {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#22C55E;color:white;padding:14px 24px;border-radius:14px;font-weight:700;font-size:15px;z-index:2147483647;box-shadow:0 8px 24px rgba(34,197,94,0.4);';
  banner.textContent = '✅ Authorized by trusted device — proceeding...';
  document.body.appendChild(banner);
}

// ── LISTEN FROM BACKGROUND ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  console.log('[Chaukas AI] Message from background:', msg.type);

  if (msg.type === 'SHOW_OVERLAY') {
    showOverlay(msg.verdict, msg.reason, msg.score, msg.txnId);
    // Start polling Firebase for trusted device response
    if (msg.txnId) startPollingFirebase(msg.txnId);
  }

  if (msg.type === 'ALLOW_TRANSACTION') {
    overlayActive  = false;
    payIntercepted = false;
    window.location.href = 'success.html';
  }
});

// ── OVERLAY ────────────────────────────────────────────────
function showOverlay(verdict, reason, score, txnId) {
  overlayActive = true;

  const existing = document.getElementById('chaukas-overlay');
  if (existing) existing.remove();

  // HARD BLOCK — score 56+ or BLOCKED verdict
  // No proceed option. Decision is on trusted device only.
  const isHardBlock = score >= 56 || verdict === 'BLOCKED';
  const color       = isHardBlock ? '#EF4444' : '#F59E0B';
  const title       = isHardBlock ? 'Transaction Blocked' : 'Suspicious Activity';
  const ico         = isHardBlock ? '🚫' : '⚠️';

  // Trusted message changes based on risk level
  const trustedMsg = isHardBlock
    ? `🔒 This device is frozen.<br/>
       <small>An alert has been sent to your other devices.<br/>
       Only your trusted device can authorize or cancel this payment.</small>`
    : `📱 Alert sent to your other devices via Gmail.<br/>
       <small>You can proceed below or cancel from your trusted device.</small>`;

  const overlay = document.createElement('div');
  overlay.id    = 'chaukas-overlay';
  overlay.style.cssText = [
    'position:fixed','top:0','left:0','right:0','bottom:0',
    'z-index:2147483647',
    'background:rgba(0,0,0,0.85)',
    'display:flex','align-items:flex-end',
    "font-family:'Segoe UI',sans-serif",
  ].join(';');

  overlay.innerHTML = `
    <style>
      @keyframes ckUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
      #ck-sheet{
        background:white;border-radius:28px 28px 0 0;
        padding:28px 24px 52px;width:100%;
        animation:ckUp 0.3s ease;
        max-height:88vh;overflow-y:auto;
      }
      #ck-sheet .pill{width:40px;height:5px;border-radius:3px;background:#E2E8F0;margin:0 auto 20px;}
      #ck-sheet .ico{font-size:44px;text-align:center;margin-bottom:10px;}
      #ck-sheet h2{font-size:20px;font-weight:800;color:#0F172A;text-align:center;margin-bottom:8px;}
      #ck-sheet .badge{
        display:block;width:fit-content;margin:0 auto 16px;
        background:${color}20;color:${color};
        border:1.5px solid ${color};
        padding:4px 14px;border-radius:20px;
        font-size:13px;font-weight:700;
      }
      #ck-sheet .reason{
        background:#F8FAFC;border:1.5px solid #E2E8F0;
        border-radius:12px;padding:14px;
        font-size:13px;color:#475569;line-height:1.6;
        margin-bottom:12px;
      }
      #ck-sheet .trusted{
        background:${isHardBlock ? '#FEE2E2' : '#FEF3C7'};
        border:1.5px solid ${isHardBlock ? '#FCA5A5' : '#FCD34D'};
        border-radius:12px;padding:14px;
        font-size:13px;color:${isHardBlock ? '#991B1B' : '#92400E'};
        font-weight:600;text-align:center;margin-bottom:20px;
        line-height:1.7;
      }
      #ck-sheet .trusted small{display:block;font-weight:400;font-size:11px;margin-top:4px;}
      #ck-sheet button{
        width:100%;padding:15px;border:none;border-radius:12px;
        font-size:15px;font-weight:700;cursor:pointer;
        font-family:inherit;margin-bottom:10px;
      }
      #ck-sheet .block-btn{background:#EF4444;color:white;}
      #ck-sheet .proceed-btn{background:#F1F5F9;color:#475569;}
    </style>
    <div id="ck-sheet">
      <div class="pill"></div>
      <div class="ico">${ico}</div>
      <h2>${title}</h2>
      <span class="badge">Risk Score: ${score}%</span>
      <div class="reason">
        <strong style="display:block;margin-bottom:6px;color:#0F172A;">
          Why Chaukas AI flagged this:
        </strong>
        ${reason}
      </div>
      <div class="trusted">${trustedMsg}</div>
      <button class="block-btn" id="ck-block">Report Fraud &amp; Block Payment</button>
      ${!isHardBlock ? '<button class="proceed-btn" id="ck-proceed">This was me — Proceed Anyway</button>' : ''}
    </div>
  `;

  document.body.appendChild(overlay);

  // Block button — always present
  document.getElementById('ck-block').onclick = () => {
    overlayActive  = false;
    payIntercepted = false;
    overlay.remove();
    chrome.runtime.sendMessage({ type: 'USER_OVERRIDE' });
    alert('Payment blocked. Your account is secured.');
    window.location.href = 'dashboard.html';
  };

  // Proceed button — only on low-medium risk
  const proceedBtn = document.getElementById('ck-proceed');
  if (proceedBtn) {
    proceedBtn.onclick = () => {
      overlayActive  = false;
      payIntercepted = false;
      overlay.remove();
      chrome.runtime.sendMessage({ type: 'USER_OVERRIDE' });
      window.location.href = 'success.html';
    };
  }
}


// ── DISTANCE HELPER (Haversine formula) ────────────────────
function getDistanceKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2) * Math.sin(dLat/2) +
               Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
               Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
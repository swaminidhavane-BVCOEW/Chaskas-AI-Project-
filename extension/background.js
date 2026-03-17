// ============================================================
//  CHAUKAS AI — Background Service Worker v5
//  Firebase Realtime DB + Gemini + Two-Device Alert System
// ============================================================

const GEMINI_API_KEY = 'AIzaSyDmP3xlRopIW4QdOoDMh8MaKxepLXQbY0g';
const GEMINI_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_API_KEY;

// Firebase config
const FB_DATABASE_URL = 'https://chaukas-ai-default-rtdb.firebaseio.com';
const FB_API_KEY      = 'AIzaSyCpmSYOoCGiYj6P9mrwp3stOd1EsRzImMA';

// EmailJS config — paste your NEW keys here after resetting them
const EMAILJS_SERVICE_ID  = 'YOUR_NEW_SERVICE_ID';
const EMAILJS_TEMPLATE_ID = 'YOUR_NEW_TEMPLATE_ID';
const EMAILJS_PUBLIC_KEY  = 'YOUR_NEW_PUBLIC_KEY';
const TRUSTED_EMAIL       = 'jyoti21204@gmail.com';

// ── MESSAGE LISTENER ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ANALYZE_TRANSACTION') {
    analyzeTransaction(msg.signals, sender.tab.id);
    sendResponse({ status: 'analyzing' });
    return true;
  }
  if (msg.type === 'USER_OVERRIDE') {
    chrome.storage.local.get('overrideCount', (d) => {
      chrome.storage.local.set({ overrideCount: (d.overrideCount || 0) + 1 });
    });
    sendResponse({ status: 'ok' });
    return true;
  }
  if (msg.type === 'GET_BASELINE') {
    getBaseline().then(b => sendResponse({ baseline: b }));
    return true;
  }
});

// ── MAIN ANALYSIS ──────────────────────────────────────────
async function analyzeTransaction(signals, tabId) {
  try {
    console.log('[Chaukas AI] === ANALYSIS STARTED ===');

    const baseline = await getBaseline();
    await updateBaseline(signals);

    const zScore = safeZScore(signals, baseline);

    // ── SCORING ────────────────────────────────────────────
    const amount = Number(signals.amount) || 0;
    let baseScore = 0;
    const riskFactors = [];

    if (amount > 25000) { baseScore += 35; riskFactors.push('Very large amount: Rs.' + amount.toLocaleString('en-IN')); }
    else if (amount > 10000) { baseScore += 20; riskFactors.push('Large amount: Rs.' + amount.toLocaleString('en-IN')); }

    if (signals.copyPasteUsed)    { baseScore += 20; riskFactors.push('UPI ID was copy-pasted instead of typed'); }
    if (signals.isLateNight)      { baseScore += 15; riskFactors.push('Transaction at unusual hour: ' + signals.hourOfDay + ':00'); }
    if (signals.isNewNetwork)     { baseScore += 20; riskFactors.push('Device is on an unrecognized network'); }
    if (signals.sessionDurationMs > 0 && signals.sessionDurationMs < 12000) { baseScore += 20; riskFactors.push('Session completed suspiciously fast'); }
    if (signals.hesitationMs > 7000) { baseScore += 15; riskFactors.push('Unusual hesitation before confirming'); }
    if (zScore.overall > 2.0)     { baseScore += 20; riskFactors.push('Behavior ' + zScore.overall + 'x outside normal pattern'); }
    if (signals.isFirstTimeReceiver) { baseScore += 15; riskFactors.push('First-time receiver'); }

    let locationStacking = false;
    if (signals.locationChanged) {
      riskFactors.push('Different location from usual area');
      locationStacking = true;
    }

    // Combination multipliers
    let multiplier = 1.0;
    if (amount > 10000 && signals.copyPasteUsed)                        multiplier = Math.max(multiplier, 1.5);
    if (signals.isLateNight && signals.isNewNetwork)                    multiplier = Math.max(multiplier, 1.4);
    if (signals.isFirstTimeReceiver && signals.copyPasteUsed)           multiplier = Math.max(multiplier, 1.3);
    if (signals.sessionDurationMs < 12000 && amount > 10000)            multiplier = Math.max(multiplier, 1.5);
    if (zScore.overall > 2.0 && (locationStacking || signals.isNewNetwork || signals.copyPasteUsed)) multiplier = Math.max(multiplier, 1.6);
    if (riskFactors.length >= 3)                                        multiplier = Math.max(multiplier, 1.3);
    if (locationStacking && (signals.copyPasteUsed || signals.isNewNetwork || amount > 10000)) {
      baseScore += 15;
      multiplier = Math.max(multiplier, 1.4);
    }

    const finalScore = Math.min(Math.round(baseScore * multiplier), 98);
    console.log('[Chaukas AI] Final score:', finalScore, 'multiplier:', multiplier);
    console.log('[Chaukas AI] Risk factors:', riskFactors);

    const shouldAnalyze = finalScore >= 15 || amount > 8000;
    if (!shouldAnalyze) {
      console.log('[Chaukas AI] Clean transaction — allowed');
      return;
    }

    // Call Gemini
    const payload = buildPayload(signals, baseline, zScore, riskFactors, finalScore);
    const verdict = await callGemini(payload, finalScore);
    console.log('[Chaukas AI] Verdict:', verdict);

    if (verdict.riskScore >= 35) {
      // Generate unique transaction ID
      const txnId = 'TXN' + Date.now();

      // Write to Firebase
      await writeToFirebase(txnId, {
        status:    'PENDING',
        riskScore: verdict.riskScore,
        verdict:   verdict.verdict,
        reason:    verdict.reason,
        amount:    amount,
        time:      new Date().toISOString(),
      });

      // Show overlay on page with txnId
      chrome.tabs.sendMessage(tabId, {
        type:    'SHOW_OVERLAY',
        verdict: verdict.verdict,
        reason:  verdict.reason,
        score:   verdict.riskScore,
        txnId,
      });

      // Update blocked count
      chrome.storage.local.get('blockedCount', (d) => {
        chrome.storage.local.set({ blockedCount: (d.blockedCount || 0) + 1 });
      });

      // Send email alert to trusted device
      await sendEmailAlert(verdict, signals, txnId);

    } else {
      console.log('[Chaukas AI] Score', verdict.riskScore, '— safe');
    }

  } catch (err) {
    console.error('[Chaukas AI] ERROR:', err.message, err.stack);
  }
}

// ── FIREBASE HELPERS ───────────────────────────────────────

// Write transaction status to Firebase
async function writeToFirebase(txnId, data) {
  const url = FB_DATABASE_URL + '/transactions/' + txnId + '.json?auth=' + FB_API_KEY;
  try {
    const res = await fetch(url, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const result = await res.json();
    console.log('[Chaukas AI] Firebase write:', result);
  } catch (e) {
    console.error('[Chaukas AI] Firebase write error:', e.message);
  }
}

// Read transaction status from Firebase
async function readFromFirebase(txnId) {
  const url = FB_DATABASE_URL + '/transactions/' + txnId + '.json';
  try {
    const res  = await fetch(url);
    const data = await res.json();
    return data;
  } catch (e) {
    console.error('[Chaukas AI] Firebase read error:', e.message);
    return null;
  }
}

// ── BASELINE ───────────────────────────────────────────────
function getDefaultBaseline() {
  return {
    sessionCount: 0, avgKeystrokeMs: 350, avgMouseSpeed: 380,
    avgHesitationMs: 2000, avgSessionMs: 25000,
    knownNetworks: [], lastLat: null, lastLng: null,
    keystrokeStdDev: 100, mouseStdDev: 180,
  };
}

function getBaseline() {
  return new Promise((resolve) => {
    chrome.storage.local.get('baseline', (data) => {
      resolve((data && data.baseline) ? data.baseline : getDefaultBaseline());
    });
  });
}

function updateBaseline(signals) {
  return new Promise((resolve) => {
    chrome.storage.local.get('baseline', (data) => {
      const b = (data && data.baseline) ? data.baseline : getDefaultBaseline();
      const n = b.sessionCount + 1;
      if (signals.avgKeystrokeMs > 0) b.avgKeystrokeMs = rollingAvg(b.avgKeystrokeMs, signals.avgKeystrokeMs, n);
      if (signals.avgMouseSpeed > 0)  b.avgMouseSpeed  = rollingAvg(b.avgMouseSpeed,  signals.avgMouseSpeed,  n);
      if (signals.hesitationMs > 0)   b.avgHesitationMs = rollingAvg(b.avgHesitationMs, signals.hesitationMs, n);
      if (signals.sessionDurationMs > 0) b.avgSessionMs = rollingAvg(b.avgSessionMs, signals.sessionDurationMs, n);
      if (signals.networkType && signals.networkType !== 'unknown') {
        if (!Array.isArray(b.knownNetworks)) b.knownNetworks = [];
        if (b.knownNetworks.indexOf(signals.networkType) === -1) b.knownNetworks.push(signals.networkType);
      }
      if (signals.lat && signals.lng) { b.lastLat = signals.lat; b.lastLng = signals.lng; }
      b.sessionCount = n;
      chrome.storage.local.set({ baseline: b }, () => {
        console.log('[Chaukas AI] Baseline saved. Sessions:', n);
        resolve(b);
      });
    });
  });
}

function rollingAvg(o, v, n) {
  if (!v || v === 0) return o;
  return Math.round(((o * (n-1)) + v) / n);
}

// ── Z-SCORE ────────────────────────────────────────────────
function safeZScore(signals, baseline) {
  const r = { keystroke: 0, mouse: 0, hesitation: 0, session: 0, overall: 0 };
  try {
    if (baseline.sessionCount < 2) return r;
    if (signals.avgKeystrokeMs && baseline.avgKeystrokeMs)
      r.keystroke = Math.abs(signals.avgKeystrokeMs - baseline.avgKeystrokeMs) / (baseline.keystrokeStdDev || 100);
    if (signals.avgMouseSpeed && baseline.avgMouseSpeed)
      r.mouse = Math.abs(signals.avgMouseSpeed - baseline.avgMouseSpeed) / (baseline.mouseStdDev || 180);
    if (signals.hesitationMs && baseline.avgHesitationMs)
      r.hesitation = Math.abs(signals.hesitationMs - baseline.avgHesitationMs) / 600;
    if (signals.sessionDurationMs && baseline.avgSessionMs)
      r.session = Math.abs(signals.sessionDurationMs - baseline.avgSessionMs) / 5000;
    const vals = [r.keystroke, r.mouse, r.hesitation, r.session].filter(v => v > 0 && isFinite(v));
    r.overall = vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*100)/100 : 0;
  } catch(e) { console.error('[Chaukas AI] Z-Score error:', e.message); }
  return r;
}

// ── PAYLOAD ────────────────────────────────────────────────
function buildPayload(signals, baseline, zScore, riskFactors, preScore) {
  return {
    transaction: {
      amount: Number(signals.amount)||0, hourOfDay: signals.hourOfDay||0,
      isLateNight: signals.isLateNight||false, networkType: signals.networkType||'unknown',
      isNewNetwork: signals.isNewNetwork||false, copyPasteUsed: signals.copyPasteUsed||false,
      sessionDurationMs: signals.sessionDurationMs||0, hesitationMs: signals.hesitationMs||0,
      locationChanged: signals.locationChanged||false, isFirstTimeReceiver: signals.isFirstTimeReceiver||false,
    },
    behavioral: { overallZScore: zScore.overall, keystrokeZScore: zScore.keystroke, mouseZScore: zScore.mouse },
    baseline: { sessionsLearned: baseline.sessionCount, avgTypingMs: baseline.avgKeystrokeMs, knownNetworks: baseline.knownNetworks||[] },
    riskFactorsDetected: riskFactors,
    preComputedScore: preScore,
  };
}

// ── GEMINI ─────────────────────────────────────────────────
async function callGemini(payload, preScore) {
  const prompt =
    'You are Chaukas AI, a UPI fraud detection system for India.\n' +
    'Analyze these anonymous behavioral signals. Return ONLY valid JSON, no markdown.\n\n' +
    'Data:\n' + JSON.stringify(payload, null, 2) + '\n\n' +
    'Pre-computed rule score: ' + preScore + '/100. Use this as a strong signal.\n' +
    'verdict: SAFE if <35, REVIEW if 35-55, BLOCKED if >55\n\n' +
    'Return ONLY: {"riskScore":0,"verdict":"SAFE","reason":"2-3 plain English sentences","confidence":80}';
  try {
    const res  = await fetch(GEMINI_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1,maxOutputTokens:300} }),
    });
    const data = await res.json();
    if (data.error) return fallbackVerdict(payload, preScore);
    if (!data.candidates || !data.candidates[0]) return fallbackVerdict(payload, preScore);
    const clean = data.candidates[0].content.parts[0].text.replace(/```json|```/g,'').trim();
    return JSON.parse(clean);
  } catch(e) {
    return fallbackVerdict(payload, preScore);
  }
}

function fallbackVerdict(payload, preScore) {
  const score = preScore || Math.min(payload.riskFactorsDetected.length * 22, 95);
  return {
    riskScore: score,
    verdict:   score >= 56 ? 'BLOCKED' : score >= 35 ? 'REVIEW' : 'SAFE',
    reason:    'Suspicious activity: ' + payload.riskFactorsDetected.join('. ') + '.',
    confidence: 65,
  };
}

// ── EMAIL ALERT ────────────────────────────────────────────
async function sendEmailAlert(verdict, signals, txnId) {
  // The authorize URL opens on the phone — tapping it writes decision to Firebase
  const authorizeUrl = 'file:///C:/Users/YourName/Desktop/ChaukasAI/upi%20app/authorize.html?txnId=' + txnId;

  try {
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id:  EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id:     EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email:   TRUSTED_EMAIL,
          risk_score: verdict.riskScore,
          verdict:    verdict.verdict,
          reason:     verdict.reason,
          amount:     'Rs.' + (signals.amount || 'unknown'),
          time:       new Date().toLocaleTimeString('en-IN'),
          txn_id:     txnId,
          auth_url:   authorizeUrl,
        },
      }),
    });
    console.log('[Chaukas AI] Email sent to trusted device');
  } catch(e) {
    console.error('[Chaukas AI] Email failed:', e.message);
  }
}
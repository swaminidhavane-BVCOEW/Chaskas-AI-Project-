// popup.js — loads baseline stats and displays them

chrome.storage.local.get(['baseline', 'blockedCount'], (data) => {
  const b = data.baseline || {};
  const blocked = data.blockedCount || 0;
  const sessions = b.sessionCount || 0;

  // sessions learned
  document.getElementById('sessions').textContent = sessions;
  document.getElementById('blocked').textContent  = blocked;

  // typing & mouse averages
  document.getElementById('avg-type').textContent =
    b.avgKeystrokeMs ? b.avgKeystrokeMs + 'ms' : '—';
  document.getElementById('avg-mouse').textContent =
    b.avgMouseSpeed ? Math.round(b.avgMouseSpeed) : '—';

  // status
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const sub  = document.getElementById('status-sub');

  if (sessions < 3) {
    dot.classList.add('learning');
    text.textContent = 'Learning Your Behavior';
    sub.textContent  = `${3 - sessions} more session(s) until active protection`;
  } else {
    text.textContent = 'Active & Protecting';
    sub.textContent  = `Baseline built from ${sessions} sessions`;
  }
});

// Reset button
document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset your behavioral profile? Protection will restart from scratch.')) {
    chrome.storage.local.remove(['baseline', 'blockedCount'], () => {
      window.close();
    });
  }
});
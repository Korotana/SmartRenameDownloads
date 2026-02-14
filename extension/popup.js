/**
 * Popup UI Logic
 */

import { CONFIG } from './config.js';

// Load settings
async function loadSettings() {
  const data = await chrome.storage.sync.get(CONFIG.STORAGE.SETTINGS);
  return { ...CONFIG.DEFAULTS, ...(data[CONFIG.STORAGE.SETTINGS] || {}) };
}

// Load stats
async function loadStats() {
  const data = await chrome.storage.local.get(CONFIG.STORAGE.STATS);
  return data[CONFIG.STORAGE.STATS] || {
    totalRenames: 0,
    successful: 0,
    failed: 0
  };
}

// Load history
async function loadHistory() {
  const data = await chrome.storage.local.get(CONFIG.STORAGE.HISTORY);
  return data[CONFIG.STORAGE.HISTORY] || [];
}

// Check status
async function checkStatus() {
  const settings = await loadSettings();
  const statusEl = document.getElementById('status');
  
  if (!settings.hfToken) {
    statusEl.className = 'status not-configured';
    statusEl.innerHTML = `
      <strong>⚠️ Not Configured</strong><br>
      Click Settings to add your FREE Hugging Face API token
    `;
  } else {
    statusEl.className = 'status configured';
    statusEl.innerHTML = `
      <strong>✓ Ready to Rename!</strong><br>
      Download any image and watch it get a smart name
    `;
  }
}

// Update stats display
async function updateStats() {
  const stats = await loadStats();
  const history = await loadHistory();
  
  // Calculate today's count
  const today = new Date().toDateString();
  const todayCount = history.filter(h => {
    const itemDate = new Date(h.timestamp).toDateString();
    return itemDate === today && h.success;
  }).length;
  
  // Success rate
  const successRate = stats.totalRenames > 0
    ? Math.round((stats.successful / stats.totalRenames) * 100)
    : 0;
  
  document.getElementById('todayCount').textContent = todayCount;
  document.getElementById('successRate').textContent = `${successRate}%`;
}

// Display history
async function displayHistory() {
  const history = await loadHistory();
  const container = document.getElementById('historyList');
  
  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty">
        No renames yet.<br>
        Download an image to get started!
      </div>
    `;
    return;
  }
  
  const html = history.slice(0, 5).map(item => {
    const time = formatTime(item.timestamp);
    
    if (item.success) {
      const shortOriginal = shortenName(item.original);
      const shortRenamed = shortenName(item.renamed);
      
      return `
        <div class="history-item success">
          <div class="original">${escapeHtml(shortOriginal)}</div>
          <div class="renamed">→ ${escapeHtml(shortRenamed)}</div>
          <div class="time">${time}</div>
        </div>
      `;
    } else {
      return `
        <div class="history-item error">
          <div class="error-text">✗ ${escapeHtml(item.filename || 'Unknown')}</div>
          <div class="time">${time} - ${escapeHtml(item.error?.slice(0, 40) || 'Error')}</div>
        </div>
      `;
    }
  }).join('');
  
  container.innerHTML = html;
}

// Helpers
function formatTime(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diff = now - date;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  
  return date.toLocaleDateString();
}

function shortenName(name) {
  if (name.length <= 35) return name;
  const ext = name.split('.').pop();
  const base = name.slice(0, -(ext.length + 1));
  return base.slice(0, 30) + '...' + ext;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event listeners
document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Initialize
(async () => {
  await checkStatus();
  await updateStats();
  await displayHistory();
  
  // Refresh every 2 seconds
  setInterval(async () => {
    await updateStats();
    await displayHistory();
  }, 2000);
})();

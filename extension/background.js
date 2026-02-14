/**
 * Background Service Worker
 * Handles image downloads and AI renaming
 */

import { CONFIG } from './config.js';
import { captionImage, captionToFilename, prepareImageForAPI } from './hf-api.js';

// Rate limiting
let requestCount = 0;
let requestTimestamp = Date.now();

// Helper: Get settings
async function getSettings() {
  const data = await chrome.storage.sync.get(CONFIG.STORAGE.SETTINGS);
  return { ...CONFIG.DEFAULTS, ...(data[CONFIG.STORAGE.SETTINGS] || {}) };
}

// Helper: Save to history
async function addToHistory(entry) {
  const data = await chrome.storage.local.get(CONFIG.STORAGE.HISTORY);
  const history = data[CONFIG.STORAGE.HISTORY] || [];
  
  history.unshift({
    ...entry,
    id: Date.now(),
    timestamp: Date.now()
  });
  
  // Keep last 100
  const trimmed = history.slice(0, 100);
  await chrome.storage.local.set({ [CONFIG.STORAGE.HISTORY]: trimmed });
}

// Helper: Update stats
async function updateStats(success, method) {
  const data = await chrome.storage.local.get(CONFIG.STORAGE.STATS);
  const stats = data[CONFIG.STORAGE.STATS] || {
    totalRenames: 0,
    successful: 0,
    failed: 0,
    bySource: {}
  };
  
  stats.totalRenames++;
  if (success) stats.successful++;
  else stats.failed++;
  
  stats.bySource[method] = (stats.bySource[method] || 0) + 1;
  
  await chrome.storage.local.set({ [CONFIG.STORAGE.STATS]: stats });
}

// Helper: Check if image type
function isImage(downloadItem) {
  const filename = (downloadItem.filename || '').toLowerCase();
  const url = (downloadItem.finalUrl || downloadItem.url || '').toLowerCase();

  const extFromName = filename.split('.').pop();
  const extFromUrl = (() => {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').pop() || '';
      return last.includes('.') ? last.split('.').pop() : '';
    } catch { return ''; }
  })();

  return !!(CONFIG.IMAGE_TYPES[extFromName] || CONFIG.IMAGE_TYPES[extFromUrl]);
}


// Helper: Get extension
function getExtension(downloadItem) {
  const filename = (downloadItem.filename || '').toLowerCase();
  const ext = filename.split('.').pop();
  
  if (CONFIG.IMAGE_TYPES[ext]) return ext;
  
  // Fallback to MIME
  const mime = (downloadItem.mime || '').toLowerCase();
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  
  return 'jpg'; // Default
}

// Helper: Rate limit check
function checkRateLimit() {
  const now = Date.now();
  const elapsed = now - requestTimestamp;
  
  // Reset counter every minute
  if (elapsed > 60000) {
    requestCount = 0;
    requestTimestamp = now;
  }
  
  // Check limit
  if (requestCount >= CONFIG.RATE_LIMIT.maxPerMinute) {
    const waitTime = 60000 - elapsed;
    throw new Error(`Rate limit reached. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
  }
  
  requestCount++;
}

// Helper: Fetch image
async function fetchImage(url, maxSize) {
  try {
    const response = await fetch(url, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    
    // Check size
    if (buffer.byteLength > maxSize) {
      throw new Error(`Image too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB`);
    }
    
    return buffer;
    
  } catch (error) {
    console.error('Image fetch error:', error);
    throw error;
  }
}

// Helper: Show notification
async function notify(title, message, success = true) {
  const settings = await getSettings();
  if (!settings.enableNotifications) return;
  
  chrome.notifications.create({
    type: 'basic',
    iconUrl: success ? 'icon48.png' : 'icon48.png',
    title: title,
    message: message,
    priority: 1
  });
}

// Helper: Update badge
async function updateBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) {
    await chrome.action.setBadgeBackgroundColor({ color });
  }
  
  if (text) {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 3000);
  }
}

// Main: Rename image with AI
async function renameImage(downloadItem) {
  const settings = await getSettings();
  const url = downloadItem.finalUrl || downloadItem.url;
  const ext = getExtension(downloadItem);
  
  console.log('[Smart Rename] Processing:', downloadItem.filename);
  
  try {
    // Check if token configured
    if (!settings.hfToken) {
      throw new Error('API token not configured. Click extension icon to set up.');
    }
    
    // Check rate limit
    checkRateLimit();
    
    // Show processing
    await updateBadge('...', '#0066CC');
    
    // Fetch image
    console.log('[Smart Rename] Fetching image...');
    const imageBuffer = await fetchImage(url, settings.maxImageSize);
    
    // Check minimum size
    if (settings.skipSmallImages && imageBuffer.byteLength < settings.minImageSize) {
      console.log('[Smart Rename] Image too small, skipping');
      return null;
    }
    
    // Prepare for API (resize, optimize)
    console.log('[Smart Rename] Preparing image...');
    const imageBase64 = await prepareImageForAPI(imageBuffer);
    
    // Call AI
    console.log('[Smart Rename] Calling AI...');
    const caption = await captionImage(imageBase64, settings);
    console.log('[Smart Rename] Caption:', caption);
    
    // Convert to filename
    const basename = captionToFilename(caption, settings);
    const finalName = `${basename}.${ext}`;
    
    console.log('[Smart Rename] Final name:', finalName);
    
    // Save to history
    await addToHistory({
      success: true,
      original: downloadItem.filename,
      renamed: finalName,
      caption: caption,
      source: new URL(url).hostname
    });
    
    // Update stats
    await updateStats(true, 'hf-api');
    
    // Show success
    await updateBadge('✓', '#00AA00');
    await notify(
      '✓ Image Renamed',
      `${basename}\n(${caption})`
    );
    
    return finalName;
    
  } catch (error) {
    console.error('[Smart Rename] Error:', error);
    
    // Save to history
    await addToHistory({
      success: false,
      error: error.message,
      filename: downloadItem.filename,
      source: url ? new URL(url).hostname : 'unknown'
    });
    
    // Update stats
    await updateStats(false, 'error');
    
    // Show error
    await updateBadge('✗', '#CC0000');
    await notify(
      '⚠ Rename Failed',
      error.message,
      false
    );
    
    return null;
  }
}

// Event: Download starting
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  // Only process images
  if (!isImage(downloadItem)) {
    suggest();
    return false;
  }
  
  console.log('[Smart Rename] Image download detected:', downloadItem.filename);
  
  // Process asynchronously
  (async () => {
    try {
      const newName = await renameImage(downloadItem);
      
      if (newName) {
        suggest({ filename: newName, conflictAction: 'uniquify' });
      } else {
        suggest(); // Keep original
      }
    } catch (error) {
      console.error('[Smart Rename] Fatal error:', error);
      suggest(); // Keep original
    }
  })();
  
  return true; // Async suggest
});

// Event: Extension installed
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Smart Rename] Extension installed');
  
  // Show welcome
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon48.png',
    title: '🎉 Smart Image Renamer Installed!',
    message: 'Click the extension icon to get your FREE Hugging Face API token and start renaming images!',
    requireInteraction: true,
    priority: 2
  });
});

// Handle notification clicks
chrome.notifications.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

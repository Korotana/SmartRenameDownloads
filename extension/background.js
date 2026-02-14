/**
 * Background Service Worker
 * Handles image + PDF downloads and AI renaming
 */

import { CONFIG } from './config.js';
import {
  captionImage,
  captionToFilename,
  prepareImageForAPI,
  nameFromText
} from './hf-api.js';
import { extractPdfPreviewText } from './pdf-extract.js';

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
    } catch {
      return '';
    }
  })();

  return !!(CONFIG.IMAGE_TYPES[extFromName] || CONFIG.IMAGE_TYPES[extFromUrl]);
}

// Helper: Check if PDF
function isPdf(downloadItem) {
  const filename = (downloadItem.filename || '').toLowerCase();
  const url = (downloadItem.finalUrl || downloadItem.url || '').toLowerCase();

  const extFromName = filename.split('.').pop();
  const extFromUrl = (() => {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').pop() || '';
      return last.includes('.') ? last.split('.').pop() : '';
    } catch {
      return '';
    }
  })();

  if (extFromName === 'pdf' || extFromUrl === 'pdf') return true;

  const mime = (downloadItem.mime || '').toLowerCase();
  return mime === 'application/pdf';
}

// Helper: Get extension (images)
function getImageExtension(downloadItem) {
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

// Helper: Fetch file as ArrayBuffer
async function fetchFile(url, maxSize) {
  try {
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > maxSize) {
      throw new Error(`File too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB (limit ${(maxSize / 1024 / 1024).toFixed(0)}MB)`);
    }

    return buffer;
  } catch (error) {
    console.error('File fetch error:', error);
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
    title,
    message,
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
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  }
}

/* ------------------------------ IMAGE FLOW ------------------------------ */

async function renameImage(downloadItem) {
  const settings = await getSettings();
  const url = downloadItem.finalUrl || downloadItem.url;
  const ext = getImageExtension(downloadItem);

  console.log('[Smart Rename] Processing image:', downloadItem.filename);

  try {
    if (!settings.hfToken) {
      throw new Error('API token not configured. Click extension icon to set up.');
    }

    checkRateLimit();
    await updateBadge('...', '#0066CC');

    // Fetch image
    console.log('[Smart Rename] Fetching image...');
    const imageBuffer = await fetchFile(url, settings.maxImageSize);

    // Check minimum size
    if (settings.skipSmallImages && imageBuffer.byteLength < settings.minImageSize) {
      console.log('[Smart Rename] Image too small, skipping');
      return null;
    }

    // Prepare for API (resize, optimize)
    console.log('[Smart Rename] Preparing image...');
    const imageBase64 = await prepareImageForAPI(imageBuffer);

    // Call AI
    console.log('[Smart Rename] Calling AI (image)...');
    const caption = await captionImage(imageBase64, settings);
    console.log('[Smart Rename] Caption:', caption);

    // Convert to filename
    const basename = captionToFilename(caption, settings);
    const finalName = `${basename}.${ext}`;

    // Save to history
    await addToHistory({
      success: true,
      original: downloadItem.filename,
      renamed: finalName,
      caption,
      fileType: 'image',
      source: safeHostname(url)
    });

    await updateStats(true, 'hf-api-image');

    await updateBadge('✓', '#00AA00');
    await notify('✓ Image Renamed', `${basename}\n(${caption})`);

    return finalName;
  } catch (error) {
    console.error('[Smart Rename] Image error:', error);

    await addToHistory({
      success: false,
      error: error.message,
      filename: downloadItem.filename,
      fileType: 'image',
      source: safeHostname(url)
    });

    await updateStats(false, 'error');

    await updateBadge('✗', '#CC0000');
    await notify('⚠ Rename Failed', error.message, false);

    return null;
  }
}

/* ------------------------------- PDF FLOW ------------------------------ */

async function renamePdf(downloadItem) {
  const settings = await getSettings();
  const url = downloadItem.finalUrl || downloadItem.url;

  console.log('[Smart Rename] Processing PDF:', downloadItem.filename);

  try {
    if (!settings.enablePdfRenaming) return null;

    if (!settings.hfToken) {
      throw new Error('API token not configured. Click extension icon to set up.');
    }

    checkRateLimit();
    await updateBadge('PDF', '#6A1B9A');

    // Fetch PDF (respect 5MB limit)
    console.log('[Smart Rename] Fetching PDF...');
    const pdfBuffer = await fetchFile(url, settings.maxImageSize);

    // Extract text locally (no PDF upload)
    console.log('[Smart Rename] Extracting PDF text (local)...');
    const { title, excerpt } = await extractPdfPreviewText(pdfBuffer, {
      maxChars: settings.pdfMaxChars,
      maxStreams: settings.pdfMaxStreams
    });

    const originalBase = stripExtension(downloadItem.filename || 'document');

    const prompt = buildPdfPrompt({
      title,
      excerpt,
      originalFilename: originalBase,
      maxWords: settings.maxWords || 5
    });

    console.log('[Smart Rename] Calling AI (text, PDF)...');
    const suggestion = await nameFromText(prompt, settings);

    const basename = captionToFilename(suggestion, settings);
    const finalName = `${basename}.pdf`;

    await addToHistory({
      success: true,
      original: downloadItem.filename,
      renamed: finalName,
      caption: suggestion,
      fileType: 'pdf',
      pdfTitle: title,
      source: safeHostname(url)
    });

    await updateStats(true, 'hf-api-pdf');

    await updateBadge('✓', '#00AA00');
    await notify('✓ PDF Renamed', `${basename}\n(${title || 'PDF'})`);

    return finalName;
  } catch (error) {
    console.error('[Smart Rename] PDF error:', error);

    await addToHistory({
      success: false,
      error: error.message,
      filename: downloadItem.filename,
      fileType: 'pdf',
      source: safeHostname(url)
    });

    await updateStats(false, 'error');

    await updateBadge('✗', '#CC0000');
    await notify('⚠ Rename Failed', error.message, false);

    return null;
  }
}

function buildPdfPrompt({ title, excerpt, originalFilename, maxWords }) {
  const safeTitle = (title || '').slice(0, 200);
  const safeExcerpt = (excerpt || '').slice(0, 2500);

  return `
Create a short, descriptive filename for a PDF.
Rules:
- Output ONLY the filename words (no extension, no quotes, no extra text).
- ${maxWords - 1} to ${maxWords + 2} words is OK; keep it short.
- Prefer document title, topic, company name, invoice/reference numbers, and dates if present.
- Avoid generic words like "document", "file", "scan" unless nothing else exists.
- Use plain English words. No emojis.

Original filename (hint): ${originalFilename}

Title (if available): ${safeTitle}

Extracted text excerpt (from the beginning): ${safeExcerpt}
`.trim();
}

function stripExtension(name) {
  const base = name.split(/[\\/]/).pop() || name;
  return base.replace(/\.[^.]+$/, '');
}

function safeHostname(url) {
  try {
    return url ? new URL(url).hostname : 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ------------------------------ EVENT HOOK ----------------------------- */

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const handle = isImage(downloadItem) ? 'image' : isPdf(downloadItem) ? 'pdf' : 'other';

  if (handle === 'other') {
    suggest();
    return false;
  }

  console.log(`[Smart Rename] ${handle.toUpperCase()} download detected:`, downloadItem.filename);

  (async () => {
    try {
      const newName = handle === 'image'
        ? await renameImage(downloadItem)
        : await renamePdf(downloadItem);

      if (newName) {
        suggest({ filename: newName, conflictAction: 'uniquify' });
      } else {
        suggest();
      }
    } catch (error) {
      console.error('[Smart Rename] Fatal error:', error);
      suggest();
    }
  })();

  return true; // Async suggest
});

// Event: Extension installed
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Smart Rename] Extension installed');

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon48.png',
    title: '🎉 Smart Renamer Installed!',
    message: 'Click the extension icon to add your Hugging Face token. Then download an image or PDF to see smart renaming.',
    requireInteraction: true,
    priority: 2
  });
});

// Handle notification clicks
chrome.notifications.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/**
 * Options Page Logic
 */

import { CONFIG } from './config.js';
import { testConnection } from './hf-api.js';

// Elements
const elements = {
  hfToken: document.getElementById('hfToken'),
  model: document.getElementById('model'),
  cleanCaptions: document.getElementById('cleanCaptions'),
  addDateSuffix: document.getElementById('addDateSuffix'),
  skipSmallImages: document.getElementById('skipSmallImages'),
  maxWords: document.getElementById('maxWords'),
  enableNotifications: document.getElementById('enableNotifications'),
  saveBtn: document.getElementById('saveBtn'),
  testBtn: document.getElementById('testBtn'),
  saveStatus: document.getElementById('saveStatus'),
  testResult: document.getElementById('testResult')
};

// Populate model dropdown from CONFIG.MODELS
function populateModelDropdown() {
  elements.model.innerHTML = '';
  for (const [label, modelId] of Object.entries(CONFIG.MODELS)) {
    const option = document.createElement('option');
    option.value = modelId;
    option.textContent = label;
    elements.model.appendChild(option);
  }
}

// Load settings
async function loadSettings() {
  const data = await chrome.storage.sync.get(CONFIG.STORAGE.SETTINGS);
  const settings = { ...CONFIG.DEFAULTS, ...(data[CONFIG.STORAGE.SETTINGS] || {}) };
  
  elements.hfToken.value = settings.hfToken;
  elements.model.value = settings.model;
  elements.cleanCaptions.checked = settings.cleanCaptions;
  elements.addDateSuffix.checked = settings.addDateSuffix;
  elements.skipSmallImages.checked = settings.skipSmallImages;
  elements.maxWords.value = settings.maxWords;
  elements.enableNotifications.checked = settings.enableNotifications;
}

// Save settings
async function saveSettings() {
  const settings = {
    hfToken: elements.hfToken.value.trim(),
    model: elements.model.value,
    cleanCaptions: elements.cleanCaptions.checked,
    addDateSuffix: elements.addDateSuffix.checked,
    skipSmallImages: elements.skipSmallImages.checked,
    maxWords: parseInt(elements.maxWords.value),
    enableNotifications: elements.enableNotifications.checked,
    maxImageSize: CONFIG.DEFAULTS.maxImageSize,
    minImageSize: CONFIG.DEFAULTS.minImageSize,
    debug: CONFIG.DEFAULTS.debug
  };
  
  await chrome.storage.sync.set({ [CONFIG.STORAGE.SETTINGS]: settings });
  
  // Show save confirmation
  elements.saveStatus.classList.add('show');
  setTimeout(() => {
    elements.saveStatus.classList.remove('show');
  }, 2000);
}

// Test API connection
async function testAPI() {
  const token = elements.hfToken.value.trim();
  const model = elements.model.value;
  
  if (!token) {
    showTestResult(false, 'Please enter your API token first');
    return;
  }
  
  elements.testBtn.disabled = true;
  elements.testBtn.textContent = 'Testing...';
  elements.testResult.style.display = 'none';
  
  try {
    const result = await testConnection(token, model);
    
    if (result.success) {
      showTestResult(true, result.message);
    } else {
      showTestResult(false, result.message);
    }
  } catch (error) {
    showTestResult(false, error.message);
  } finally {
    elements.testBtn.disabled = false;
    elements.testBtn.textContent = 'Test Connection';
  }
}

// Show test result
function showTestResult(success, message) {
  elements.testResult.className = `test-result ${success ? 'success' : 'error'}`;
  elements.testResult.textContent = message;
  elements.testResult.style.display = 'block';
}

// Event listeners
elements.saveBtn.addEventListener('click', saveSettings);
elements.testBtn.addEventListener('click', testAPI);

// Load on start
populateModelDropdown();
loadSettings();

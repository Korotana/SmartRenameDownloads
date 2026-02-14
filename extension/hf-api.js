/**
 * Hugging Face Inference Providers API Service
 * Image captioning for renaming via OpenAI-compatible Chat Completions.
 */

import { CONFIG } from './config.js';

/**
 * Call Hugging Face (router) to caption an image using a VLM.
 * Uses OpenAI-compatible Chat Completions: https://router.huggingface.co/v1/chat/completions
 */
export async function captionImage(imageBase64, settings) {
  const model = settings.model || CONFIG.DEFAULT_MODEL;
  const token = settings.hfToken;

  if (!token) {
    throw new Error('Hugging Face API token not configured. Create one at huggingface.co/settings/tokens (enable “Inference Providers”).');
  }

  const url = CONFIG.HF_CHAT_COMPLETIONS_URL;

  // Keep the prompt short; we clean/slugify later.
  const prompt = 'Describe the main subject in 3 to 6 words. No punctuation. Do not start with a, an, or the.';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageBase64 } }
            ]
          }
        ],
        max_tokens: 64,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));

      // Helpful messages for common failures
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid API token or missing permissions. Re-create your token with “Inference Providers” enabled.');
      }
      if (response.status === 402) {
        throw new Error('No billing/credits available for the selected provider. Try another model/provider or set up billing on Hugging Face.');
      }
      if (response.status === 429) {
        throw new Error('Rate limit reached. Please wait a moment and try again.');
      }
      if (response.status === 404) {
        throw new Error('Model/provider not found. Pick a different model in Settings (it must be deployed by an Inference Provider).');
      }

      const msg = (error && (error.error || error.message)) ? (error.error || error.message) : 'Unknown error';
      throw new Error(`API error ${response.status}: ${msg}`);
    }

    const result = await response.json();
    const caption = result?.choices?.[0]?.message?.content;
    if (!caption || typeof caption !== 'string') {
      throw new Error('Unexpected API response format');
    }

    return caption.trim();
  } catch (error) {
    console.error('HF API Error:', error);
    throw error;
  }
}

/**
 * Convert caption to clean filename
 */
export function captionToFilename(caption, settings) {
  let filename = caption.toLowerCase();
  
  // Remove common articles if enabled
  if (settings.cleanCaptions) {
    filename = filename.replace(/^(a|an|the)\s+/gi, '');
  }
  
  // Remove extra words (prepositions, etc)
  filename = filename
    .replace(/\s+(on|in|at|with|by|of)\s+/gi, ' ')
    .replace(/\s+(the)\s+/gi, ' ');
  
  // Convert to kebab-case
  filename = filename
    .replace(/[^a-z0-9\s-]/g, '')      // Remove special chars
    .replace(/\s+/g, '-')               // Spaces to hyphens
    .replace(/-+/g, '-')                // Multiple hyphens to one
    .replace(/^-|-$/g, '');             // Trim hyphens
  
  // Limit words
  if (settings.maxWords && settings.maxWords > 0) {
    const words = filename.split('-');
    if (words.length > settings.maxWords) {
      filename = words.slice(0, settings.maxWords).join('-');
    }
  }
  
  // Limit length
  if (filename.length > 60) {
    filename = filename.slice(0, 60).replace(/-+$/, '');
  }
  
  // Ensure we have something
  if (!filename || filename.length < 2) {
    filename = 'image';
  }
  
  // Add date suffix if enabled
  if (settings.addDateSuffix) {
    const date = new Date().toISOString().split('T')[0];
    filename = `${filename}-${date}`;
  }
  
  return filename;
}

/**
 * Resize/optimize image for API
 * Works in service worker context
 */
export async function prepareImageForAPI(imageBuffer, maxSize = 800) {
  try {
    // Use createImageBitmap which works in service workers
    const blob = new Blob([imageBuffer]);
    const imageBitmap = await createImageBitmap(blob);
    
    // Calculate new dimensions
    let width = imageBitmap.width;
    let height = imageBitmap.height;
    
    if (width > maxSize || height > maxSize) {
      if (width > height) {
        height = (height / width) * maxSize;
        width = maxSize;
      } else {
        width = (width / height) * maxSize;
        height = maxSize;
      }
    }
    
    // Create canvas and resize
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, width, height);
    
    // Convert to JPEG blob then base64
    const resizedBlob = await canvas.convertToBlob({ 
      type: 'image/jpeg', 
      quality: 0.8 
    });
    
    const resizedBuffer = await resizedBlob.arrayBuffer();
    const base64 = arrayBufferToBase64(resizedBuffer);
    
    // Clean up
    imageBitmap.close();
    
    return `data:image/jpeg;base64,${base64}`;
    
  } catch (error) {
    console.error('Image preparation error:', error);
    // Fallback: just convert to base64 without resizing
    const base64 = arrayBufferToBase64(imageBuffer);
    return `data:image/jpeg;base64,${base64}`;
  }
}

/**
 * Convert ArrayBuffer to base64
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  
  return btoa(binary);
}

/**
 * Test API connection and token
 */
export async function testConnection(token, model) {
  try {
    // Create a tiny test image (1x1 pixel)
    const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

    const response = await fetch(CONFIG.HF_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Say OK.' },
              { type: 'image_url', image_url: { url: testImage } }
            ]
          }
        ],
        max_tokens: 8,
        temperature: 0
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid API token or missing permissions. Re-create token with “Inference Providers” enabled.');
      }

      if (response.status === 402) {
        throw new Error('Token works, but no billing/credits available for this provider. Try another model/provider or set up billing.');
      }

      if (response.status === 404) {
        throw new Error('Model/provider not found. Pick a different model in Settings (must be deployed).');
      }

      const msg = (error && (error.error || error.message)) ? (error.error || error.message) : `API error ${response.status}`;
      throw new Error(msg);
    }
    
    return {
      success: true,
      message: 'Connection successful! Your API token + Inference Providers access is working.'
    };
    
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
}

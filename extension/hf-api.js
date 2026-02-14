/**
 * Hugging Face API Integration
 * Uses Inference Providers (OpenAI-compatible Chat Completions)
 */

import { CONFIG } from './config.js';

// Helpers: sanitize / parse
function extractTextContent(data) {
  return data?.choices?.[0]?.message?.content || '';
}

async function callChatCompletions({ token, model, messages, temperature = 0.2, maxTokens = 60 }) {
  const response = await fetch(CONFIG.HF_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }

  return extractTextContent(data).trim();
}

// Caption an image using vision-language model
export async function captionImage(imageBase64, settings) {
  const { hfToken, model } = settings;

  // VLM prompt
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Describe this image in 5-10 words. Focus on main subject, colors, action, setting. No punctuation.`
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${imageBase64}`
          }
        }
      ]
    }
  ];

  return await callChatCompletions({
    token: hfToken,
    model,
    messages,
    temperature: 0.2,
    maxTokens: 40
  });
}

/**
 * Generate a filename candidate from TEXT only (no file upload).
 * Used for PDFs: we extract title + an excerpt locally, then ask the model for a short filename phrase.
 */
export async function nameFromText(textPrompt, settings) {
  const { hfToken, model } = settings;

  const messages = [
    {
      role: 'system',
      content:
        'You are a smart filename generator. Return a short, clear filename that is easy for humans to understand as if a smart human named the file. Output ONLY the words for the filename (no extension, no quotes, no extra text).'
    },
    { role: 'user', content: textPrompt }
  ];

  return await callChatCompletions({
    token: hfToken,
    model,
    messages,
    temperature: 0.2,
    maxTokens: 60
  });
}

// Convert caption/text to clean filename
export function captionToFilename(caption, settings) {
  let text = (caption || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();

  // Remove articles if enabled
  if (settings.cleanCaptions) {
    text = text.replace(/\b(a|an|the)\b/g, '').replace(/\s+/g, ' ').trim();
  }

  // Limit words
  const words = text.split(' ').filter((w) => w.length > 0);
  const limited = words.slice(0, settings.maxWords || 5).join('-');

  // Add date if enabled
  if (settings.addDateSuffix) {
    const date = new Date().toISOString().split('T')[0];
    return `${limited}-${date}`;
  }

  return limited || 'download';
}

// Prepare image for API (resize if needed)
export async function prepareImageForAPI(imageBuffer) {
  // Convert to blob
  const blob = new Blob([imageBuffer]);

  // Create image bitmap
  const bitmap = await createImageBitmap(blob);

  // Resize if too large
  const maxDim = 1024;
  let { width, height } = bitmap;

  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  // Draw to canvas
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Convert to JPEG blob
  const resizedBlob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: 0.85
  });

  // Convert to base64
  const arrayBuffer = await resizedBlob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);

  return base64;
}

// Test connection
export async function testConnection(token, model) {
  try {
    const text = await callChatCompletions({
      token,
      model,
      messages: [{ role: 'user', content: 'Say OK if you can read this.' }],
      temperature: 0,
      maxTokens: 5
    });

    const ok = text.toUpperCase().includes('OK');

    return {
      success: ok,
      message: ok
        ? '✓ Connection successful! Ready to rename.'
        : 'Connection worked, but unexpected response. Try a different model.'
    };
  } catch (error) {
    return {
      success: false,
      message: error.message
    };
  }
}

// Helper: ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

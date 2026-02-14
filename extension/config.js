/**
 * Configuration for Smart Download Renamer
 * Uses Hugging Face Inference Providers (OpenAI-compatible Chat Completions)
 */

export const CONFIG = {
  // IMPORTANT:
  // The older BLIP captioning models are NOT deployed on Hugging Face "Inference Providers",
  // which causes a 404 when called through router.huggingface.co.
  // So we use Vision-Language Models via the OpenAI-compatible Chat Completions endpoint.
  // Model IDs include a provider suffix ("<model>:<provider>").
  MODELS: {
    'Qwen3-VL 8B (Novita) — fast/cheap': 'Qwen/Qwen3-VL-8B-Instruct:fastest',
    'GLM-4.5V (Novita) — strong vision': 'zai-org/GLM-4.5V:novita',
    'Aya Vision 32B (Cohere) — best quality': 'CohereLabs/aya-vision-32b:cohere'
  },

  DEFAULT_MODEL: 'Qwen/Qwen3-VL-8B-Instruct:fastest',

  // OpenAI-compatible endpoint for Hugging Face Inference Providers
  HF_CHAT_COMPLETIONS_URL: 'https://router.huggingface.co/v1/chat/completions',

  // Storage keys
  STORAGE: {
    SETTINGS: 'image_rename_settings_v1', // keep existing key for seamless upgrades
    HISTORY: 'image_rename_history_v1',
    STATS: 'image_rename_stats_v1'
  },

  // Default settings
  DEFAULTS: {
    hfToken: '',                    // User's HF token (free to get)
    model: 'Qwen/Qwen3-VL-8B-Instruct:fastest',

    // Limits
    maxImageSize: 5 * 1024 * 1024,  // 5MB max (images + PDFs)
    minImageSize: 50 * 1024,        // Skip images < 50KB (icons, etc)

    // Image options
    skipSmallImages: false,
    cleanCaptions: true,            // Remove articles (a, an, the)
    addDateSuffix: false,           // Add date to filename
    maxWords: 5,                    // Max words in filename

    // PDF options (text-only: we extract locally; only extracted text is sent)
    enablePdfRenaming: true,
    pdfMaxChars: 2500,              // Max extracted chars to send to AI
    pdfMaxStreams: 12,              // Approx "first few pages" (content streams)

    // UX
    enableNotifications: true,
    debug: false
  },

  // Supported image types
  IMAGE_TYPES: {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
    'gif': 'image/gif'
  },

  // Supported document types
  DOC_TYPES: {
    'pdf': 'application/pdf'
  },

  // Rate limiting (Hugging Face free tier)
  RATE_LIMIT: {
    maxPerMinute: 30,      // Conservative limit
    retryDelay: 2000,      // 2 seconds
    maxRetries: 3
  }
};

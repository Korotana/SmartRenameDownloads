/**
 * PDF text extraction (heuristic, no external libraries).
 *
 * Goal: extract enough text from the *beginning* of a PDF to generate a smart filename
 * without uploading the full PDF anywhere.
 *
 * Notes:
 * - Works best for text-based PDFs.
 * - Scanned/image-only PDFs may yield little/no text.
 * - Uses built-in DecompressionStream for FlateDecode streams when available.
 */

const latin1Decoder = new TextDecoder('latin1');

export async function extractPdfPreviewText(pdfArrayBuffer, opts = {}) {
  const maxChars = clampInt(opts.maxChars ?? 2500, 200, 12000);
  const maxStreams = clampInt(opts.maxStreams ?? 12, 1, 100);

  const bytes = new Uint8Array(pdfArrayBuffer);
  const latin = latin1Decoder.decode(bytes);

  const title =
    cleanupText(extractXmpTitle(latin) || extractInfoTitle(latin) || '').slice(0, 200);

  const excerpt = (await extractTextFromEarlyStreams(bytes, latin, { maxChars, maxStreams }))
    .slice(0, maxChars);

  return {
    title,
    excerpt: cleanupText(excerpt)
  };
}

/* ------------------------------ extraction ------------------------------ */

function extractInfoTitle(pdfLatin) {
  // Very common: /Title (Some Title)
  const m = pdfLatin.match(/\/Title\s*\(([^)]{1,300})\)/);
  if (!m) return '';
  return decodePdfLiteralString(m[1]);
}

function extractXmpTitle(pdfLatin) {
  // XMP metadata is XML, often in a metadata stream. We search the full file for dc:title.
  const start = pdfLatin.indexOf('<dc:title');
  if (start === -1) return '';
  const end = pdfLatin.indexOf('</dc:title>', start);
  if (end === -1) return '';

  const snippet = pdfLatin.slice(start, end + '</dc:title>'.length);

  // Prefer rdf:li content if present
  const li = snippet.match(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i);
  const raw = li ? li[1] : snippet;

  return decodeHtmlEntities(stripXmlTags(raw)).trim();
}

async function extractTextFromEarlyStreams(bytes, pdfLatin, { maxChars, maxStreams }) {
  // Find "stream" blocks and extract literal strings from the first N streams.
  // This approximates "first few pages" because page content streams are generally early/ordered.
  const out = [];
  let total = 0;

  const streamRe = /stream\r?\n/g;
  let match;
  let streamsSeen = 0;

  while ((match = streamRe.exec(pdfLatin)) && streamsSeen < maxStreams && total < maxChars) {
    const streamKeywordIdx = match.index;
    const dataStart = match.index + match[0].length;
    const endstreamIdx = pdfLatin.indexOf('endstream', dataStart);
    if (endstreamIdx === -1) break;

    // Determine filter(s) by looking at the nearby dictionary before 'stream'
    const dictStart = Math.max(0, streamKeywordIdx - 2500);
    const dictChunk = pdfLatin.slice(dictStart, streamKeywordIdx);
    const isFlate = dictChunk.includes('/FlateDecode');

    // Slice bytes (latin1 indices align with bytes 1:1)
    const rawStreamBytes = bytes.slice(dataStart, endstreamIdx);

    let decodedBytes = rawStreamBytes;
    if (isFlate) {
      const inflated = await inflateFlate(rawStreamBytes);
      if (inflated && inflated.length) decodedBytes = inflated;
      else {
        streamsSeen++;
        continue;
      }
    }

    const streamText = latin1Decoder.decode(decodedBytes);

    // Heuristic: pull literal strings ( ... ) which frequently hold visible text.
    const strings = extractLiteralStrings(streamText);

    if (strings.length) {
      const joined = strings.join(' ');
      if (joined.length > 30) {
        out.push(joined);
        total += joined.length + 1;
      }
    }

    streamsSeen++;
  }

  return out.join(' ');
}

/* ------------------------------ utilities ------------------------------ */

async function inflateFlate(u8) {
  // FlateDecode is (usually) zlib-wrapped DEFLATE. DecompressionStream('deflate') supports it in modern Chrome.
  try {
    if (typeof DecompressionStream === 'undefined') return null;

    const ds = new DecompressionStream('deflate');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return null;
  }
}

function extractLiteralStrings(streamText) {
  const results = [];

  // Limit how much we scan per stream (perf)
  const slice = streamText.slice(0, 400_000);

  // ( ... ) strings
  const re = /\((?:\\.|[^\\()]){3,400}\)/g;
  let m;
  while ((m = re.exec(slice))) {
    const raw = m[0].slice(1, -1);
    const decoded = cleanupText(decodePdfLiteralString(raw));
    if (isUsefulText(decoded)) results.push(decoded);
    if (results.join(' ').length > 3500) break;
  }

  // <...> hex strings (sometimes used for text). Decode small-ish ones.
  const hexRe = /<([0-9A-Fa-f]{8,800})>/g;
  while ((m = hexRe.exec(slice))) {
    const hex = m[1];
    const decoded = cleanupText(decodePdfHexString(hex));
    if (isUsefulText(decoded)) results.push(decoded);
    if (results.join(' ').length > 3500) break;
  }

  return results;
}

function decodePdfLiteralString(s) {
  // Handles common PDF escape sequences + octal escapes.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }

    // escape
    const next = s[i + 1];
    if (next === undefined) break;

    switch (next) {
      case 'n': out += '\n'; i++; break;
      case 'r': out += '\r'; i++; break;
      case 't': out += '\t'; i++; break;
      case 'b': out += '\b'; i++; break;
      case 'f': out += '\f'; i++; break;
      case '\\': out += '\\'; i++; break;
      case '(': out += '('; i++; break;
      case ')': out += ')'; i++; break;
      case '\n': // line continuation
      case '\r':
        i++;
        // swallow \r\n too
        if (next === '\r' && s[i + 1] === '\n') i++;
        break;
      default: {
        // octal \ddd
        if (isOctalDigit(next)) {
          let oct = next;
          if (isOctalDigit(s[i + 2])) oct += s[i + 2];
          if (isOctalDigit(s[i + 3])) oct += s[i + 3];
          out += String.fromCharCode(parseInt(oct, 8));
          i += oct.length;
        } else {
          out += next;
          i++;
        }
      }
    }
  }
  return out;
}

function decodePdfHexString(hex) {
  // Hex string pairs -> bytes -> try UTF-8 first, else latin1
  if (hex.length % 2 === 1) hex += '0';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }

  // UTF-16BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.slice(2));
    } catch {}
  }
  // UTF-8
  try {
    const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (txt && /[A-Za-z0-9]/.test(txt)) return txt;
  } catch {}

  return latin1Decoder.decode(bytes);
}

function cleanupText(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F]+/g, ' ')
    .trim();
}

function isUsefulText(s) {
  if (!s) return false;
  if (s.length < 6) return false;

  // Require at least some letters/digits
  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum < Math.min(6, Math.floor(s.length / 4))) return false;

  // Filter out obvious font/glyph names
  if (/^[A-Z]{1,4}\+?[A-Za-z0-9]{2,10}$/.test(s)) return false;

  return true;
}

function stripXmlTags(xml) {
  return xml.replace(/<[^>]*>/g, ' ');
}

function decodeHtmlEntities(s) {
  // Minimal decode for common entities used in XMP
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isOctalDigit(ch) {
  return ch >= '0' && ch <= '7';
}

function clampInt(n, min, max) {
  const x = Number.isFinite(n) ? Math.floor(n) : min;
  return Math.max(min, Math.min(max, x));
}

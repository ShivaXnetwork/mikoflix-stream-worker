// ═══════════════════════════════════════════════════════════════════════════
// CLOUDFLARE WORKER: MIKOFLIX SECURE STREAM PROXY v4.0 (Hardened AES-256-GCM)
// ═══════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const DEFAULT_KEY_HEX = '80a0642f5a293562ab38200bb185a35d5fa92d19f8a7de5067b18a82ef4e1ec9';
const ALT_KEY_HEX     = 'a3f1c9e7b2d84a6f0c5e9b3d7a1f4c8e6b0d2a9f5c3e7b1d4a8f0c6e2b9d3a7f';

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(atob(b64)));
}

async function decryptWithKey(combined, nonce, keyBytes) {
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
    );
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce }, cryptoKey, combined
    );
    const obj = JSON.parse(new TextDecoder().decode(dec));
    return {
      url: obj.u || obj.url,
      referer: obj.r || obj.referer || '',
      exp: obj.exp || 0
    };
  } catch (_) {
    return null;
  }
}

async function decryptToken(token, rawKeyBytes) {
  if (!token) return null;
  try {
    const raw = base64UrlDecode(token);
    const parts = raw.split('.');
    if (parts.length === 3) {
      const nonce = hexToBytes(parts[0]);
      const tag = hexToBytes(parts[1]);
      const ct = hexToBytes(parts[2]);
      const combined = new Uint8Array(ct.length + tag.length);
      combined.set(ct);
      combined.set(tag, ct.length);

      let res = await decryptWithKey(combined, nonce, rawKeyBytes);
      if (!res) {
        res = await decryptWithKey(combined, nonce, hexToBytes(ALT_KEY_HEX));
      }
      return res;
    }
    const plain = JSON.parse(raw);
    return { url: plain.u || plain.url, referer: plain.r || plain.referer || '', exp: plain.exp || 0 };
  } catch (_) {
    return null;
  }
}

async function encryptToken(payload, rawKeyBytes) {
  const jsonStr = JSON.stringify(payload);
  const plaintext = new TextEncoder().encode(jsonStr);
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    'raw', rawKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cryptoKey, plaintext
  );

  const encBytes = new Uint8Array(encrypted);
  const ct = encBytes.slice(0, encBytes.length - 16);
  const tag = encBytes.slice(encBytes.length - 16);

  const combinedStr = `${bytesToHex(nonce)}.${bytesToHex(tag)}.${bytesToHex(ct)}`;
  return base64UrlEncode(combinedStr);
}

function getCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function rewriteM3u8Content(text, baseUrl, referer, workerOrigin, rawKeyBytes) {
  const base = new URL(baseUrl);
  const lines = text.split('\n');
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }

    if (trimmed.startsWith('#')) {
      const match = line.match(/URI="([^"]+)"/);
      if (match) {
        try {
          const abs = new URL(match[1], base).href;
          const clean = abs.split('?')[0].toLowerCase();
          const token = await encryptToken({ u: abs, r: referer, t: Date.now() }, rawKeyBytes);
          let ext = '.m3u8';
          if (trimmed.startsWith('#EXT-X-KEY') || clean.endsWith('.key')) {
            ext = '.key';
          } else if (trimmed.startsWith('#EXT-X-MAP') || clean.endsWith('.mp4') || clean.endsWith('.m4s')) {
            ext = '.mp4';
          }
          out.push(line.replace(match[1], `${workerOrigin}/p/${token}${ext}`));
          continue;
        } catch (_) {}
      }
      out.push(line);
      continue;
    }

    try {
      const absUrl = new URL(trimmed, base).href;
      const clean = absUrl.split('?')[0].toLowerCase();
      const isSub = clean.includes('/hls/') || clean.endsWith('.m3u8') || clean.includes('playlist') || clean.includes('master');
      const ext = isSub ? '.m3u8' : (clean.endsWith('.mp4') || clean.endsWith('.m4s') ? '.mp4' : (clean.endsWith('.woff') ? '.woff' : '.ts'));
      const token = await encryptToken({ u: absUrl, r: referer, t: Date.now() }, rawKeyBytes);
      out.push(`${workerOrigin}/p/${token}${ext}`);
    } catch (_) {
      out.push(line);
    }
  }
  return out.join('\n');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    const corsHeaders = getCorsHeaders(origin);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const keyHex = env?.LINK_CRYPTO_KEY || DEFAULT_KEY_HEX;
    const rawKeyBytes = hexToBytes(keyHex);

    // 1. Scraper endpoint (Blocked on Stream Worker)
    if (pathname === '/scrape') {
      return new Response("400 Bad Request: Dedicated Stream Worker does not handle scraping. Route to dedicated proxy-worker.", {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "text/plain" }
      });
    }

    // 2. Identify targetUrl & targetReferer (via Encrypted Token or Query fallback)
    let targetUrl = '';
    let targetReferer = '';

    // Check /p/<token> or /proxy/<token>
    if (pathname.startsWith('/p/') || pathname.startsWith('/proxy/')) {
      const prefix = pathname.startsWith('/p/') ? '/p/' : '/proxy/';
      const rawToken = pathname.replace(prefix, '').replace(/\.[a-z0-9]+$/i, '');
      const dec = await decryptToken(rawToken, rawKeyBytes);
      if (dec && dec.url) {
        targetUrl = dec.url;
        targetReferer = dec.referer || '';
      }
    }

    // Check ?d=<token> or ?token=<token>
    if (!targetUrl) {
      const encParam = url.searchParams.get('d') || url.searchParams.get('token');
      if (encParam) {
        const dec = await decryptToken(encParam, rawKeyBytes);
        if (dec && dec.url) {
          targetUrl = dec.url;
          targetReferer = dec.referer || '';
        }
      }
    }

    // Fallback: plaintext query param ?url=...
    if (!targetUrl) {
      targetUrl = url.searchParams.get('url') || '';
      targetReferer = url.searchParams.get('referer') || '';
    }

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ status: 'active', service: 'Mikoflix AES Stream Shield', version: '4.0' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Server': 'Mikoflix-Shield' } }
      );
    }

    // SSRF Protection
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.|^10\.|^192\.168\./i.test(targetUrl)) {
      return new Response('403 Forbidden: Private address target blocked.', {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      });
    }

    // Smart Referer detection
    let targetOrigin = '';
    try {
      if (targetUrl.includes('as-cdn') || targetUrl.includes('animesky')) {
        targetOrigin = '';
        if (!targetReferer || targetReferer.includes('mikoflix')) {
          try {
            targetReferer = new URL(targetUrl).origin + '/';
          } catch (_) {
            targetReferer = 'https://as-cdn26.top/';
          }
        }
      } else if (targetUrl.includes('zephyrix') || targetUrl.includes('zn-grid')) {
        targetReferer = 'https://play.zephyrix.org/';
        targetOrigin = 'https://play.zephyrix.org';
      } else if (targetUrl.includes('megaplay') || targetUrl.includes('norami') || targetUrl.includes('tiktokcdn') || /megap[^/]*\.(site|top|buzz)/i.test(targetUrl)) {
        targetReferer = 'https://megaplay.buzz/';
        targetOrigin = 'https://megaplay.buzz';
      } else if (targetReferer && targetReferer.startsWith('http')) {
        targetOrigin = new URL(targetReferer).origin;
      } else if (targetUrl.startsWith('http')) {
        targetOrigin = new URL(targetUrl).origin;
        if (!targetReferer) targetReferer = targetOrigin + '/';
      }
    } catch (_) {}

    try {
      const upstreamHeaders = {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        // Full browser-client header set
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="127", "Google Chrome";v="127"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      };
      if (targetReferer) upstreamHeaders['Referer'] = targetReferer;
      if (targetOrigin) upstreamHeaders['Origin'] = targetOrigin;

      if (targetUrl.includes('as-cdn') || targetUrl.includes('animesky')) {
        // Upstream Nginx hotlink protection strictly blocks Origin headers from edge workers
        delete upstreamHeaders['Origin'];
        delete upstreamHeaders['origin'];

        // Ensure Referer matches the upstream provider host
        try {
          const parsedTarget = new URL(targetUrl);
          upstreamHeaders['Referer'] = `${parsedTarget.origin}/`;
        } catch (_) {
          upstreamHeaders['Referer'] = 'https://as-cdn26.top/';
        }

        upstreamHeaders['User-Agent'] = UA;
        upstreamHeaders['Accept'] = '*/*';
        upstreamHeaders['Accept-Language'] = 'en-US,en;q=0.9';
        upstreamHeaders['Sec-Fetch-Mode'] = 'cors';
        upstreamHeaders['Sec-Fetch-Site'] = 'cross-site';
        upstreamHeaders['Sec-Fetch-Dest'] = 'empty';
      }

      const range = request.headers.get('Range');
      if (range) upstreamHeaders['Range'] = range;

      let upstreamRes = await fetch(targetUrl, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
      });

      const responseHeaders = new Headers();
      for (const [k, v] of upstreamRes.headers.entries()) {
        const kl = k.toLowerCase();
        if (['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].includes(kl)) {
          responseHeaders.set(k, v);
        }
      }
      for (const [k, v] of Object.entries(corsHeaders)) responseHeaders.set(k, v);
      responseHeaders.set('Server', 'Mikoflix-Shield');

      const isExplicitSegment = pathname.endsWith('.ts') || pathname.endsWith('.m4s') || pathname.endsWith('.mp4') || pathname.endsWith('.key') || pathname.endsWith('.woff');

      if (isExplicitSegment) {
        if (pathname.endsWith('.ts')) {
          responseHeaders.set('Content-Type', 'video/MP2T');
        } else if (pathname.endsWith('.m4s') || pathname.endsWith('.mp4')) {
          responseHeaders.set('Content-Type', 'video/mp4');
        } else if (pathname.endsWith('.key')) {
          responseHeaders.set('Content-Type', 'application/octet-stream');
        }
        responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(upstreamRes.body, { status: upstreamRes.status, headers: responseHeaders });
      }

      const ct = upstreamRes.headers.get('content-type') || '';
      const isM3u8Url = targetUrl.split('?')[0].toLowerCase().endsWith('.m3u8') || targetUrl.includes('/hls/');

      // Check if response is M3U8 playlist
      if (upstreamRes.ok && (isM3u8Url || ct.includes('mpegurl') || ct.includes('text') || pathname.endsWith('.m3u8'))) {
        const text = await upstreamRes.text();
        if (text.startsWith('#EXTM3U') || text.includes('#EXTINF')) {
          const rewritten = await rewriteM3u8Content(text, targetUrl, targetReferer, url.origin, rawKeyBytes);
          responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          responseHeaders.delete('content-length');
          return new Response(rewritten, { status: upstreamRes.status, headers: responseHeaders });
        }
        return new Response(text, { status: upstreamRes.status, headers: responseHeaders });
      }

      return new Response(upstreamRes.body, { status: upstreamRes.status, headers: responseHeaders });
    } catch (err) {
      return new Response('502 Bad Gateway: ' + err.message, {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      });
    }
  },
};

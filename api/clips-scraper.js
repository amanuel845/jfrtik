const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// Helper to fetch text (follows redirects, decompresses)
function fetchText(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error('Too many redirects'));
      return;
    }
    
    const parsedUrl = new URL(urlStr);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
    };
    
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        res.resume();
        resolve(fetchText(redirectUrl, redirects + 1));
        return;
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`Request failed with status ${res.statusCode}`));
        return;
      }
      
      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      
      const decoder = new StringDecoder('utf-8');
      let body = '';
      stream.on('data', (chunk) => body += decoder.write(chunk));
      stream.on('end', () => {
        body += decoder.end();
        resolve(body);
      });
      stream.on('error', reject);
    });
    
    req.on('error', reject);
    req.end();
  });
}

// Extract as much data as possible from the clipssaver HTML
function extractFromHtml(html) {
  const data = {
    title: null,
    description: null,
    cover: null,
    author: {
      nickname: null,
      uniqueId: null,
      avatar: null,
    },
    stats: {},
    videoUrl: null,
    canonicalUrl: null,
    rawJson: null,
  };
  
  // 1. Try to find Next.js data (common for React-based sites)
  const nextDataRegex = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
  const nextMatch = html.match(nextDataRegex);
  if (nextMatch) {
    try {
      const json = JSON.parse(nextMatch[1]);
      data.rawJson = json;
      // Try to navigate common Next.js structure
      const pageProps = json?.props?.pageProps;
      if (pageProps) {
        const videoData = pageProps.videoData || pageProps.data || pageProps;
        if (videoData) {
          data.title = videoData.title || videoData.desc || null;
          data.description = videoData.description || videoData.desc || null;
          data.cover = videoData.cover || videoData.thumbnail || null;
          data.videoUrl = videoData.videoUrl || videoData.playAddr || videoData.url || null;
          data.author.nickname = videoData.author?.nickname || videoData.user?.nickname || null;
          data.author.uniqueId = videoData.author?.uniqueId || videoData.user?.uniqueId || null;
          data.author.avatar = videoData.author?.avatar || videoData.user?.avatar || null;
          data.stats = videoData.stats || {};
        }
      }
    } catch (e) {
      console.error('Error parsing __NEXT_DATA__:', e.message);
    }
  }
  
  // 2. Look for common meta tags (Open Graph, Twitter)
  const getMeta = (name) => {
    const regex = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    return match ? match[1] : null;
  };
  
  if (!data.title) data.title = getMeta('og:title') || getMeta('twitter:title');
  if (!data.description) data.description = getMeta('og:description') || getMeta('description');
  if (!data.cover) data.cover = getMeta('og:image') || getMeta('twitter:image');
  if (!data.canonicalUrl) {
    const canonicalRegex = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i;
    const canonicalMatch = html.match(canonicalRegex);
    if (canonicalMatch) data.canonicalUrl = canonicalMatch[1];
  }
  
  // 3. Look for JSON data in script tags (e.g., window.__INITIAL_STATE__)
  const stateRegex = /(?:window\.)?__INITIAL_STATE__\s*=\s*({[\s\S]*?});/;
  const stateMatch = html.match(stateRegex);
  if (stateMatch) {
    try {
      const json = JSON.parse(stateMatch[1]);
      if (!data.rawJson) data.rawJson = json;
      // Try to find video data within
      // (customize as needed)
    } catch (e) {}
  }
  
  // 4. Look for <video> or <source> tags
  const videoTagRegex = /<video[^>]*src=["']([^"']*)["']/i;
  const videoTagMatch = html.match(videoTagRegex);
  if (!data.videoUrl && videoTagMatch) data.videoUrl = videoTagMatch[1];
  
  const sourceTagRegex = /<source[^>]*src=["']([^"']*)["']/i;
  const sourceTagMatch = html.match(sourceTagRegex);
  if (!data.videoUrl && sourceTagMatch) data.videoUrl = sourceTagMatch[1];
  
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }
  
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const tiktokUrl = requestUrl.searchParams.get('url');
  const directUrl = requestUrl.searchParams.get('direct');
  const debug = requestUrl.searchParams.get('debug') === '1';
  
  if (!tiktokUrl && !directUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "url" or "direct" parameter' }));
    return;
  }
  
  let targetUrl;
  if (directUrl) {
    targetUrl = directUrl;
  } else {
    targetUrl = `https://clipssaver.com/tiktok-profile-viewer/${encodeURIComponent(tiktokUrl)}`;
  }
  
  try {
    const html = await fetchText(targetUrl);
    
    if (debug) {
      // Return raw HTML (or a snippet if too large)
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end(html); // You can truncate with html.substring(0, 50000) if needed
      return;
    }
    
    const data = extractFromHtml(html);
    data.source = targetUrl;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch clipssaver page', details: error.message }));
  }
};

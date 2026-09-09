const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// Helper: perform an HTTPS request with redirect following and decompression
function fetchUrl(urlStr, redirects = 0) {
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
        // Add a common TikTok cookie (optional, improves reliability)
        'Cookie': 'tt_webid_v2=7020568976118589446; tt_webid=7020568976118589446; msToken=YOUR_MSTOKEN_HERE;',
      },
    };

    const req = https.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        res.resume();
        resolve(fetchUrl(redirectUrl, redirects + 1));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Request failed with status ${res.statusCode}`));
        return;
      }

      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      const decoder = new StringDecoder('utf-8');
      let body = '';
      stream.on('data', (chunk) => {
        body += decoder.write(chunk);
      });
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

// Extract video info from TikTok HTML using multiple possible JSON containers
function extractVideoInfo(html) {
  const info = {
    url: null,
    id: null,
    description: null,
    author: {
      id: null,
      uniqueId: null,
      nickname: null,
      avatarLarger: null,
      signature: null,
      verified: false,
    },
    statistics: {
      diggCount: 0,
      shareCount: 0,
      commentCount: 0,
      playCount: 0,
    },
    video: {
      cover: null,
      dynamicCover: null,
      playAddr: null,
      downloadAddr: null,
      duration: null,
      ratio: null,
      format: null,
    },
    music: {
      id: null,
      title: null,
      playUrl: null,
      coverLarge: null,
      authorName: null,
    },
    createTime: null,
    isAd: false,
  };

  // Try multiple patterns to locate JSON data
  const patterns = [
    // Pattern 1: <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">...</script>
    {
      name: '__UNIVERSAL_DATA_FOR_REHYDRATION__',
      regex: /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => {
        // In this structure, video data is under data["__DEFAULT_SCOPE__"]["webapp.video-detail"]["itemInfo"]["itemStruct"]
        const defaultScope = data?.['__DEFAULT_SCOPE__'];
        if (!defaultScope) return null;
        const videoDetail = defaultScope['webapp.video-detail'];
        const itemStruct = videoDetail?.itemInfo?.itemStruct;
        return itemStruct;
      }
    },
    // Pattern 2: <script id="SIGI_STATE" type="application/json">...</script>
    {
      name: 'SIGI_STATE',
      regex: /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => {
        const videoModule = data?.ItemModule;
        if (!videoModule) return null;
        const videoId = Object.keys(videoModule)[0];
        return videoId ? videoModule[videoId] : null;
      }
    },
    // Pattern 3: window._SIG_I_H_ = {...};
    {
      name: 'window._SIG_I_H_',
      regex: /window\._SIG_I_H_\s*=\s*({[\s\S]*?});/,
      parser: (data) => {
        const videoModule = data?.ItemModule;
        if (!videoModule) return null;
        const videoId = Object.keys(videoModule)[0];
        return videoId ? videoModule[videoId] : null;
      }
    },
    // Pattern 4: window.__INIT_PROPS__ = {...}; (alternative)
    {
      name: 'window.__INIT_PROPS__',
      regex: /window\.__INIT_PROPS__\s*=\s*({[\s\S]*?});/,
      parser: (data) => {
        const videoData = data?.['/video/:id']?.videoData;
        return videoData?.itemInfo?.itemStruct || null;
      }
    }
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern.regex);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        const item = pattern.parser(json);
        if (item) {
          // Now populate info from item
          info.id = item.id || item.video?.id || null;
          info.description = item.desc || item.description || null;
          info.createTime = item.createTime || item.create_time || null;
          info.isAd = item.isAd || item.is_ad || false;

          // Stats
          const stats = item.stats || item.statistics || {};
          info.statistics = {
            diggCount: stats.diggCount || stats.digg_count || 0,
            shareCount: stats.shareCount || stats.share_count || 0,
            commentCount: stats.commentCount || stats.comment_count || 0,
            playCount: stats.playCount || stats.play_count || 0,
          };

          // Video details
          const video = item.video || {};
          info.video = {
            cover: video.cover || video.coverUrl || null,
            dynamicCover: video.dynamicCover || null,
            playAddr: video.playAddr || video.play_addr?.url_list?.[0] || null,
            downloadAddr: video.downloadAddr || video.download_addr?.url_list?.[0] || null,
            duration: video.duration || null,
            ratio: video.ratio || null,
            format: video.format || null,
          };

          // Author
          const author = item.author || {};
          info.author = {
            id: author.id || null,
            uniqueId: author.uniqueId || author.unique_id || null,
            nickname: author.nickname || null,
            avatarLarger: author.avatarLarger || author.avatar_larger?.url_list?.[0] || null,
            signature: author.signature || null,
            verified: author.verified || false,
          };

          // Music
          const music = item.music || {};
          info.music = {
            id: music.id || null,
            title: music.title || null,
            playUrl: music.playUrl || music.play_url?.url_list?.[0] || null,
            coverLarge: music.coverLarge || music.cover_large?.url_list?.[0] || null,
            authorName: music.authorName || music.author_name || null,
          };

          return info;
        }
      } catch (e) {
        console.error(`Error parsing ${pattern.name} JSON:`, e.message);
      }
    }
  }

  // If nothing found, log first 500 chars for debugging
  console.error('No video data found. HTML snippet:', html.substring(0, 500));
  return info;
}

// Export the serverless function handler
module.exports = async function handler(req, res) {
  // CORS headers
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

  if (!tiktokUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    return;
  }

  if (!/^https?:\/\/(www\.)?(tiktok\.com|vt\.tiktok\.com)\//i.test(tiktokUrl)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid TikTok URL' }));
    return;
  }

  try {
    console.log(`Fetching ${tiktokUrl}`);
    const html = await fetchUrl(tiktokUrl);
    console.log(`Received HTML length: ${html.length}`);
    const info = extractVideoInfo(html);
    info.url = tiktokUrl;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(info, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch TikTok video info', details: error.message }));
  }
};

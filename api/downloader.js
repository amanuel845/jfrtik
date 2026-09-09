const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// fetchUrl function remains unchanged (copy from previous code)

function extractDownloaderData(html) {
  const patterns = [
    {
      name: '__UNIVERSAL_DATA_FOR_REHYDRATION__',
      regex: /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct,
    },
    {
      name: 'SIGI_STATE',
      regex: /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/,
      parser: (data) => {
        const vm = data?.ItemModule;
        if (!vm) return null;
        const id = Object.keys(vm)[0];
        return id ? vm[id] : null;
      },
    },
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern.regex);
    if (!match) continue;

    try {
      const json = JSON.parse(match[1]);
      const item = pattern.parser(json);
      if (!item) continue;

      const data = {
        id: item.id || null,
        cover: item.video?.cover || item.video?.originCover || null,
        author: {
          id: item.author?.id || null,
          uniqueId: item.author?.uniqueId || null,
          nickname: item.author?.nickname || null,
          avatar: item.author?.avatarLarger || item.author?.avatarMedium || item.author?.avatarThumb || null,
        },
        stats: {
          playCount: item.stats?.playCount || (item.statsV2 ? parseInt(item.statsV2.playCount || '0') : 0),
          diggCount: item.stats?.diggCount || (item.statsV2 ? parseInt(item.statsV2.diggCount || '0') : 0),
          commentCount: item.stats?.commentCount || (item.statsV2 ? parseInt(item.statsV2.commentCount || '0') : 0),
          shareCount: item.stats?.shareCount || (item.statsV2 ? parseInt(item.statsV2.shareCount || '0') : 0),
          collectCount: item.stats?.collectCount || (item.statsV2 ? parseInt(item.statsV2.collectCount || '0') : 0),
        },
        qualities: [],
        downloadUrl: null,
      };

      // 1. Collect all quality variants from bitrateInfo
      if (item.video?.bitrateInfo && item.video.bitrateInfo.length > 0) {
        for (const info of item.video.bitrateInfo) {
          const qualityLabel = info.GearName || info.definition || info.QualityType || 'unknown';
          const urls = info.PlayAddr?.UrlList || [];
          if (urls.length > 0) {
            data.qualities.push({
              label: qualityLabel,
              bitrate: info.Bitrate || null,
              urls: urls,
            });
          }
        }
      }

      // 2. If no bitrateInfo, use playAddr as a single "default" quality
      if (data.qualities.length === 0 && item.video?.playAddr) {
        data.qualities.push({
          label: 'default',
          bitrate: item.video.bitrate || null,
          urls: [item.video.playAddr],
        });
      }

      // 3. Set the primary downloadUrl to the first available URL
      if (data.qualities.length > 0) {
        data.downloadUrl = data.qualities[0].urls[0];
      }

      return data;
    } catch (e) {
      console.error(`Error parsing ${pattern.name}:`, e.message);
    }
  }

  return null;
}

// Handler remains the same, but the response now includes `qualities` array
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
    const html = await fetchUrl(tiktokUrl);
    const data = extractDownloaderData(html);
    if (!data) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Video data not found' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error('Error:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to fetch TikTok video', details: error.message }));
  }
};

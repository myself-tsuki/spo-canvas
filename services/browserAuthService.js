import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

let cachedCreds = null;
let credsExpiresAt = 0;

const parseNetscapeCookies = (text) => {
  const cookies = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        name: parts[5],
        value: parts[6].trim(),
        domain: parts[0],
        path: parts[2],
        secure: parts[3] === 'TRUE',
        expires: parseFloat(parts[4])
      });
    }
  }
  return cookies;
};

const getExecutablePath = () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  for (const p of ['/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
};

export const getBrowserCredentials = async () => {
  if (cachedCreds && Date.now() < credsExpiresAt) {
    return cachedCreds;
  }

  const cookiePath = path.resolve('cookies.txt');
  if (!fs.existsSync(cookiePath)) {
    throw new Error('cookies.txt not found in project root.');
  }

  const executablePath = getExecutablePath();
  if (!executablePath) {
    throw new Error('Chrome/Chromium not found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.');
  }

  console.log('Launching headless browser to retrieve Spotify credentials...');
  const cookieText = fs.readFileSync(cookiePath, 'utf8');
  const cookies = parseNetscapeCookies(cookieText);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setCookie(...cookies);

    let authorization = null;
    let clientToken = null;

    const credsPromise = new Promise((resolve) => {
      page.on('request', request => {
        const headers = request.headers();
        if (headers['authorization'] && headers['authorization'].startsWith('Bearer ') && headers['client-token']) {
          if (!authorization) {
            authorization = headers['authorization'].split(' ')[1];
            clientToken = headers['client-token'];
            resolve({ authorization, clientToken });
          }
        }
      });
    });

    await page.goto('https://open.spotify.com/search', { waitUntil: 'networkidle2', timeout: 30000 });

    const creds = await Promise.race([
      credsPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Credential detection timed out')), 15000))
    ]);

    // Cache for 50 minutes
    cachedCreds = creds;
    credsExpiresAt = Date.now() + 50 * 60 * 1000;
    console.log('Credentials retrieved and cached successfully.');
    return creds;
  } finally {
    await browser.close();
  }
};

// Search using Spotify's internal GraphQL v2 endpoint
export const searchSpotifyGraphQL = async (query, limit = 20) => {
  const { authorization, clientToken } = await getBrowserCredentials();

  const payload = {
    variables: {
      query,
      limit,
      offset: 0,
      numberOfTopResults: limit,
      includeArtistHasConcertsField: false,
      includeAudiobooks: false,
      includeAuthors: false,
      includePreReleases: true,
      includeAlbumPreReleases: true,
      includeEpisodeContentRatingsV2: false,
      isPrefix: null
    },
    operationName: 'searchTopResultsList',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '63a93cc04f6d8dea84a85de315e43f396a76cb681500de9ac5ccf5fc618c84cb'
      }
    }
  };

  const axios = (await import('axios')).default;
  const response = await axios.post('https://api-partner.spotify.com/pathfinder/v2/query', payload, {
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${authorization}`,
      'client-token': clientToken,
      'app-platform': 'WebPlayer',
      'origin': 'https://open.spotify.com',
      'referer': 'https://open.spotify.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'spotify-app-version': '1.2.95.15.g813d8ea0'
    }
  });

  // Extract tracks from the GraphQL response
  const topResults = response.data?.data?.searchV2?.topResultsV2?.itemsV2 || [];
  const tracks = topResults
    .filter(item => item?.item?.__typename === 'TrackResponseWrapper')
    .map(item => {
      const d = item.item.data;
      return {
        id: d.id,
        name: d.name,
        uri: d.uri,
        artists: (d.artists?.items || []).map(a => ({ name: a.profile.name, uri: a.uri })),
        duration_ms: d.duration?.totalMilliseconds,
        album: {
          name: d.albumOfTrack?.name,
          id: d.albumOfTrack?.id
        }
      };
    });

  return tracks;
};

// Backwards compatible export for token-only consumers
export const getBrowserSearchToken = async () => {
  const { authorization } = await getBrowserCredentials();
  return authorization;
};

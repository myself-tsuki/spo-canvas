import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { updateSpDc } from './spotifyAuthService.js';

let cachedCreds = null;
let credsExpiresAt = 0;
let browser = null;
let page = null;
let pendingResolvers = [];
let activeRefreshPromise = null;
let pageNavigationPromise = null;

const runWithPageLock = async (fn) => {
  while (pageNavigationPromise) {
    try {
      await pageNavigationPromise;
    } catch (e) {}
  }
  pageNavigationPromise = (async () => {
    try {
      return await fn();
    } finally {
      pageNavigationPromise = null;
    }
  })();
  return pageNavigationPromise;
};

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

// Update cookies from browser context to sp_dc
const syncCookies = async () => {
  if (!page) return;
  try {
    const pageCookies = await page.cookies();
    const spDcCookie = pageCookies.find(c => c.name === 'sp_dc');
    if (spDcCookie) {
      updateSpDc(spDcCookie.value);
      console.log('Synced sp_dc cookie from persistent browser:', spDcCookie.value);
    }
  } catch (error) {
    console.error('Failed to sync cookies from browser:', error.message);
  }
};

// Plays a song briefly to trigger cookie/token updates
const playSongToRefreshSession = () => runWithPageLock(async () => {
  if (!page) return;
  try {
    console.log('Navigating to a Spotify track to trigger playback session refresh...');
    // Navigate to a popular stable track
    await page.goto('https://open.spotify.com/track/4PTG3Z6ehGkBF3zI7Ywt8q', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for the main play button to be rendered
    const playButtonSelector = 'button[data-testid="play-button"], button[aria-label="Play"]';
    await page.waitForSelector(playButtonSelector, { timeout: 10000 });
    
    // Click play
    await page.click(playButtonSelector);
    console.log('Playback command sent. Waiting 6 seconds to let Spotify update session tokens...');
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // Pause playback to prevent running up data/audio streams indefinitely
    const pauseButtonSelector = 'button[data-testid="control-button-playpause"], button[aria-label="Pause"]';
    try {
      await page.waitForSelector(pauseButtonSelector, { timeout: 2000 });
      await page.click(pauseButtonSelector);
      console.log('Playback paused successfully.');
    } catch (e) {
      console.log('Could not find pause button (or already paused), continuing...');
    }
    
    // Navigate back to search to be ready for search header intercepts
    await page.goto('https://open.spotify.com/search', { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (error) {
    console.error('Failed to trigger song playback refresh:', error.message);
    // Fallback: make sure we are back on search page
    try {
      await page.goto('https://open.spotify.com/search', { waitUntil: 'networkidle2', timeout: 20000 });
    } catch (e) {}
  }
});

export const initPersistentBrowser = async () => {
  if (browser) {
    try {
      await browser.close();
    } catch (e) {}
  }

  const cookiePath = path.resolve('cookies.txt');
  if (!fs.existsSync(cookiePath)) {
    throw new Error('cookies.txt not found in project root.');
  }

  const executablePath = getExecutablePath();
  if (!executablePath) {
    throw new Error('Chrome/Chromium not found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.');
  }

  console.log('Starting persistent headless browser...');
  const cookieText = fs.readFileSync(cookiePath, 'utf8');
  const cookies = parseNetscapeCookies(cookieText);

  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  page = await browser.newPage();
  await page.setCookie(...cookies);

  page.on('request', async (request) => {
    const headers = request.headers();
    if (headers['authorization'] && headers['authorization'].startsWith('Bearer ') && headers['client-token']) {
      const authorization = headers['authorization'].split(' ')[1];
      const clientToken = headers['client-token'];
      
      cachedCreds = { authorization, clientToken };
      // Cache for 50 minutes
      credsExpiresAt = Date.now() + 50 * 60 * 1000;
      
      const resolvers = [...pendingResolvers];
      pendingResolvers = [];
      for (const resolver of resolvers) {
        resolver(cachedCreds);
      }
    }
  });

  // Periodically sync sp_dc cookie and reload page to keep session alive
  page.on('load', syncCookies);

  console.log('Navigating persistent browser to Spotify...');
  await page.goto('https://open.spotify.com/search', { waitUntil: 'networkidle2', timeout: 60000 });
  await syncCookies();

  // Play a song on initialization to ensure cookies get updated immediately
  await playSongToRefreshSession();

  // Refresh every 15 minutes by playing a song and syncing cookies
  setInterval(async () => {
    try {
      console.log('Triggering periodic playback session refresh...');
      await playSongToRefreshSession();
      await syncCookies();
    } catch (error) {
      console.error('Error refreshing persistent browser page:', error.message);
    }
  }, 15 * 60 * 1000);
};

export const getBrowserCredentials = async () => {
  if (!browser || !page) {
    await initPersistentBrowser();
  }

  if (cachedCreds && Date.now() < credsExpiresAt) {
    return cachedCreds;
  }

  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    console.log('Credentials expired or missing, triggering song play session to refresh...');
    const credsPromise = new Promise((resolve) => {
      pendingResolvers.push(resolve);
    });

    try {
      await playSongToRefreshSession();
      const creds = await Promise.race([
        credsPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Credential detection timed out')), 25000))
      ]);
      return creds;
    } catch (error) {
      throw error;
    } finally {
      activeRefreshPromise = null;
      pendingResolvers = [];
    }
  })();

  return activeRefreshPromise;
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

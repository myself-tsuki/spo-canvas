import axios from 'axios';
import { getBrowserCredentials } from './browserAuthService.js';

export async function getLyrics(trackId, imageUri = '') {
  try {
    const { authorization, clientToken } = await getBrowserCredentials();
    
    // Construct the endpoint path depending on whether imageUri is provided
    let url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}`;
    if (imageUri) {
      url += `/image/${encodeURIComponent(imageUri)}`;
    }
    url += '?format=json&vocalRemoval=false&market=from_token';

    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-GB',
        'App-Platform': 'WebPlayer',
        'Authorization': `Bearer ${authorization}`,
        'Client-Token': clientToken,
        'Origin': 'https://open.spotify.com',
        'Referer': 'https://open.spotify.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Spotify-App-Version': '1.2.95.154.g2abc6fb9'
      }
    });

    return response.data;
  } catch (error) {
    console.error(`Lyrics request error for track ${trackId}:`, error.response?.data || error.message);
    return null;
  }
}

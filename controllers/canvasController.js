import { getCanvases } from '../services/spotifyCanvasService.js';
import { searchSpotifyGraphQL } from '../services/browserAuthService.js';

const normalizeText = (text) => {
  if (!text) return '';
  return text.toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const findBestMatch = (candidates, name, artist, duration) => {
  const targetName = normalizeText(name);
  const targetArtist = normalizeText(artist);

  let targetDurationMs = null;
  if (duration !== undefined && duration !== null) {
    const parsedDuration = parseFloat(duration);
    if (!isNaN(parsedDuration)) {
      targetDurationMs = parsedDuration < 3000 ? parsedDuration * 1000 : parsedDuration;
    }
  }

  let bestMatch = null;
  let bestScore = -1;

  for (const track of candidates) {
    let score = 0;
    const trackName = normalizeText(track.name);

    if (trackName === targetName) {
      score += 40;
    } else if (trackName.includes(targetName) || targetName.includes(trackName)) {
      score += 20;
    }

    let artistMatch = false;
    let exactArtistMatch = false;
    for (const trackArtist of track.artists || []) {
      const normTrackArtist = normalizeText(trackArtist.name);
      if (normTrackArtist === targetArtist) {
        exactArtistMatch = true;
        artistMatch = true;
      } else if (normTrackArtist.includes(targetArtist) || targetArtist.includes(normTrackArtist)) {
        artistMatch = true;
      }
    }

    if (exactArtistMatch) {
      score += 40;
    } else if (artistMatch) {
      score += 20;
    }

    if (targetDurationMs !== null && track.duration_ms) {
      const diffSec = Math.abs(track.duration_ms - targetDurationMs) / 1000;
      if (diffSec <= 2) {
        score += 30;
      } else if (diffSec <= 5) {
        score += 20;
      } else if (diffSec <= 10) {
        score += 10;
      } else if (diffSec > 30) {
        score -= 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = track;
    }
  }

  return bestScore >= 20 ? bestMatch : null;
};

export const fetchCanvas = async (req, res) => {
  const { trackId, name, song, track, artist, duration } = req.query;

  // 1. Direct track ID lookup
  if (trackId) {
    const canvasData = await getCanvases(`spotify:track:${trackId}`);
    if (!canvasData) {
      return res.status(500).json({ error: 'Failed to fetch canvas data' });
    }
    return res.json(canvasData);
  }

  // 2. Search and match mode
  const targetSongName = name || song || track;
  if (!targetSongName) {
    return res.status(400).json({ error: 'Missing trackId or name parameter' });
  }

  try {
    // Build search query
    const searchQuery = artist ? `${targetSongName} ${artist}` : targetSongName;

    console.log(`Searching Spotify GraphQL for: "${searchQuery}"`);
    const candidates = await searchSpotifyGraphQL(searchQuery, 20);

    if (candidates.length === 0) {
      return res.status(404).json({ error: 'No matching tracks found on Spotify' });
    }

    const matchedTrack = findBestMatch(candidates, targetSongName, artist, duration);
    if (!matchedTrack) {
      return res.status(404).json({ error: 'No track matching the name, artist, and duration criteria was found' });
    }

    console.log(`Matched track: "${matchedTrack.name}" (${matchedTrack.id})`);

    const canvasData = await getCanvases(`spotify:track:${matchedTrack.id}`);
    if (!canvasData) {
      return res.status(500).json({ error: 'Failed to fetch canvas data for the matched track' });
    }

    res.json({
      matchedTrack: {
        id: matchedTrack.id,
        name: matchedTrack.name,
        artist: matchedTrack.artists?.map(a => a.name).join(', '),
        durationMs: matchedTrack.duration_ms
      },
      ...canvasData
    });
  } catch (error) {
    console.error('Fetch canvas error:', error.response?.data || error.message);
    res.status(500).json({ error: 'An error occurred while fetching canvas data' });
  }
};
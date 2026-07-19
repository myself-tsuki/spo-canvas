import express from 'express';
import canvasRoutes from './routes/canvasRoutes.js';
import lyricsRoutes from './routes/lyricsRoutes.js';
import { initPersistentBrowser } from './services/browserAuthService.js';

const app = express();
const PORT = process.env.PORT || 7860;

app.use('/api/canvas', canvasRoutes);
app.use('/api/lyrics', lyricsRoutes);

app.listen(PORT, async function () {
    console.log("Listening on PORT: ", PORT);
    console.log(`Running on local: http://localhost:${PORT}`);
    try {
        await initPersistentBrowser();
        console.log('Persistent browser initialized successfully.');
    } catch (err) {
        console.error('Failed to initialize persistent browser:', err.message);
    }
});
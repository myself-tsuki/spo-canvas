import express from 'express';
import canvasRoutes from './routes/canvasRoutes.js';

const app = express();
const PORT = process.env.PORT || 7860;

app.use('/api/canvas', canvasRoutes);

app.listen(PORT, function () {
    console.log("Listening on PORT: ", PORT);
    console.log(`Running on local: http://localhost:${PORT}`);
});
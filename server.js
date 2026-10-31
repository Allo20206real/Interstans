const path = require('node:path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = openDb(path.join(dataDir, 'interstants.db'));
const app = createApp({ db, uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, 'uploads') });
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Interstants running at http://localhost:${port}`));

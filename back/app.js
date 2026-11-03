import express from 'express';
import session from 'express-session';
import db from './src/repository/db.repository.js';
import { collectionRouter } from './src/router/collection.router.js';
import { photoRouter } from './src/router/photo.router.js';
import { authRouter } from './src/router/auth.router.js';
import { settingsRouter } from './src/router/settings.router.js';
import { clientRouter } from './src/router/client.router.js';
import { requireAuth, verifyOrigin } from './src/middleware/auth.middleware.js';
import { createAdminCors, createClientCors } from './src/config/cors.js';
import { requestLogger } from './src/middleware/request-logger.middleware.js';
import logger from './src/logger.js';

const log = logger.child('app');

const app = express();

app.set('trust proxy', 1); // 1 hop : le conteneur est derrière Envoy (edge Scaleway)

const adminCors = createAdminCors();
const clientCors = createClientCors();

if (!process.env.SESSION_SECRET) {
    log.error('SESSION_SECRET is not set: sessions cannot be signed securely');
}
if (!process.env.ADMIN_ORIGIN) {
    log.warn('ADMIN_ORIGIN is not set: admin CORS and origin checks will reject browser requests');
}
if (!process.env.CLIENT_ORIGIN) {
    log.warn('CLIENT_ORIGIN is not set: client CORS will reject browser requests');
}

app.use(requestLogger); // premier : tout ce qui suit (CORS, auth, contrôleurs) logge avec le requestId
app.use(express.json({ inflate: false })); // refuse les corps compressés (Node2Shell, CVE-2026-111497)
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 1000 * 60 * 60 * 8
    }
}));

// CORS monté avant requireAuth pour que les préflights OPTIONS ne reçoivent pas de 401.
app.use('/auth', adminCors, authRouter);
app.use('/client', clientCors, clientRouter);
app.use('/collections', adminCors, requireAuth, verifyOrigin, collectionRouter);
app.use('/photos', adminCors, requireAuth, verifyOrigin, photoRouter);
app.use('/settings', adminCors, requireAuth, verifyOrigin, settingsRouter);

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.use((err, req, res, next) => {
    log.failure('Unhandled error in request pipeline', err, { method: req.method });
    res.status(500).send('Something broke!');
});

export default app;
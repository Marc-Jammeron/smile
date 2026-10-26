import express from 'express';
import session from 'express-session';
import db from './src/repository/db.repository.js';
import { collectionRouter } from './src/router/collection.router.js';
import { photoRouter } from './src/router/photo.router.js';
import { authRouter } from './src/router/auth.router.js';
import { clientRouter } from './src/router/client.router.js';
import { requireAuth, verifyOrigin } from './src/middleware/auth.middleware.js';
import { createAdminCors, createClientCors } from './src/config/cors.js';

const app = express();

app.set('trust proxy', 1); // 1 hop : le conteneur est derrière Envoy (edge Scaleway)

const adminCors = createAdminCors();
const clientCors = createClientCors();

app.use(express.json());
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

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

export default app;
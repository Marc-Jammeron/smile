import express from 'express';
import cors from 'cors';
import session from 'express-session';
import db from './src/repository/db.repository.js';
import { collectionRouter } from './src/router/collection.router.js';
import { photoRouter } from './src/router/photo.router.js';
import { authRouter } from './src/router/auth.router.js';
import { clientRouter } from './src/router/client.router.js';
import { requireAuth, verifyOrigin } from './src/middleware/auth.middleware.js';

const app = express();

app.set('trust proxy', 1); // 1 hop : le conteneur est derrière Envoy (edge Scaleway)

const allowedOrigins = process.env.CORS_ORIGIN.split(',').map(origin => origin.trim());

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));
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

app.use('/auth', authRouter);
app.use('/client', clientRouter);
app.use('/collections', requireAuth, verifyOrigin, collectionRouter);
app.use('/photos', requireAuth, verifyOrigin, photoRouter);

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

export default app;
import cors from 'cors';

export const parseOrigins = (value) => (value ?? '').split(',').map(origin => origin.trim()).filter(Boolean);

const originChecker = (allowedOrigins) => (origin, callback) => {
    callback(null, !origin || allowedOrigins.includes(origin));
};

// Routes admin (cookie de session) : une seule origine, avec credentials.
export const createAdminCors = () => cors({
    origin: originChecker(parseOrigins(process.env.ADMIN_ORIGIN).slice(0, 1)),
    credentials: true
});

// Routes client (token opaque dans l'URL) : liste d'origines, sans credentials.
export const createClientCors = () => cors({
    origin: originChecker(parseOrigins(process.env.CLIENT_ORIGIN)),
    credentials: false
});

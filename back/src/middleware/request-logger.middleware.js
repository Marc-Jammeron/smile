import { randomUUID } from 'node:crypto';
import logger, { runWithContext } from '../logger.js';

// Le jeton d'accès client est dans le chemin (/client/:token/...) : il ne doit jamais
// finir dans les logs. On loggue le gabarit de la route, pas l'URL réelle.
const maskClientToken = (path) => path.replace(/^\/client\/[^/]+/, '/client/:token');

// req.path est relatif au point de montage du routeur : originalUrl est le seul chemin complet.
const pathOf = (req) => maskClientToken(req.originalUrl.split('?')[0]);

const routeOf = (req) => (req.route ? `${req.baseUrl}${req.route.path}` : pathOf(req));

const elapsedMs = (startedAt) => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;

const levelFor = (status) => {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return 'info';
};

// À monter en premier : chaque log émis ensuite (contrôleurs, services, S3...) porte le
// requestId, et la réponse le renvoie dans X-Request-Id pour retrouver une requête précise.
export const createRequestLogger = (log = logger.child('http')) => (req, res, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    res.setHeader('X-Request-Id', requestId);

    const context = { requestId };
    // Les listeners d'événements ne gardent pas forcément le contexte async : on le réinjecte.
    const inContext = (fn) => (...args) => runWithContext(context, () => fn(...args));

    runWithContext(context, () => {
        log.debug('Request started', { method: req.method, path: pathOf(req), ip: req.ip });

        let finished = false;
        res.on('finish', inContext(() => {
            finished = true;
            const status = res.statusCode;
            log[levelFor(status)]('Request completed', {
                method: req.method,
                route: routeOf(req),
                status,
                durationMs: elapsedMs(startedAt),
                contentLength: res.getHeader('content-length') ?? undefined,
                ip: req.ip
            });
        }));
        // Client qui coupe avant la fin (fermeture d'onglet, ZIP interrompu...).
        res.on('close', inContext(() => {
            if (!finished) {
                log.warn('Request aborted by client', {
                    method: req.method,
                    route: routeOf(req),
                    durationMs: elapsedMs(startedAt),
                    ip: req.ip
                });
            }
        }));

        next();
    });
};

export const requestLogger = createRequestLogger();

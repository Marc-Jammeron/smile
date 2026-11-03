import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';

// Logger applicatif sans dépendance.
//
//   import logger from '../logger.js';
//   const log = logger.child('photo.service');
//   log.debug('Fetching photos', { collectionId });
//   log.info('Photo created', { photoId });
//   log.warn('Upload rejected', { filename });
//   log.error('Could not delete object', error, { key });
//
// Configuration (variables d'environnement) :
//   LOG_LEVEL   debug | info | warn | error | silent
//               (défaut : info en production, debug sinon, silent sous `node --test`)
//   LOG_FORMAT  json | pretty
//               (défaut : json en production, pretty sinon)
//   NO_COLOR    désactive les couleurs du format pretty
//
// debug/info partent sur stdout, warn/error sur stderr. En json : une ligne par
// entrée, directement exploitable par la collecte de logs de l'hébergeur.

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 20;
const MAX_DEPTH = 5;
const REDACTED = '[REDACTED]';

// Toute clé qui ressemble à un secret est masquée, quelle que soit sa profondeur.
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|signature|credential/i;
// Les URLs présignées S3 donnent un accès direct au fichier : on ne garde pas leur signature.
const SIGNED_QUERY = /(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi;

const requestContext = new AsyncLocalStorage();

// Tout log émis pendant `fn` (y compris après des await) hérite de `context`
// (typiquement { requestId }), sans avoir à le passer de fonction en fonction.
export const runWithContext = (context, fn) => requestContext.run({ ...requestContext.getStore(), ...context }, fn);
export const getContext = () => requestContext.getStore() ?? {};

export const serializeError = (error, depth = 0) => {
    if (!(error instanceof Error)) {
        return error;
    }
    const serialized = { name: error.name, message: sanitizeString(error.message) };
    if (error.status !== undefined) serialized.status = error.status;
    if (error.code !== undefined) serialized.code = error.code;
    if (error.$metadata?.httpStatusCode !== undefined) serialized.httpStatusCode = error.$metadata.httpStatusCode; // AWS SDK
    if (error.stack) serialized.stack = sanitizeString(error.stack);
    if (error.cause !== undefined && depth < 3) serialized.cause = serializeError(error.cause, depth + 1);
    return serialized;
};

function sanitizeString(value) {
    const redacted = value.replace(SIGNED_QUERY, `$1${REDACTED}`);
    return redacted.length > MAX_STRING_LENGTH
        ? `${redacted.slice(0, MAX_STRING_LENGTH)}…[+${redacted.length - MAX_STRING_LENGTH} chars]`
        : redacted;
}

// Rend une valeur sûre et sérialisable : masque les secrets, tronque les gros
// contenus, aplatit les erreurs et les cycles. Ne modifie jamais l'original.
export const sanitize = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null || value === undefined) return value;
    switch (typeof value) {
        case 'string': return sanitizeString(value);
        case 'number': case 'boolean': return value;
        case 'bigint': return value.toString();
        case 'function': case 'symbol': return undefined;
    }
    if (value instanceof Error) return serializeError(value);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    if (depth >= MAX_DEPTH) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitize(item, depth + 1, seen));
        if (value.length > MAX_ARRAY_LENGTH) items.push(`…[+${value.length - MAX_ARRAY_LENGTH} items]`);
        return items;
    }
    if (typeof value.toJSON === 'function') { // instances Sequelize, etc.
        return sanitize(value.toJSON(), depth + 1, seen);
    }

    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(key)) {
            result[key] = item === null || item === undefined ? item : REDACTED;
            continue;
        }
        const clean = sanitize(item, depth + 1, seen);
        if (clean !== undefined) result[key] = clean;
    }
    return result;
};

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const resolveLevel = (env) => {
    const requested = env.LOG_LEVEL?.trim().toLowerCase();
    if (requested && Object.hasOwn(LEVELS, requested)) return requested;
    if (env.NODE_TEST_CONTEXT) return 'silent'; // `node --test` : pas de bruit dans les rapports
    return env.NODE_ENV === 'production' ? 'info' : 'debug';
};

const resolveFormat = (env) => {
    const requested = env.LOG_FORMAT?.trim().toLowerCase();
    if (requested === 'json' || requested === 'pretty') return requested;
    return env.NODE_ENV === 'production' ? 'json' : 'pretty';
};

const defaultWrite = (level, line) => {
    (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
};

const formatJson = (entry) => JSON.stringify(entry);

const formatPretty = ({ time, level, scope, msg, ...rest }, useColor) => {
    const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);
    const { error, ...meta } = rest;
    const { stack, ...errorSummary } = error && typeof error === 'object' ? error : { value: error };

    let line = `${paint(DIM, time.slice(11, 23))} ${paint(COLORS[level], level.toUpperCase().padEnd(5))}`;
    if (scope) line += ` ${paint(DIM, `[${scope}]`)}`;
    line += ` ${msg}`;

    const details = error === undefined ? meta : { ...meta, error: errorSummary };
    if (Object.keys(details).length > 0) {
        line += ` ${paint(DIM, inspect(details, { depth: 4, breakLength: Infinity, colors: false }))}`;
    }
    if (stack) line += `\n${paint(DIM, stack)}`;
    return line;
};

export const createLogger = ({
    level,
    format,
    write = defaultWrite,
    env = process.env,
    color = process.stdout.isTTY && !env.NO_COLOR
} = {}) => {
    const state = {
        threshold: LEVELS[level ?? resolveLevel(env)] ?? LEVELS.info,
        format: format ?? resolveFormat(env)
    };

    const build = (scope, bindings) => {
        const emit = (level, msg, meta) => {
            if (LEVELS[level] < state.threshold) return;

            const entry = {
                time: new Date().toISOString(),
                level,
                ...(scope && { scope }),
                msg: sanitizeString(String(msg)),
                ...getContext(),
                ...bindings
            };
            if (meta instanceof Error) {
                entry.error = serializeError(meta);
            } else if (meta && typeof meta === 'object') {
                for (const [key, value] of Object.entries(sanitize(meta))) {
                    if (!(key in entry)) entry[key] = value; // time/level/scope/msg ne sont jamais écrasés
                }
            }

            write(level, state.format === 'json' ? formatJson(entry) : formatPretty(entry, color));
        };

        const logger = {
            debug: (msg, meta) => emit('debug', msg, meta),
            info: (msg, meta) => emit('info', msg, meta),
            warn: (msg, meta) => emit('warn', msg, meta),
            // error(msg, error, meta) ou error(msg, meta)
            error: (msg, error, meta) => emit('error', msg, mergeError(error, meta)),
            // Un échec attrapé puis relancé : 4xx = refus attendu (warn), le reste = vrai bug (error).
            failure: (msg, error, meta) => {
                const expected = Number.isInteger(error?.status) && error.status < 500;
                emit(expected ? 'warn' : 'error', msg, mergeError(error, meta));
            },
            isLevelEnabled: (level) => LEVELS[level] >= state.threshold,
            // Les enfants partagent le niveau et le format du logger racine ; les scopes s'enchaînent.
            child: (childScope, childBindings) => build(
                [scope, childScope].filter(Boolean).join('.') || undefined,
                { ...bindings, ...childBindings }
            ),
            getLevel: () => Object.keys(LEVELS).find(name => LEVELS[name] === state.threshold),
            setLevel: (newLevel) => {
                if (!Object.hasOwn(LEVELS, newLevel)) throw new Error(`Unknown log level: ${newLevel}`);
                state.threshold = LEVELS[newLevel];
            }
        };
        return logger;
    };

    return build();
};

// error peut être une Error, ou directement l'objet de contexte.
const mergeError = (error, meta) => {
    if (error instanceof Error) return meta ? { ...meta, error } : error;
    return error ?? meta;
};

const logger = createLogger();

export default logger;

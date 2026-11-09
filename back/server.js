import app from './app.js';
import logger from './src/logger.js';
import { getMemorySnapshot, getRuntimeLimits, startMemoryHeartbeat } from './src/utils/memory.js';

const log = logger.child('server');

const port = process.env.PORT || 3000;

app.listen(port, () => {
    log.info('Server listening', {
        port,
        env: process.env.NODE_ENV || 'development',
        logLevel: logger.getLevel(),
        ...getRuntimeLimits(),
        ...getMemorySnapshot()
    });
});

startMemoryHeartbeat();

// Sans ces handlers, un crash n'apparaît que sur stderr brut, hors du format de log.
process.on('uncaughtException', (error, origin) => {
    log.error('Uncaught exception, shutting down', error, { origin, ...getMemorySnapshot() });
    process.exit(1);
});

// Node 22 turns an unhandled rejection into an uncaughtException anyway; handling it
// explicitly keeps the failure readable and adds the memory state at the time of the crash.
process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
    log.error('Unhandled promise rejection, shutting down', error, { origin: 'unhandledRejection', ...getMemorySnapshot() });
    process.exit(1);
});

// Le comportement par défaut de Node est conservé : on logge le signal puis on le
// relance pour que le processus s'arrête comme avant.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        log.info('Signal received, shutting down', { signal });
        process.kill(process.pid, signal);
    });
}

//trigger full pipeline

import app from './app.js';
import logger from './src/logger.js';
import { startWorker, stopWorker, isWorkerEnabled } from './src/services/photo-worker.service.js';

const log = logger.child('server');

const port = process.env.PORT || 3000;

app.listen(port, () => {
    log.info('Server listening', {
        port,
        env: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        logLevel: logger.getLevel()
    });
});

// app.js (via the db repository) has applied the migrations by the time we get here.
// WORKER_ENABLED=false leaves the derived images to a separate `node worker.js` process.
if (isWorkerEnabled()) {
    startWorker();
} else {
    log.info('Photo worker disabled in this process (WORKER_ENABLED=false)');
}

// Sans ces handlers, un crash n'apparaît que sur stderr brut, hors du format de log.
process.on('uncaughtException', (error, origin) => {
    log.error('Uncaught exception, shutting down', error, { origin });
    process.exit(1);
});

// Le comportement par défaut de Node est conservé : on logge le signal, on laisse le
// worker finir les photos en cours (sans en prendre de nouvelles), puis on relance le
// signal pour que le processus s'arrête comme avant.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
        log.info('Signal received, shutting down', { signal });
        try {
            await stopWorker();
        } catch (error) {
            log.failure('Photo worker did not stop cleanly', error);
        }
        process.kill(process.pid, signal);
    });
}

//trigger full pipeline

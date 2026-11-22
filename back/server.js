import app from './app.js';
import logger from './src/logger.js';
import { startWorker, stopWorker, isWorkerEnabled } from './src/services/photo-worker.service.js';
import { startArchiveWorker, stopArchiveWorker, isArchiveWorkerEnabled } from './src/services/archive-worker.service.js';
import { configureSharp, logRuntimeConfig } from './src/services/runtime-metrics.js';

const log = logger.child('server');

const port = process.env.PORT || 3000;

configureSharp();

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
    logRuntimeConfig(); // otherwise logged by the worker at startup
}

// The ZIP worker has its own switch: WORKER_ARCHIVE_ENABLED=false leaves the ZIPs to a
// separate `node worker.js` process (which starts it unless this variable is false there too).
if (isArchiveWorkerEnabled()) {
    startArchiveWorker();
} else {
    log.info('Archive worker disabled in this process (WORKER_ARCHIVE_ENABLED=false)');
}

// Sans ces handlers, un crash n'apparaît que sur stderr brut, hors du format de log.
process.on('uncaughtException', (error, origin) => {
    log.error('Uncaught exception, shutting down', error, { origin });
    process.exit(1);
});

// Le comportement par défaut de Node est conservé : on logge le signal, on laisse le
// worker finir les photos en cours (sans en prendre de nouvelles), on interrompt les ZIP en
// cours (ils repartiront au prochain démarrage), puis on relance le signal pour que le
// processus s'arrête comme avant.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
        log.info('Signal received, shutting down', { signal });
        // In parallel: the ZIPs are interrupted at once, they must not wait for the photos.
        const [photos, archives] = await Promise.allSettled([stopWorker(), stopArchiveWorker()]);
        if (photos.status === 'rejected') log.failure('Photo worker did not stop cleanly', photos.reason);
        if (archives.status === 'rejected') log.failure('Archive worker did not stop cleanly', archives.reason);
        process.kill(process.pid, signal);
    });
}

//trigger full pipeline

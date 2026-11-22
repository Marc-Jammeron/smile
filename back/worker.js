// Standalone entry point: runs only the workers (photos and ZIPs), with no HTTP server. Meant for a
// second container (`node worker.js`) once the worker is moved out of the API process
// (set WORKER_ENABLED=false on the API container).
import './src/repository/db.repository.js'; // connects and applies the migrations
import logger from './src/logger.js';
import { startWorker, stopWorker } from './src/services/photo-worker.service.js';
import { startArchiveWorker, stopArchiveWorker, isArchiveWorkerEnabled } from './src/services/archive-worker.service.js';
import { configureSharp } from './src/services/runtime-metrics.js';

const log = logger.child('worker');

process.on('uncaughtException', (error, origin) => {
    log.error('Uncaught exception, shutting down', error, { origin });
    process.exit(1);
});

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

configureSharp();
startWorker();
if (isArchiveWorkerEnabled()) {
    startArchiveWorker();
} else {
    log.info('Archive worker disabled in this process (WORKER_ARCHIVE_ENABLED=false)');
}

// Standalone entry point: runs only the photo worker, with no HTTP server. Meant for a
// second container (`node worker.js`) once the worker is moved out of the API process
// (set WORKER_ENABLED=false on the API container).
import './src/repository/db.repository.js'; // connects and applies the migrations
import logger from './src/logger.js';
import { startWorker, stopWorker } from './src/services/photo-worker.service.js';
import { configureSharp } from './src/services/runtime-metrics.js';

const log = logger.child('worker');

process.on('uncaughtException', (error, origin) => {
    log.error('Uncaught exception, shutting down', error, { origin });
    process.exit(1);
});

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

configureSharp();
startWorker();

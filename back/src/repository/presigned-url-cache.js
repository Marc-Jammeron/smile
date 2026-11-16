// Cache of presigned download URLs, per object key.
//
// Signing is local CPU work (~0.5 ms per URL) and the admin photo list signs three URLs per
// photo, again on every reload. Every call also produced a *different* URL (new signature),
// so the browser re-downloaded every image on each reload. Serving the same URL for a
// while fixes both.
//
// `ttlMs` must stay well under the URL's own expiry: a URL handed out from the cache
// still has at least `expiresInMs - ttlMs` to live (240 s cache for 300 s => 60 s).
export const createPresignedUrlCache = ({ ttlMs, maxEntries = 5000, now = Date.now }) => {
    // key -> { promise, expiresAt }. The promise is cached, not the URL, so concurrent
    // requests for the same key share one signature.
    const entries = new Map();

    const evict = () => {
        const current = now();
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= current) entries.delete(key);
        }
        // Still full of live entries: drop the oldest ones (Map keeps insertion order).
        for (const key of entries.keys()) {
            if (entries.size < maxEntries) break;
            entries.delete(key);
        }
    };

    const get = (key, sign) => {
        const cached = entries.get(key);
        if (cached && cached.expiresAt > now()) {
            return cached.promise;
        }
        if (entries.size >= maxEntries) {
            evict();
        }
        const promise = Promise.resolve().then(() => sign(key));
        const entry = { promise, expiresAt: now() + ttlMs };
        entries.set(key, entry);
        // A failed signature must not be served again.
        promise.catch(() => {
            if (entries.get(key) === entry) entries.delete(key);
        });
        return promise;
    };

    return {
        get,
        // The object was replaced or deleted: the next caller gets a fresh URL.
        invalidate: (key) => { entries.delete(key); },
        size: () => entries.size
    };
};

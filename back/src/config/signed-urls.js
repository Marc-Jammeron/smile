// Lifetime of presigned S3 URLs, in seconds. Unrelated to the client gallery link's own
// expiry (accessTokenExpiresAt), which is a separate mechanism.
export const SIGNED_URL_TTL_SECONDS = Object.freeze({
    // PUT: a whole 10-file upload batch must be able to finish with the URLs it received.
    upload: 3600,
    // Watermarked previews/thumbnails: low value, and long enough for lazy-loaded images
    // of a gallery tab left open.
    preview: 3600,
    // Full-resolution originals: shorter, as a leaked link is worth more.
    original: 900,
    // Everything else (e.g. branding logo) keeps the historical value.
    default: 300
});

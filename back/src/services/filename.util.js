// Extension check is case-insensitive throughout (`.CR2` and `.cr2` are the same
// file kind) — this must be applied consistently wherever a filename is classified,
// both at grouping time and at confirm time.
const MAIN_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg']);

const getExtension = (filename) => {
    const match = /\.[^./\\]+$/.exec(filename || '');
    return match ? match[0].toLowerCase() : '';
};

export const isMainPhotoFilename = (filename) => MAIN_PHOTO_EXTENSIONS.has(getExtension(filename));

// Blacklist, not whitelist (see spec): only known noise is excluded so any RAW format
// (current or future) is accepted as an attachment without needing to maintain a list
// of camera-specific extensions.
const BLACKLISTED_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

export const isBlacklistedFilename = (filename, size) => {
    if (size === 0) {
        return true;
    }
    const basename = (filename || '').split(/[/\\]/).pop();
    if (basename.startsWith('.')) {
        return true;
    }
    return BLACKLISTED_BASENAMES.has(basename.toLowerCase());
};

const stripDiacritics = (value) => Array.from(value.normalize('NFD'))
    .filter((char) => {
        const codePoint = char.codePointAt(0);
        return codePoint < 0x0300 || codePoint > 0x036f; // combining diacritical marks block
    })
    .join('');

export const slugifyCollectionName = (name) => {
    const slug = stripDiacritics(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-+|-+$)/g, '');
    return slug || 'collection';
};

// Name under which the browser saves a downloaded ZIP: `<collection>-HD-<yyyymmdd>.zip` for
// the retouching selection, `<collection>-<yyyymmdd>.zip` for the delivered photos. The date
// is the day of the download (it is computed when the presigned URL is requested).
export const archiveDownloadFilename = (collectionName, kind, now = new Date()) => {
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = kind === 'SELECTION_HD' ? '-HD' : '';
    return `${slugifyCollectionName(collectionName)}${suffix}-${date}.zip`;
};

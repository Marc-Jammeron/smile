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

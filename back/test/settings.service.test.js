import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

let row = null;
let created = null;
let s3Objects = new Map(); // key -> { buffer, size }
let deleted = [];
let putCalls = [];

const makeRow = (data) => ({ ...data, async update(values) { Object.assign(this, values, { updatedAt: new Date() }); } });

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        GallerySettings: {
            findByPk: async () => row,
            create: async (data) => { created = data; row = makeRow({ ...data, updatedAt: new Date() }); return row; },
        },
    },
});
mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        objectExists: async (key) => s3Objects.has(key),
        headObject: async (key) => (s3Objects.has(key) ? { size: s3Objects.get(key).size } : null),
        getObject: async (key) => s3Objects.get(key).buffer,
        putObject: async (key, buffer, contentType) => { putCalls.push({ key, buffer, contentType }); s3Objects.set(key, { buffer, size: buffer.length }); return key; },
        deleteObject: async (key) => { deleted.push(key); s3Objects.delete(key); return true; },
        getSignedDownloadUrl: async (key) => `https://s3/get/${key}?signed`,
        getSignedBrandingUploadUrl: async (kind, contentType) => ({ url: 'https://s3/put', key: `branding/${kind}/raw/x` }),
    },
});

const { getSettings, updateSettings, resetWatermark, resetLogo, getClientBranding, confirmUpload, getUploadUrl, validateSettingsValues, validateWatermarkValues, buildWatermarkConfig } =
    await import('../src/services/settings.service.js');

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID_2 = '223e4567-e89b-42d3-a456-426614174000';
const RAW_KEY = `branding/watermark/raw/${UUID}`;
const FINAL_KEY = `branding/watermark/${UUID}.png`;

const png = (width = 100, height = 50) =>
    sharp({ create: { width, height, channels: 4, background: '#ff0000' } }).png().toBuffer();

const putRaw = (buffer, size = buffer.length) => s3Objects.set(RAW_KEY, { buffer, size });

beforeEach(() => {
    row = null;
    created = null;
    s3Objects = new Map();
    deleted = [];
    putCalls = [];
    delete process.env.WATERMARK_OPACITY;
    delete process.env.WATERMARK_POSITION;
});

const rejects = (promise, message) =>
    assert.rejects(promise, (error) => error.status === 400 && (!message || error.message.includes(message)));

test('validation rejects out-of-range, off-step and mistyped values', async () => {
    for (const watermarkOpacity of [5, 85, 62, '60']) {
        await rejects(validateSettingsValues({ watermarkOpacity }));
    }
    for (const watermarkSize of [5, 55, 12]) {
        await rejects(validateSettingsValues({ watermarkSize }));
    }
    await rejects(validateSettingsValues({ watermarkPosition: 'north' }));
    await rejects(validateSettingsValues({ watermarkKey: 'uploads/c/original.jpg' }));
    await rejects(validateSettingsValues({ watermarkKey: `branding/watermark/${UUID}.png` }), 'introuvable');
    await rejects(validateSettingsValues({ watermarkLogo: 1 }), 'inconnu');
    await rejects(validateSettingsValues([]));
});

test('validation accepts null and valid values', async () => {
    const values = { watermarkKey: null, watermarkPosition: null, watermarkOpacity: null, watermarkSize: null };
    assert.deepEqual(await validateSettingsValues(values), values);

    s3Objects.set(FINAL_KEY, { buffer: Buffer.alloc(1), size: 1 });
    const valid = { watermarkKey: FINAL_KEY, watermarkPosition: 'center', watermarkOpacity: 80, watermarkSize: 10 };
    assert.deepEqual(await validateSettingsValues(valid), valid);
});

test('getSettings falls back to the original values when there is no row', async () => {
    assert.deepEqual(await getSettings(), {
        watermarkKey: null, watermarkPosition: 'southeast', watermarkOpacity: 60, watermarkSize: null,
        logoKey: null, displayName: null, tagline: null, welcomeMessage: null, fontId: null, colorBg: null,
        brandMode: null, showTagline: null, logoUrl: null, photographerName: null, updatedAt: null,
    });
});

test('getSettings converts the env opacity to an integer percentage', async () => {
    process.env.WATERMARK_OPACITY = '0.5';
    process.env.WATERMARK_POSITION = 'northwest';
    const settings = await getSettings();
    assert.equal(settings.watermarkOpacity, 50);
    assert.equal(settings.watermarkPosition, 'northwest');
});

test('updateSettings creates the row, then only touches the given keys', async () => {
    await updateSettings({ watermarkOpacity: 30 });
    assert.equal(created.id, 1);
    const settings = await updateSettings({ watermarkSize: 20 });
    assert.equal(settings.watermarkOpacity, 30);
    assert.equal(settings.watermarkSize, 20);
    assert.ok(settings.updatedAt);
});

test('changing the watermark key deletes the previous object after the write', async () => {
    const oldKey = `branding/watermark/${UUID_2}.png`;
    s3Objects.set(oldKey, { buffer: Buffer.alloc(1), size: 1 });
    s3Objects.set(FINAL_KEY, { buffer: Buffer.alloc(1), size: 1 });
    row = makeRow({ id: 1, watermarkKey: oldKey, updatedAt: new Date() });

    const settings = await updateSettings({ watermarkKey: FINAL_KEY });
    assert.equal(settings.watermarkKey, FINAL_KEY);
    assert.deepEqual(deleted, [oldKey]);
});

test('resetWatermark nulls everything, deletes the object, and is idempotent without a row', async () => {
    assert.equal((await resetWatermark()).watermarkOpacity, 60);

    s3Objects.set(FINAL_KEY, { buffer: Buffer.alloc(1), size: 1 });
    row = makeRow({ id: 1, watermarkKey: FINAL_KEY, watermarkPosition: 'center', watermarkOpacity: 30, watermarkSize: 20 });
    const settings = await resetWatermark();
    assert.deepEqual(
        [settings.watermarkKey, settings.watermarkPosition, settings.watermarkOpacity, settings.watermarkSize],
        [null, 'southeast', 60, null]
    );
    assert.deepEqual(deleted, [FINAL_KEY]);
});

test('buildWatermarkConfig resolves saved values over the original ones', async () => {
    const original = await buildWatermarkConfig({});
    assert.equal(original.opacity, 0.6);
    assert.equal(original.position, 'southeast');
    assert.equal(original.size, null);
    assert.equal(original.margin, 24);
    assert.equal(typeof original.image, 'string');

    s3Objects.set(FINAL_KEY, { buffer: Buffer.from('png'), size: 3 });
    const saved = await buildWatermarkConfig({ watermarkKey: FINAL_KEY, watermarkPosition: 'center', watermarkOpacity: 35, watermarkSize: 20 });
    assert.deepEqual(saved, { image: Buffer.from('png'), position: 'center', opacity: 0.35, size: 20, margin: 24 });
});

test('getUploadUrl only accepts the known kinds with their content types', async () => {
    assert.equal((await getUploadUrl('watermark', 'image/png')).key, 'branding/watermark/raw/x');
    await rejects(getUploadUrl('watermark', 'image/jpeg'));
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp']) {
        assert.equal((await getUploadUrl('logo', contentType)).key, 'branding/logo/raw/x');
    }
    await rejects(getUploadUrl('logo', 'image/gif'));
    await rejects(getUploadUrl('logo', 'image/svg+xml'));
    await rejects(getUploadUrl('toString', 'image/png'));
});

test('confirmUpload re-encodes a valid PNG and removes the raw object', async () => {
    putRaw(await png());
    const { key } = await confirmUpload('watermark', RAW_KEY);
    assert.match(key, /^branding\/watermark\/[0-9a-f-]{36}\.png$/);
    assert.equal(putCalls.length, 1);
    assert.equal(putCalls[0].contentType, 'image/png');
    assert.equal((await sharp(putCalls[0].buffer).metadata()).format, 'png');
    assert.deepEqual(deleted, [RAW_KEY]);
});

test('confirmUpload refuses a JPEG disguised as a PNG', async () => {
    putRaw(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    await rejects(confirmUpload('watermark', RAW_KEY), 'PNG');
    assert.deepEqual(deleted, [RAW_KEY]);
    assert.equal(putCalls.length, 0);
});

test('confirmUpload refuses an SVG', async () => {
    putRaw(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'));
    await rejects(confirmUpload('watermark', RAW_KEY), 'PNG');
    assert.deepEqual(deleted, [RAW_KEY]);
});

test('confirmUpload refuses an unreadable file', async () => {
    putRaw(Buffer.from('not an image'));
    await rejects(confirmUpload('watermark', RAW_KEY), 'illisible');
});

test('confirmUpload refuses a file over 2 MB without reading it', async () => {
    s3Objects.set(RAW_KEY, { get buffer() { throw new Error('must not be read'); }, size: 2 * 1024 * 1024 + 1 });
    await rejects(confirmUpload('watermark', RAW_KEY), 'trop lourd');
    assert.deepEqual(deleted, [RAW_KEY]);
});

test('confirmUpload refuses an image over 2000 px', async () => {
    putRaw(await png(3000, 10));
    await rejects(confirmUpload('watermark', RAW_KEY), 'trop grande');
    assert.deepEqual(deleted, [RAW_KEY]);
});

test('confirmUpload refuses a missing object', async () => {
    await rejects(confirmUpload('watermark', RAW_KEY));
});

test('confirmUpload refuses keys outside branding/watermark/raw/ without touching S3', async () => {
    for (const key of ['uploads/c/original.jpg', `branding/watermark/${UUID}.png`, `branding/logo/raw/${UUID}`, `branding/watermark/raw/../${UUID}`, undefined]) {
        await rejects(confirmUpload('watermark', key));
    }
    assert.deepEqual(deleted, []);
    assert.equal(putCalls.length, 0);
});

// --- Lot 2 : vue client ---

const LOGO_RAW_KEY = `branding/logo/raw/${UUID}`;
const LOGO_KEY = `branding/logo/${UUID}.png`;

test('validation refuses invalid texts', async () => {
    await rejects(validateSettingsValues({ displayName: 'a'.repeat(41) }), 'trop long');
    await rejects(validateSettingsValues({ tagline: 'a'.repeat(41) }), 'trop long');
    await rejects(validateSettingsValues({ welcomeMessage: 'a'.repeat(281) }), 'trop long');
    await rejects(validateSettingsValues({ welcomeMessage: 'bonjour\u0000' }), 'non autorisés');
    await rejects(validateSettingsValues({ displayName: 'a\nb' }), 'non autorisés');
    await rejects(validateSettingsValues({ displayName: 12 }));
});

test('validation counts text length in code points and trims', async () => {
    assert.deepEqual(await validateSettingsValues({ displayName: '😀'.repeat(40) }), { displayName: '😀'.repeat(40) });
    await rejects(validateSettingsValues({ displayName: '😀'.repeat(41) }), 'trop long');
    assert.deepEqual(await validateSettingsValues({ displayName: `  ${'a'.repeat(40)}  ` }), { displayName: 'a'.repeat(40) });
    assert.deepEqual(await validateSettingsValues({ displayName: '', tagline: '   ', welcomeMessage: null }),
        { displayName: null, tagline: null, welcomeMessage: null });
});

test('validation keeps texts as raw text, without HTML cleaning', async () => {
    const text = '<b>x</b><script>';
    assert.deepEqual(await validateSettingsValues({ welcomeMessage: text }), { welcomeMessage: text });
});

test('validation refuses invalid colors and unknown fonts', async () => {
    for (const colorBg of ['red', '#fff', '#GGGGGG', 'javascript:alert(1)', '#abcdef0', 12]) {
        await rejects(validateSettingsValues({ colorBg }), 'Couleur');
    }
    await rejects(validateSettingsValues({ fontId: 'comic-sans' }), 'Police');
    await rejects(validateSettingsValues({ fontId: 'toString' }), 'Police');
});

test('validation accepts a color in either case and stores it in lowercase', async () => {
    assert.deepEqual(await validateSettingsValues({ colorBg: '#ABCDEF' }), { colorBg: '#abcdef' });
    assert.deepEqual(await validateSettingsValues({ colorBg: null, fontId: 'dm-sans' }), { colorBg: null, fontId: 'dm-sans' });
});

test('validation checks brandMode and showTagline', async () => {
    for (const brandMode of ['logoo', 'toString', 1]) {
        await rejects(validateSettingsValues({ brandMode }));
    }
    for (const showTagline of ['false', 0, 1]) {
        await rejects(validateSettingsValues({ showTagline }), 'sous-titre');
    }
    for (const brandMode of ['logo', 'name', 'both', null]) {
        assert.deepEqual(await validateSettingsValues({ brandMode }), { brandMode });
    }
    for (const showTagline of [true, false, null]) {
        assert.deepEqual(await validateSettingsValues({ showTagline }), { showTagline });
    }
});

test('validation checks the logo key prefix, extension and existence', async () => {
    await rejects(validateSettingsValues({ logoKey: 'uploads/c/original.jpg' }), 'Logo');
    await rejects(validateSettingsValues({ logoKey: `branding/watermark/${UUID}.png` }), 'Logo');
    await rejects(validateSettingsValues({ logoKey: `branding/logo/${UUID}.svg` }), 'Logo');
    await rejects(validateSettingsValues({ logoKey: `branding/logo/${UUID}.png` }), 'introuvable');

    for (const extension of ['png', 'jpg', 'webp']) {
        const key = `branding/logo/${UUID}.${extension}`;
        s3Objects.set(key, { buffer: Buffer.alloc(1), size: 1 });
        assert.deepEqual(await validateSettingsValues({ logoKey: key }), { logoKey: key });
    }
});

test('getSettings returns the raw branding values', async () => {
    assert.deepEqual(
        Object.fromEntries(Object.entries(await getSettings()).filter(([key]) => !key.startsWith('watermark'))),
        { logoKey: null, displayName: null, tagline: null, welcomeMessage: null, fontId: null, colorBg: null, brandMode: null, showTagline: null, logoUrl: null, photographerName: null, updatedAt: null }
    );
    row = makeRow({ id: 1, displayName: 'Emma', fontId: 'lora', colorBg: '#ffffff', updatedAt: new Date() });
    const settings = await getSettings();
    assert.deepEqual([settings.displayName, settings.fontId, settings.colorBg], ['Emma', 'lora', '#ffffff']);
});

test('getSettings adds a presigned logo URL and the default name for the admin preview', async () => {
    process.env.PHOTOGRAPHER_DISPLAY_NAME = 'Emma';
    try {
        row = makeRow({ id: 1, logoKey: LOGO_KEY, updatedAt: new Date() });
        const settings = await getSettings();
        assert.equal(settings.logoUrl, `https://s3/get/${LOGO_KEY}?signed`);
        assert.equal(settings.photographerName, 'Emma');
    } finally {
        delete process.env.PHOTOGRAPHER_DISPLAY_NAME;
    }
});

test('changing or removing the logo deletes the previous object', async () => {
    const newKey = `branding/logo/${UUID_2}.webp`;
    s3Objects.set(LOGO_KEY, { buffer: Buffer.alloc(1), size: 1 });
    s3Objects.set(newKey, { buffer: Buffer.alloc(1), size: 1 });
    row = makeRow({ id: 1, logoKey: LOGO_KEY, updatedAt: new Date() });

    await updateSettings({ logoKey: newKey });
    assert.deepEqual(deleted, [LOGO_KEY]);

    const settings = await resetLogo();
    assert.equal(settings.logoKey, null);
    assert.deepEqual(deleted, [LOGO_KEY, newKey]);
});

test('resetLogo is idempotent without a row, and leaves the watermark alone', async () => {
    assert.equal((await resetLogo()).logoKey, null);
    row = makeRow({ id: 1, watermarkKey: FINAL_KEY, logoKey: null, updatedAt: new Date() });
    assert.equal((await resetLogo()).watermarkKey, FINAL_KEY);
    assert.deepEqual(deleted, []);
});

test('restoring the defaults is a PUT of the six fields at null', async () => {
    s3Objects.set(LOGO_KEY, { buffer: Buffer.alloc(1), size: 1 });
    row = makeRow({
        id: 1, logoKey: LOGO_KEY, displayName: 'Emma', tagline: 't', welcomeMessage: 'm', fontId: 'lora', colorBg: '#ffffff',
        brandMode: 'both', showTagline: false, watermarkOpacity: 30, updatedAt: new Date(),
    });
    const settings = await updateSettings({
        logoKey: null, displayName: null, tagline: null, welcomeMessage: null, fontId: null, colorBg: null,
        brandMode: null, showTagline: null,
    });
    assert.deepEqual(
        [settings.logoKey, settings.displayName, settings.tagline, settings.welcomeMessage, settings.fontId, settings.colorBg,
            settings.brandMode, settings.showTagline],
        [null, null, null, null, null, null, null, null]
    );
    assert.equal(settings.watermarkOpacity, 30);
    assert.deepEqual(deleted, [LOGO_KEY]);
});

test('confirmUpload keeps the detected format for a logo', async () => {
    const cases = [
        ['png', 'image/png', 'png', sharp({ create: { width: 40, height: 20, channels: 4, background: '#f00' } }).png()],
        ['jpeg', 'image/jpeg', 'jpg', sharp({ create: { width: 40, height: 20, channels: 3, background: '#0f0' } }).jpeg()],
        ['webp', 'image/webp', 'webp', sharp({ create: { width: 40, height: 20, channels: 3, background: '#00f' } }).webp()],
    ];
    for (const [format, contentType, extension, pipeline] of cases) {
        putCalls = [];
        deleted = [];
        s3Objects.set(LOGO_RAW_KEY, { buffer: await pipeline.toBuffer(), size: 100 });
        const { key } = await confirmUpload('logo', LOGO_RAW_KEY);
        assert.match(key, new RegExp(`^branding/logo/[0-9a-f-]{36}\\.${extension}$`));
        assert.equal(putCalls[0].contentType, contentType);
        const metadata = await sharp(putCalls[0].buffer).metadata();
        assert.equal(metadata.format, format);
        assert.deepEqual([metadata.width, metadata.height], [40, 20]);
        assert.deepEqual(deleted, [LOGO_RAW_KEY]);
    }
});

test('confirmUpload refuses a GIF, an SVG and an oversized logo', async () => {
    s3Objects.set(LOGO_RAW_KEY, { buffer: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).gif().toBuffer(), size: 100 });
    await rejects(confirmUpload('logo', LOGO_RAW_KEY), 'PNG, un JPEG ou un WebP');

    s3Objects.set(LOGO_RAW_KEY, { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), size: 100 });
    await rejects(confirmUpload('logo', LOGO_RAW_KEY), 'PNG, un JPEG ou un WebP');

    s3Objects.set(LOGO_RAW_KEY, { get buffer() { throw new Error('must not be read'); }, size: 2 * 1024 * 1024 + 1 });
    await rejects(confirmUpload('logo', LOGO_RAW_KEY), 'trop lourd');
    assert.equal(putCalls.length, 0);
});

test('confirmUpload refuses a logo key under the watermark prefix and vice versa', async () => {
    await rejects(confirmUpload('logo', RAW_KEY));
    await rejects(confirmUpload('watermark', LOGO_RAW_KEY));
});

test('getClientBranding returns nulls without a row', async () => {
    assert.deepEqual(await getClientBranding(), {
        logoUrl: null, displayName: null, tagline: null, welcomeMessage: null, fontId: null, colorBg: null,
        brandMode: null, showTagline: null,
    });
});

test('getClientBranding presigns the logo and exposes no key nor watermark data', async () => {
    row = makeRow({
        id: 1, logoKey: LOGO_KEY, displayName: 'Emma', fontId: 'lora', colorBg: '#ffffff',
        watermarkKey: FINAL_KEY, watermarkPosition: 'center', watermarkOpacity: 30, watermarkSize: 20, updatedAt: new Date(),
    });
    const branding = await getClientBranding();
    assert.equal(branding.logoUrl, `https://s3/get/${LOGO_KEY}?signed`);
    assert.deepEqual(Object.keys(branding).sort(), ['brandMode', 'colorBg', 'displayName', 'fontId', 'logoUrl', 'showTagline', 'tagline', 'welcomeMessage']);
    assert.ok(!JSON.stringify(branding).includes('watermark'));
});

test('validateWatermarkValues (used by the preview) refuses branding fields', async () => {
    await rejects(validateWatermarkValues({ colorBg: '#ffffff' }), 'inconnu');
    assert.deepEqual(await validateWatermarkValues({ watermarkOpacity: 30 }), { watermarkOpacity: 30 });
});

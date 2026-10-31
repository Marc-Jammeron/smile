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
        getSignedBrandingUploadUrl: async (kind, contentType) => ({ url: 'https://s3/put', key: `branding/${kind}/raw/x` }),
    },
});

const { getSettings, updateSettings, resetWatermark, confirmUpload, getUploadUrl, validateWatermarkValues, buildWatermarkConfig } =
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
        await rejects(validateWatermarkValues({ watermarkOpacity }));
    }
    for (const watermarkSize of [5, 55, 12]) {
        await rejects(validateWatermarkValues({ watermarkSize }));
    }
    await rejects(validateWatermarkValues({ watermarkPosition: 'north' }));
    await rejects(validateWatermarkValues({ watermarkKey: 'uploads/c/original.jpg' }));
    await rejects(validateWatermarkValues({ watermarkKey: `branding/watermark/${UUID}.png` }), 'introuvable');
    await rejects(validateWatermarkValues({ watermarkLogo: 1 }), 'inconnu');
    await rejects(validateWatermarkValues([]));
});

test('validation accepts null and valid values', async () => {
    const values = { watermarkKey: null, watermarkPosition: null, watermarkOpacity: null, watermarkSize: null };
    assert.deepEqual(await validateWatermarkValues(values), values);

    s3Objects.set(FINAL_KEY, { buffer: Buffer.alloc(1), size: 1 });
    const valid = { watermarkKey: FINAL_KEY, watermarkPosition: 'center', watermarkOpacity: 80, watermarkSize: 10 };
    assert.deepEqual(await validateWatermarkValues(valid), valid);
});

test('getSettings falls back to the original values when there is no row', async () => {
    assert.deepEqual(await getSettings(), {
        watermarkKey: null, watermarkPosition: 'southeast', watermarkOpacity: 60, watermarkSize: null, updatedAt: null,
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

test('getUploadUrl only accepts the watermark kind with image/png', async () => {
    assert.equal((await getUploadUrl('watermark', 'image/png')).key, 'branding/watermark/raw/x');
    await rejects(getUploadUrl('watermark', 'image/jpeg'));
    await rejects(getUploadUrl('logo', 'image/png'));
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

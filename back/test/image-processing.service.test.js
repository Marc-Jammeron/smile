import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// image-processing.service.js importe s3.repository.js et settings.service.js (donc la DB).
// Les deux sont mockés ; buildPreview est appelé directement avec une config de watermark.
let loadSavedCalls = 0;
let putObjects = [];
let putBodies = {};
let nextOriginal = null; // overrides the photo returned by the mocked S3 (default: originalBuffer)

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        getObject: async () => nextOriginal ?? originalBuffer,
        putObject: async (key, body) => { putObjects.push(key); putBodies[key] = body; return key; },
    },
});
mock.module('../src/services/settings.service.js', {
    namedExports: {
        validateWatermarkValues: async (values) => values,
        loadSavedWatermarkValues: async () => { loadSavedCalls += 1; return {}; },
        buildWatermarkConfig: async (values) => ({ ...values, ...nextConfig }),
    },
});

const { buildPreview, generateDerivedImages } = await import('../src/services/image-processing.service.js');

const WM_WIDTH = 100;
const WM_HEIGHT = 40;
const MARGIN = 24;

const solid = (width, height, background) =>
    sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

const originalBuffer = await sharp({ create: { width: 1500, height: 1000, channels: 3, background: '#ffffff' } })
    .jpeg().toBuffer();
const watermarkImage = await solid(WM_WIDTH, WM_HEIGHT, '#ff0000');

let nextConfig = {};

const config = (overrides = {}) => ({
    image: watermarkImage, position: 'southeast', opacity: 1, size: null, margin: MARGIN, ...overrides,
});

const decode = async (jpeg) => {
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => {
        const i = (y * info.width + x) * info.channels;
        return { r: data[i], g: data[i + 1], b: data[i + 2] };
    };
    return { info, pixel };
};

const isRed = ({ r, g, b }) => r > 200 && g < 80 && b < 80;
const isWhite = ({ r, g, b }) => r > 235 && g > 235 && b > 235;

test('size = null keeps the native watermark width', async () => {
    const { info, pixel } = await decode(await buildPreview(originalBuffer, { watermark: config() }));
    assert.equal(info.width, 1200);
    const left = info.width - WM_WIDTH - MARGIN;
    const y = info.height - MARGIN - WM_HEIGHT / 2;
    assert.ok(isRed(pixel(left + 5, y)));
    assert.ok(isRed(pixel(left + WM_WIDTH - 6, y)));
    assert.ok(isWhite(pixel(left - 6, y)));
});

test('size scales the watermark to a percentage of the preview width', async () => {
    const { info, pixel } = await decode(await buildPreview(originalBuffer, { watermark: config({ size: 25 }) }));
    const expected = Math.round(info.width * 25 / 100); // 300
    // Le ratio 100x40 est conservé : 300x120, ancré en bas à droite.
    const left = info.width - expected - MARGIN;
    const y = info.height - MARGIN - 60;
    assert.ok(isRed(pixel(left + 6, y)));
    assert.ok(isRed(pixel(left + expected - 7, y)));
    assert.ok(isWhite(pixel(left - 6, y)));
});

const PRESETS = {
    northwest: [MARGIN, MARGIN],
    northeast: [1200 - WM_WIDTH - MARGIN, MARGIN],
    southwest: [MARGIN, 800 - WM_HEIGHT - MARGIN],
    southeast: [1200 - WM_WIDTH - MARGIN, 800 - WM_HEIGHT - MARGIN],
    center: [(1200 - WM_WIDTH) / 2, (800 - WM_HEIGHT) / 2],
};

for (const [position, [left, top]] of Object.entries(PRESETS)) {
    test(`position ${position} puts the watermark at the expected spot`, async () => {
        const { pixel } = await decode(await buildPreview(originalBuffer, { watermark: config({ position }) }));
        assert.ok(isRed(pixel(left + WM_WIDTH / 2, top + WM_HEIGHT / 2)));
        assert.ok(isWhite(pixel(left - 8, top + WM_HEIGHT / 2)));
    });
}

test('a watermark larger than the image does not throw', async () => {
    const huge = await solid(3000, 2000, '#ff0000');
    const jpeg = await buildPreview(originalBuffer, { watermark: config({ image: huge }) });
    const { info } = await decode(jpeg);
    assert.equal(info.width, 1200);
    assert.equal(info.height, 800);
});

test('opacity is applied to the watermark', async () => {
    const { info, pixel } = await decode(await buildPreview(originalBuffer, { watermark: config({ opacity: 0.5 }) }));
    const { r, g } = pixel(info.width - MARGIN - WM_WIDTH / 2, info.height - MARGIN - WM_HEIGHT / 2);
    assert.ok(r > 230 && g > 100 && g < 160);
});

test('a grayscale watermark (1 band, 2 with alpha) is supported', async () => {
    const gray = await sharp(Buffer.alloc(WM_WIDTH * WM_HEIGHT), { raw: { width: WM_WIDTH, height: WM_HEIGHT, channels: 1 } })
        .toColourspace('b-w').png().toBuffer();
    assert.equal((await sharp(gray).metadata()).channels, 1);
    const { info, pixel } = await decode(await buildPreview(originalBuffer, { watermark: config({ image: gray }) }));
    const { r, g, b } = pixel(info.width - MARGIN - WM_WIDTH / 2, info.height - MARGIN - WM_HEIGHT / 2);
    assert.ok(r < 40 && g < 40 && b < 40);
});

test('watermark: false leaves the picture untouched', async () => {
    const { info, pixel } = await decode(await buildPreview(originalBuffer, { watermark: false }));
    assert.ok(isWhite(pixel(info.width - MARGIN - 50, info.height - MARGIN - 20)));
});

test('generateDerivedImages does not read the settings when watermark is false', async () => {
    loadSavedCalls = 0;
    putObjects = [];
    await generateDerivedImages('uploads/c/x.jpg', { watermark: false });
    assert.equal(loadSavedCalls, 0);
    assert.deepEqual(putObjects.sort(), ['uploads/c/x-preview.jpg', 'uploads/c/x-thumb.jpg']);
});

test('generateDerivedImages reads the saved settings when watermark is true', async () => {
    loadSavedCalls = 0;
    nextConfig = config();
    await generateDerivedImages('uploads/c/x.jpg', { watermark: true });
    assert.equal(loadSavedCalls, 1);
});

test('the thumbnail carries the watermark, scaled down with the image', async () => {
    putBodies = {};
    nextConfig = config({ size: 20 });
    await generateDerivedImages('uploads/c/x.jpg', { watermark: true });
    const { info, pixel } = await decode(putBodies['uploads/c/x-thumb.jpg']);
    assert.equal(info.width, 400);
    // size 20 % de 1200 = 240 px dans la preview -> 80 px dans la thumbnail ; marge 24 -> 8 px
    const x = info.width - 8 - 40;
    const y = info.height - 8 - 13;
    assert.ok(isRed(pixel(x, y)));
});

test('the thumbnail has no watermark when watermark is false', async () => {
    putBodies = {};
    await generateDerivedImages('uploads/c/x.jpg', { watermark: false });
    const { info, pixel } = await decode(putBodies['uploads/c/x-thumb.jpg']);
    assert.ok(isWhite(pixel(info.width - 8 - 40, info.height - 8 - 13)));
});

// A phone's portrait photo: landscape pixels (left half red, right half blue) + EXIF
// Orientation=6 ("rotate 90° clockwise to display"). Displayed upright it is portrait,
// with the red half on top.
const portraitWithExifOrientation = (width, height) => sharp({ create: { width, height, channels: 3, background: '#0000ff' } })
    .composite([{ input: { create: { width: width / 2, height, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .toBuffer();

test('buildPreview applies the EXIF orientation: a portrait photo stays portrait, upright', async () => {
    const source = await portraitWithExifOrientation(600, 400);
    assert.equal((await sharp(source).metadata()).orientation, 6);
    const { info, pixel } = await decode(await buildPreview(source, { watermark: false }));
    assert.equal(info.width, 400); // 400x600 once rotated, not enlarged
    assert.equal(info.height, 600);
    assert.ok(isRed(pixel(200, 100)), 'the red half must be on top');
    assert.ok(pixel(200, 500).b > 200 && pixel(200, 500).r < 60, 'the blue half must be at the bottom');
});

test('a large portrait photo is resized on its displayed width (1200 x 1800)', async () => {
    const source = await portraitWithExifOrientation(3000, 2000);
    const { info } = await decode(await buildPreview(source, { watermark: false }));
    assert.equal(info.width, 1200);
    assert.equal(info.height, 1800);
});

test('generateDerivedImages: the preview and the thumbnail of a portrait photo are upright', async () => {
    putBodies = {};
    nextOriginal = await portraitWithExifOrientation(3000, 2000);
    try {
        await generateDerivedImages('uploads/c/portrait.jpg', { watermark: false });
    } finally {
        nextOriginal = null;
    }
    const preview = await decode(putBodies['uploads/c/portrait-preview.jpg']);
    assert.deepEqual([preview.info.width, preview.info.height], [1200, 1800]);
    assert.ok(isRed(preview.pixel(600, 300)));
    const thumb = await decode(putBodies['uploads/c/portrait-thumb.jpg']);
    assert.deepEqual([thumb.info.width, thumb.info.height], [400, 600]);
    assert.ok(isRed(thumb.pixel(200, 100)));
});

test('a photo without EXIF orientation is left as it is', async () => {
    const { info } = await decode(await buildPreview(originalBuffer, { watermark: false }));
    assert.deepEqual([info.width, info.height], [1200, 800]);
});

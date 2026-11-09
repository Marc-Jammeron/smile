import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Must be set before the service (and src/config/limits.js) is imported: 1 Mpx ceiling.
process.env.MAX_INPUT_PIXELS = '1000000';

let currentOriginal = null;
let putBodies = {};

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        getObject: async () => currentOriginal,
        putObject: async (key, body) => { putBodies[key] = body; return key; },
    },
});
mock.module('../src/services/settings.service.js', {
    namedExports: {
        validateWatermarkValues: async (values) => values,
        loadSavedWatermarkValues: async () => ({}),
        buildWatermarkConfig: async () => { throw new Error('settings must not be read when a config is given'); },
    },
});

const { buildPreview, generateDerivedImages } = await import('../src/services/image-processing.service.js');

const decode = async (jpeg) => {
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => {
        const i = (y * info.width + x) * info.channels;
        return { r: data[i], g: data[i + 1], b: data[i + 2] };
    };
    return { info, pixel };
};
const isRed = ({ r, g, b }) => r > 200 && g < 70 && b < 70;
const isBlue = ({ r, g, b }) => b > 200 && r < 70 && g < 70;
const isGreen = ({ r, g, b }) => g > 200 && r < 70 && b < 70;

// 1000x600 stored pixels: left half red, right half blue.
const redBlueLandscape = async (jpegOptions = {}, metadata) => {
    const red = await sharp({ create: { width: 500, height: 600, channels: 3, background: '#ff0000' } }).png().toBuffer();
    let image = sharp({ create: { width: 1000, height: 600, channels: 3, background: '#0000ff' } }).composite([{ input: red, left: 0, top: 0 }]);
    if (metadata) image = image.withMetadata(metadata);
    return image.jpeg({ quality: 95, ...jpegOptions }).toBuffer();
};

const greenWatermark = {
    image: await sharp({ create: { width: 100, height: 40, channels: 4, background: '#00ff00' } }).png().toBuffer(),
    position: 'southeast', opacity: 1, size: null, margin: 24,
};

test('EXIF orientation 6 (portrait shot): the preview is upright, not sideways', async () => {
    const original = await redBlueLandscape({}, { orientation: 6 });
    assert.equal((await sharp(original).metadata()).orientation, 6);

    const { info, pixel } = await decode(await buildPreview(original, { watermark: false }));

    // Stored 1000x600, displayed 600x1000: smaller than the 1200 preview width, not enlarged.
    assert.equal(info.width, 600);
    assert.equal(info.height, 1000);
    // Orientation 6 = rotate 90 degrees clockwise to display: the stored left half ends up on top.
    assert.ok(isRed(pixel(300, 100)), 'top should be red');
    assert.ok(isBlue(pixel(300, 900)), 'bottom should be blue');
});

test('EXIF orientation 6: the watermark stays intact, unrotated and anchored to the upright image corner', async () => {
    const original = await redBlueLandscape({}, { orientation: 6 });

    const { info, pixel } = await decode(await buildPreview(original, { watermark: greenWatermark }));

    assert.equal(info.width, 600);
    assert.equal(info.height, 1000);
    const left = 600 - 100 - 24;
    const top = 1000 - 40 - 24;
    // 100 wide x 40 tall (not 40 x 100), at the bottom-right of the UPRIGHT image.
    assert.ok(isGreen(pixel(left + 5, top + 5)));
    assert.ok(isGreen(pixel(left + 94, top + 34)));
    assert.ok(!isGreen(pixel(left - 6, top + 20)));
    assert.ok(!isGreen(pixel(left + 50, top - 6)));
    assert.ok(!isGreen(pixel(left + 50, top + 46)));
});

test('a photo without an orientation tag keeps its landscape layout', async () => {
    const { info, pixel } = await decode(await buildPreview(await redBlueLandscape(), { watermark: false }));
    assert.equal(info.width, 1000);
    assert.equal(info.height, 600);
    assert.ok(isRed(pixel(100, 300)));
    assert.ok(isBlue(pixel(900, 300)));
});

test('the thumbnail derived from an oriented preview is portrait too', async () => {
    currentOriginal = await redBlueLandscape({}, { orientation: 6 });
    putBodies = {};
    await generateDerivedImages('uploads/c/portrait.jpg', { watermark: false, originalSize: currentOriginal.length });
    const { info } = await decode(putBodies['uploads/c/portrait-thumb.jpg']);
    assert.equal(info.width, 400);
    assert.ok(info.height > info.width);
});

test('a grayscale JPEG is processed (3-channel preview, no channel mix-up)', async () => {
    const gray = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#808080' } }).toColourspace('b-w').jpeg().toBuffer();
    assert.equal((await sharp(gray).metadata()).channels, 1);
    const { info, pixel } = await decode(await buildPreview(gray, { watermark: false }));
    assert.equal(info.width, 800);
    const { r, g, b } = pixel(400, 200);
    assert.ok(Math.abs(r - 128) < 12 && Math.abs(g - 128) < 12 && Math.abs(b - 128) < 12, `${r},${g},${b}`);
});

test('a CMYK JPEG is converted, not read back as RGBA', async () => {
    const cmyk = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#ff0000' } }).toColourspace('cmyk').jpeg().toBuffer();
    assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');
    const { info, pixel } = await decode(await buildPreview(cmyk, { watermark: false }));
    assert.equal(info.width, 800);
    assert.ok(isRed(pixel(400, 200)) || (pixel(400, 200).r > 180 && pixel(400, 200).g < 90), JSON.stringify(pixel(400, 200)));
});

test('a truncated JPEG is refused (failOn warning), not rendered with a grey band', async () => {
    const noisy = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#000000', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
        .jpeg({ quality: 90 }).toBuffer();
    const truncated = noisy.subarray(0, Math.floor(noisy.length * 0.6));
    await assert.rejects(() => buildPreview(truncated, { watermark: false }));
});

test('an image above MAX_INPUT_PIXELS is refused, one below is processed', async () => {
    const tooBig = await sharp({ create: { width: 1200, height: 1000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer(); // 1.2 Mpx
    await assert.rejects(() => buildPreview(tooBig, { watermark: false }), /pixel limit/i);

    const fine = await sharp({ create: { width: 1000, height: 900, channels: 3, background: '#ffffff' } }).jpeg().toBuffer(); // 0.9 Mpx
    const { info } = await decode(await buildPreview(fine, { watermark: false }));
    assert.equal(info.width, 1000);
});

test('generateDerivedImages uses a shared watermark config and the given original size', async () => {
    currentOriginal = await redBlueLandscape();
    putBodies = {};
    const keys = await generateDerivedImages('uploads/c/x.jpg', { watermark: true, watermarkConfig: greenWatermark, originalSize: currentOriginal.length });
    assert.deepEqual(keys, { thumbnailKey: 'uploads/c/x-thumb.jpg', previewKey: 'uploads/c/x-preview.jpg' });
    const { info, pixel } = await decode(putBodies['uploads/c/x-preview.jpg']);
    assert.equal(info.width, 1000);
    assert.ok(isGreen(pixel(1000 - 24 - 50, 600 - 24 - 20)));
});

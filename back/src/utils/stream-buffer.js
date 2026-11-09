import { Buffer } from 'node:buffer';

// Collects a stream into ONE Buffer. When the final size is known (S3 ContentLength) the
// buffer is allocated once and filled in place: peak memory is 1x the object instead of
// ~2x (all the chunks plus the Buffer.concat copy). Without a size it falls back to concat.
// `allocUnsafe` is safe here because the buffer is only returned once every byte was written.
export const collectToBuffer = async (stream, expectedLength) => {
    if (!Number.isInteger(expectedLength) || expectedLength < 0) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    const buffer = Buffer.allocUnsafe(expectedLength);
    let offset = 0;
    for await (const chunk of stream) {
        if (offset + chunk.length > expectedLength) {
            throw new Error(`Stream returned more bytes than announced (${expectedLength})`);
        }
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    if (offset !== expectedLength) {
        throw new Error(`Stream ended early: received ${offset} of ${expectedLength} bytes`);
    }
    return buffer;
};

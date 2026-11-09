import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Buffer } from "node:buffer";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { collectToBuffer } from "../utils/stream-buffer.js";
import { SIGNED_URL_TTL_SECONDS } from "../config/signed-urls.js";
import logger from "../logger.js";

const log = logger.child("s3");

const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,       // undefined en prod = AWS SDK utilise l'endpoint AWS par défaut
    region: process.env.S3_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true", // true en local/MinIO, false/absent en prod AWS
});

const BUCKET = process.env.S3_BUCKET;

log.info("S3 client configured", {
    endpoint: process.env.S3_ENDPOINT || "(aws default)",
    region: process.env.S3_REGION || "us-east-1",
    bucket: BUCKET,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
});
if (!BUCKET) {
    log.error("S3_BUCKET is not set: every storage operation will fail");
}
if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    log.warn("S3 credentials are incomplete (S3_ACCESS_KEY / S3_SECRET_KEY)");
}

const getSignedPutUrl = (key, contentType) => {
    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
    });

    log.debug("Signing upload url", { key, contentType });
    return getSignedUrl(s3, command, { expiresIn: SIGNED_URL_TTL_SECONDS.upload });
};

const getSignedUploadUrl = async (collectionId, filename, contentType) => {
    const key = `uploads/${collectionId}/${randomUUID()}-${filename}`;
    const url = await getSignedPutUrl(key, contentType);
    return { url, key };
};

// Distinct path prefix from getSignedUploadUrl (`uploads/`) so attachment keys
// can never collide with a Photo's own key.
const getSignedAttachmentUploadUrl = async (collectionId, filename, contentType) => {
    const key = `attachments/${collectionId}/${randomUUID()}-${filename}`;
    const url = await getSignedPutUrl(key, contentType);
    return { url, key };
};

const getSignedBrandingUploadUrl = async (kind, contentType) => {
    const key = `branding/${kind}/raw/${randomUUID()}`;
    const url = await getSignedPutUrl(key, contentType);
    return { url, key };
};

const getSignedDownloadUrl = async (key, { expiresIn = SIGNED_URL_TTL_SECONDS.default } = {}) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    log.debug("Signing download url", { key, expiresIn });
    const url = await getSignedUrl(s3, command, { expiresIn });
    return url;
};

const getObject = async (key) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    const { Body, ContentLength } = await s3.send(command);
    const buffer = await collectToBuffer(Body, ContentLength);
    log.debug("Object downloaded", { key, bytes: buffer.length });
    return buffer;
};

const getObjectStream = async (key) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    const { Body } = await s3.send(command);
    log.debug("Object stream opened", { key });
    return Body;
};

const putObject = async (key, body, contentType) => {
    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
    });

    await s3.send(command);
    log.debug("Object stored", { key, contentType, bytes: Buffer.isBuffer(body) ? body.length : undefined });
    return key;
};

const objectExists = async (key) => {
    const command = new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    try {
        await s3.send(command);
        log.debug("Object exists", { key });
        return true;
    } catch (error) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            log.debug("Object not found", { key });
            return false;
        }
        log.error("Could not check object existence", error, { key });
        throw error;
    }
};

const headObject = async (key) => {
    const command = new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    try {
        const { ContentLength, ContentType } = await s3.send(command);
        log.debug("Object head", { key, size: ContentLength, contentType: ContentType });
        return { size: ContentLength, contentType: ContentType };
    } catch (error) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            log.debug("Object not found", { key });
            return null;
        }
        log.error("Could not read object metadata", error, { key });
        throw error;
    }
};

const deleteObject = async (key) => {
    const command = new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    try {
        await s3.send(command);
        log.debug("Object deleted", { key });
        return true;
    } catch (error) {
        log.error("Could not delete object", error, { key });
        throw error;
    }
};

const deleteByPrefix = async (prefix) => {
    if (!prefix) {
        log.error("deleteByPrefix called with an empty prefix, refusing");
        throw new Error('deleteByPrefix requires a non-empty prefix');
    }

    let deleted = 0;
    let continuationToken;
    do {
        const { Contents = [], IsTruncated, NextContinuationToken } = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }));

        if (Contents.length > 0) {
            const { Errors = [] } = await s3.send(new DeleteObjectsCommand({
                Bucket: BUCKET,
                Delete: { Objects: Contents.map(({ Key }) => ({ Key })), Quiet: true },
            }));
            if (Errors.length > 0) {
                log.error("Bulk delete partially failed", { prefix, failed: Errors.length, firstError: Errors[0].Message });
                throw new Error(`Failed to delete ${Errors.length} object(s) under prefix ${prefix}: ${Errors[0].Message}`);
            }
            deleted += Contents.length;
        }

        continuationToken = IsTruncated ? NextContinuationToken : undefined;
    } while (continuationToken);

    log.debug("Objects deleted by prefix", { prefix, deleted });
    return deleted;
};

const s3Repository = {
    getSignedUploadUrl,
    getSignedAttachmentUploadUrl,
    getSignedBrandingUploadUrl,
    getSignedDownloadUrl,
    getObject,
    getObjectStream,
    putObject,
    objectExists,
    headObject,
    deleteObject,
    deleteByPrefix
};

export default s3Repository;
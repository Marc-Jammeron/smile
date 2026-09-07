import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from "node:buffer";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuid } from "uuid";

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

const getSignedUploadUrl = async (collectionId, filename, contentType) => {
    const key = `uploads/${collectionId}/${uuid()}-${filename}`;

    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return { url, key };
};

// Distinct path prefix from getSignedUploadUrl (`uploads/`) so attachment keys
// can never collide with a Photo's own key.
const getSignedAttachmentUploadUrl = async (collectionId, filename, contentType) => {
    const key = `attachments/${collectionId}/${uuid()}-${filename}`;

    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return { url, key };
};

const getSignedDownloadUrl = async (key) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return url;
};

const getObject = async (key) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    const { Body } = await s3.send(command);
    const chunks = [];
    for await (const chunk of Body) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

const getObjectStream = async (key) => {
    const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    const { Body } = await s3.send(command);
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
    return key;
};

const objectExists = async (key) => {
    const command = new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
    });

    try {
        await s3.send(command);
        return true;
    } catch (error) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            return false;
        }
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
        return true;
    } catch (error) {
        console.error(`Error deleting object with key ${key}:`, error);
        throw error;
    }
};

const s3Repository = {
    getSignedUploadUrl,
    getSignedAttachmentUploadUrl,
    getSignedDownloadUrl,
    getObject,
    getObjectStream,
    putObject,
    objectExists,
    deleteObject
};

export default s3Repository;
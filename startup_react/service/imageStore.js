import fs from 'fs';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

// S3 image storage is optional: without s3Bucket/s3Region in dbConfig.json the
// admin UI falls back to pasting image URLs.
let bucket = null;
let region = null;
try {
  const config = JSON.parse(fs.readFileSync(new URL('./dbConfig.json', import.meta.url)));
  bucket = config.s3Bucket || null;
  region = config.s3Region || null;
} catch {
  // dbConfig.json missing entirely is handled (fatally) by database.js
}

const extensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Credentials come from the SDK default chain: aws configure locally,
// the EC2 instance role in production.
const s3 = bucket ? new S3Client({ region }) : null;

export function imagesConfigured() {
  return Boolean(s3);
}

export function isValidImageType(contentType) {
  // hasOwn, not `in`, so prototype keys like "constructor" aren't accepted.
  return typeof contentType === 'string' && Object.hasOwn(extensions, contentType);
}

export async function createUploadUrl(contentType) {
  const key = `images/${uuidv4()}.${extensions[contentType]}`;
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  return { uploadUrl, publicUrl };
}

// Best-effort removal of a quiz image that lives in our bucket.
export async function deleteImage(imageUrl) {
  if (!s3 || !imageUrl) return;
  // Only ever delete keys this service uploaded.
  const prefix = `https://${bucket}.s3.${region}.amazonaws.com/images/`;
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith(prefix)) return;
  const key = `images/${imageUrl.slice(prefix.length)}`;
  if (key.includes('..')) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.log(`Failed to delete image ${imageUrl}: ${err.message}`);
  }
}

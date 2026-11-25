import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION });

export async function uploadImage(key: string, body: Uint8Array) {
  try {
    await s3.send(new PutObjectCommand({ Bucket: 'demo-store-assets', Key: key, Body: body }));
  } catch (err) {
    console.error('upload failed', err);
    throw err;
  }
}

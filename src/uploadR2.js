import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// blog-bot/trend-cardnews와 같은 R2 버킷을 공유해서 쓴다. 오브젝트 키는 "kodak-frame-editor/..."
// 프리픽스로 시작해 다른 앱과 경로 충돌을 막는다 (/app/DEVELOPMENT.md 참고).
function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function uploadToR2(buffer, key, contentType) {
  const bucket = process.env.R2_BUCKET_NAME;
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (!bucket || !publicBase) {
    throw new Error('R2_BUCKET_NAME / R2_PUBLIC_URL 환경변수가 필요합니다.');
  }
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
  );
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${publicBase}/${encodedKey}`;
}

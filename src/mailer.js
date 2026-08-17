import nodemailer from 'nodemailer';

// 한 이메일에 너무 많은 사진을 첨부하면 SMTP/수신 게이트웨이 용량 제한에 걸릴 수 있어, 총
// 첨부 용량 기준으로 여러 통으로 쪼갠다(그릴링 세션에서 결정 — 장수가 아니라 용량 기준).
const DEFAULT_BATCH_MAX_BYTES = 20 * 1024 * 1024; // 20MB
// 용량과 별개로 장수 자체도 제한한다. 코닥 액자 쪽 안내(사용자가 직접 조사한 자료 — 코닥
// 공식 1차 문서는 아니고 조사 도구의 요약이라 100% 확정은 아님, DECISIONS.md 참고)에 따르면
// 이메일 한 통에 10장 이상 넣으면 일부 사진이 누락/지연될 수 있다고 함. 용량 기준만 쓰면
// 사진이 작을 때 한 통에 훨씬 많은 장수가 들어갈 수 있어서, 둘 중 먼저 걸리는 조건으로 나눈다.
const DEFAULT_BATCH_MAX_COUNT = 9;

function splitIntoBatches(photos, maxBytes, maxCount) {
  const batches = [];
  let current = [];
  let currentSize = 0;

  for (const photo of photos) {
    // 사진 한 장이 단독으로 용량 한도를 넘어도 별도 배치로 보낸다(누락시키지 않음).
    const wouldExceedBytes = currentSize > 0 && currentSize + photo.buffer.length > maxBytes;
    const wouldExceedCount = current.length >= maxCount;
    if (wouldExceedBytes || wouldExceedCount) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(photo);
    currentSize += photo.buffer.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_SERVER,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SENDER_EMAIL,
      pass: process.env.SENDER_PASSWORD,
    },
  });
}

// photos: [{ filename, buffer, contentType }]
// 반환: [{ batchIndex, count, ok, error? }]
export async function sendPhotosToFrame(photos, frameAddress = process.env.FRAME_EMAIL) {
  if (!frameAddress) throw new Error('보낼 액자 주소가 없습니다.');

  const maxBytes = Number(process.env.MAIL_BATCH_MAX_BYTES || DEFAULT_BATCH_MAX_BYTES);
  const maxCount = Number(process.env.MAIL_BATCH_MAX_COUNT || DEFAULT_BATCH_MAX_COUNT);
  const batches = splitIntoBatches(photos, maxBytes, maxCount);
  const transport = buildTransport();

  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      await transport.sendMail({
        from: process.env.SENDER_EMAIL,
        to: frameAddress,
        subject: `사진 업로드 (${batch.length}장, ${i + 1}/${batches.length})`,
        text: '디지털액자 자동 업로드용 메일입니다.',
        attachments: batch.map((p) => ({
          filename: p.filename,
          content: p.buffer,
          contentType: p.contentType,
        })),
      });
      results.push({ batchIndex: i, count: batch.length, ok: true });
    } catch (err) {
      results.push({ batchIndex: i, count: batch.length, ok: false, error: err.message });
    }
  }
  return results;
}

import './netfix.js';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { uploadToR2 } from './uploadR2.js';
import { sendPhotosToFrame } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8003;

// 크롭 결과물(메모리 버퍼)만 다룬다 — 디스크에 절대 쓰지 않는다. 요청이 끝나면 버퍼는
// 그냥 GC 대상이 되고, R2에 올라간 사본이 유일하게 남는 기록이다 (그릴링 세션 결정:
// 원본 미저장, 편집 결과물만 kodakframe/<날짜>/ 로 영구 보관).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 60 },
});

app.use(express.static(path.join(__dirname, '..', 'public')));
// Cropper.js/heic2any는 번들러 없이 node_modules의 빌드 산출물을 그대로 서빙한다(외부 CDN
// 의존 없이, npm으로 버전 관리만 하는 가장 가벼운 방법).
app.use(
  '/vendor/cropperjs',
  express.static(path.join(__dirname, '..', 'node_modules', 'cropperjs', 'dist')),
);
app.use(
  '/vendor/heic2any',
  express.static(path.join(__dirname, '..', 'node_modules', 'heic2any', 'dist')),
);

function safeFilename(name) {
  return (name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

// 코닥 액자 이메일 주소는 "<액자번호>@mx1.kodakframes.com" 형태로 도메인이 항상 같다.
// 그래서 사용자에게는 앞의 숫자만 입력받고, 도메인은 여기서 붙인다.
//
// 중요: 도메인을 클라이언트에서 받지 않고 서버 상수로 박아두는 게 핵심 안전장치다. 받는
// 주소 전체를 입력받게 만들면 로그인 없는 이 앱이 "아무 주소로나 이미지를 보내주는 공개
// 스팸 발송기"가 되고, 그 발송이 우리 Gmail 계정으로 나가서 계정이 정지될 수 있다. 숫자만
// 받으면 코닥 액자 외의 주소로는 애초에 보낼 방법이 없다.
const FRAME_EMAIL_DOMAIN = 'mx1.kodakframes.com';

function frameAddressFromId(frameId) {
  const id = String(frameId || '').trim();
  if (!/^\d{4,16}$/.test(id)) return null;
  return `${id}@${FRAME_EMAIL_DOMAIN}`;
}

// 발송량 제한(IP당 하루 기준). 도메인이 고정이라 스팸 발송기로 쓰일 여지는 없지만, 한
// 사람이 계정 발송 한도를 다 태워버리면 다른 사람이 못 쓰게 되므로 최소한의 상한을 둔다.
const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PHOTOS_PER_DAY || 300);
const rateBuckets = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip, count) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count, resetAt: now + 24 * 60 * 60 * 1000 });
    return { ok: true };
  }
  if (bucket.count + count > RATE_LIMIT_PER_DAY) {
    return { ok: false, retryAt: bucket.resetAt };
  }
  bucket.count += count;
  return { ok: true };
}

// 메모리에 무한정 쌓이지 않게 만료된 항목을 주기적으로 치운다.
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(ip);
  },
  60 * 60 * 1000,
).unref();

// R2 저장 목적은 "액자 오류로 초기화됐을 때 사람이 직접 R2 콘솔에서 골라 재업로드"하는 것이라,
// 폴더(날짜별 prefix)로 나누지 않고 kodak/ 밑에 통째로 펼쳐서 한 번에 훑어보고 받을 수 있게
// 한다. 대신 파일명 맨 앞에 KST 기준 YYYYMMDDHHmm를 붙여 시간순 정렬/식별이 되게 한다.
function kstTimestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}`;
}

app.post('/api/send', upload.array('photos', 60), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: '보낼 사진이 없습니다.' });
  }

  const frameAddress = frameAddressFromId(req.body?.frameId);
  if (!frameAddress) {
    return res.status(400).json({
      error: '액자 번호를 숫자로 입력해 주세요 (액자 이메일 주소의 @ 앞부분).',
    });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = checkRateLimit(ip, files.length);
  if (!limit.ok) {
    return res.status(429).json({
      error: `하루 발송 한도(${RATE_LIMIT_PER_DAY}장)를 넘었습니다. 내일 다시 시도해 주세요.`,
    });
  }

  const ts = kstTimestamp();
  const photos = files.map((f, i) => ({
    filename: `${i + 1}-${safeFilename(f.originalname)}`,
    buffer: f.buffer,
    contentType: f.mimetype || 'image/jpeg',
  }));

  // 업로드를 받은 즉시 응답하고, R2 백업 + 이메일 발송(사진이 많으면 여러 통으로 나뉨)은
  // 응답 이후 백그라운드에서 계속 진행한다. 실사용 버그: 사진이 많을 때(예: 30장, 이메일
  // 4통) 이 작업이 다 끝날 때까지 응답을 기다리게 했더니, 실제로는 다 성공했는데도 Nginx
  // Proxy Manager의 응답 대기 시간(기본 60초 안팎)을 넘겨버려서 브라우저엔 504 "전송
  // 실패"로 뜨는 거짓 실패가 발생했다(ISSUES.md 참고, 보낸메일함으로 실제 성공 확인함).
  // 응답을 업로드 접수 시점으로 앞당기면 처리 시간과 무관하게 항상 몇 초 안에 끝난다.
  res.json({ ok: true, accepted: photos.length });

  (async () => {
    // R2 백업 업로드는 이메일 발송과 별개(실패해도 발송은 계속 진행) — 액자에 문제가 생겼을
    // 때 사람이 R2에서 직접 골라 재업로드하기 위한 용도(재업로드 자체는 자동화하지 않음).
    const r2Results = await Promise.allSettled(
      photos.map((p) => uploadToR2(p.buffer, `kodak/${ts}_${p.filename}`, p.contentType)),
    );
    const r2Failures = r2Results.filter((r) => r.status === 'rejected').length;
    if (r2Failures > 0) {
      console.error(`R2 업로드 실패 ${r2Failures}/${photos.length}건`, r2Results);
    }

    try {
      const mailResults = await sendPhotosToFrame(photos, frameAddress);
      const failed = mailResults.filter((r) => !r.ok);
      if (failed.length > 0) {
        console.error(`일부 이메일 발송 실패 (수신: ${frameAddress})`, failed);
      } else {
        console.log(
          `이메일 발송 완료: 사진 ${photos.length}장, ${mailResults.length}통, 수신 ${frameAddress}`,
        );
      }
    } catch (err) {
      console.error('메일 발송 오류', err);
    }
  })();
});

app.listen(PORT, () => {
  console.log(`kodak-frame-editor listening on :${PORT}`);
});

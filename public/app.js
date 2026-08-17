(() => {
  // "나란히 2장 배치" 레이아웃(2026-08-16 재설계).
  //
  // 예전 방식: 사진을 아주 좁은 비율(전체의 46%)로 "잘라서" 두 장을 붙였다. 인생네컷처럼
  // 원본이 그보다 넓으면 좌우가 잘려나갔고, 잘리지 않게 하려고 위아래 배경을 두는 "너비 맞춤"을
  // 쓰면 크롭 영역이 이미지 밖으로 나가면서 iOS Safari에서 세로로 늘어나는 버그를 밟았다.
  //
  // 새 방식: 전체(1000×1600)를 좌우 반반(각 500×1600)으로 나누고, 각 슬롯 안에 사진을
  // "자르지 않고" 통째로 넣는다(contain). 좌우에 약간의 여백을 두고 가운데 정렬하며, 남는
  // 자리는 배경색으로 채운다. 크롭이 전혀 없으므로 비율이 바뀔 일도, 사진이 잘릴 일도 없다.
  // 여백은 반쪽 슬롯 폭 기준 — 4%면 500 중 좌우 20px씩이라, 가운데는 두 슬롯의 여백이 만나
  // 자연스럽게 40px 거터가 되고 바깥쪽은 20px이 된다.
  const DUP_INNER_MARGIN_FRACTION = 0.04;
  const JPEG_QUALITY = 0.92;
  const DEFAULT_BG = '#000000';
  // 편집 중(Cropper에 물리는 이미지)에는 이 크기로 다운스케일한 미리보기만 메모리에 둔다.
  // 실제 전송용 결과물은 "전송" 시점에 원본을 그때그때 다시 불러와 만든다 — 24장을 한꺼번에
  // 올렸을 때 탭이 크래시하던 문제(ISSUES.md 버그 #7)의 근본 원인이 "편집 화면에 동시에
  // 떠 있는 카드 전부가 원본 해상도를 계속 메모리에 물고 있는 것"이었기 때문.
  const PREVIEW_MAX_DIM = 1280;
  // 자유 모드에서 사진을 프레임보다 훨씬 작게(예: 5%) 축소해두면, "이미지 대비 비율"로 계산한
  // 크롭 영역이 원본보다 훨씬 커진다(배경이 많이 드러날수록 크롭 박스가 상대적으로 이미지보다
  // 커지기 때문) — 이걸 그대로 원본 해상도에 곱하면 결과물이 비정상적으로 거대해진다(실제로
  // 테스트 중 4574x7312 = 3300만 픽셀짜리 출력을 만들어낸 걸 발견). 최종 출력의 긴 변을 이
  // 값 이하로 캡 씌운다 — 일반적인 커버 핏(원본 해상도 그대로)은 이 캡보다 한참 작아서 전혀
  // 영향받지 않고, 극단적으로 축소한 경우에만 다운스케일된다.
  const MAX_OUTPUT_DIM = 6000;
  // 최종 결과물의 긴 변을 액자 패널 해상도에 맞춘다(2026-08-17 추가).
  //
  // 액자 패널은 1920×1200(FHD) 또는 1280×800이다. 지금까지는 원본 해상도를 그대로 보내고
  // 축소는 액자에 맡겼는데("크롭 방식: 해상도는 원본 유지" 결정), 인생네컷을 보냈더니 액자
  // 화면에서만 유독 흐리다는 실사용 피드백이 나왔다(파일 자체는 선명함). 거울모드 결과물은
  // 한 장에 컷이 8개(4컷 스트립 × 좌우 2벌) 들어가 3592×5746(20MP)까지 커지는데, 이걸
  // 액자가 1/3로 줄이면서 내장 스케일러 품질이 그대로 드러난 것으로 보인다.
  //
  // 그래서 축소를 액자에 맡기지 않고 브라우저에서 고품질로 미리 해서 보낸다 — 액자가 추가로
  // 손댈 게 없어진다. 1920이면 두 패널 모델 다 커버한다. 부수 효과로 첨부 용량이 크게 줄어
  // 메일 분할도 덜 일어난다.
  const FRAME_TARGET_LONG_DIM = 1920;
  // 인생네컷/포토부스 스트립처럼 세로로 아주 좁고 긴 사진으로 추정하는 기준(가로/세로).
  // 일반적인 스마트폰 세로 사진(9:16=0.5625)보다는 확실히 좁아야 하므로 그보다 낮게 잡음.
  const LIFE4CUT_ASPECT_THRESHOLD = 0.45;

  // 세로(1000×1600)/가로(1600×1000) 두 모드를 상단 토글로 선택한다(실사용 요청). 액자
  // 패널을 물리적으로 돌려서 쓰는 경우 대응 — 가로는 세로 규격을 그대로 90도 돌린 값.
  let frameMode = 'portrait';
  function getCropAspect() {
    return frameMode === 'landscape' ? 1600 / 1000 : 1000 / 1600;
  }
  // 거울모드에서 사진 한 장이 들어가는 반쪽 슬롯의 비율(세로: 500/1600, 가로: 800/1000).
  function getHalfSlotAspect() {
    return getCropAspect() / 2;
  }
  function getAspectCss() {
    return frameMode === 'landscape' ? '1600 / 1000' : '1000 / 1600';
  }

  const els = {
    fileInput: document.getElementById('file-input'),
    fileInput2: document.getElementById('file-input-2'),
    subtitle: document.getElementById('subtitle'),
    modeButtons: document.querySelectorAll('.mode-btn'),
    stepSelect: document.getElementById('step-select'),
    stepEdit: document.getElementById('step-edit'),
    stepReview: document.getElementById('step-review'),
    stepDone: document.getElementById('step-done'),
    cardList: document.getElementById('card-list'),
    toReviewBtn: document.getElementById('to-review-btn'),
    reviewGrid: document.getElementById('review-grid'),
    reviewSummary: document.getElementById('review-summary'),
    backToEditBtn: document.getElementById('back-to-edit-btn'),
    sendBtn: document.getElementById('send-btn'),
    frameId: document.getElementById('frame-id'),
    frameIdError: document.getElementById('frame-id-error'),
    doneMessage: document.getElementById('done-message'),
    restartBtn: document.getElementById('restart-btn'),
    toast: document.getElementById('toast'),
    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightbox-img'),
    lightboxClose: document.getElementById('lightbox-close'),
    lightboxEdit: document.getElementById('lightbox-edit'),
    photoCountStatus: document.getElementById('photo-count-status'),
    addMoreLabel: document.getElementById('add-more-label'),
    addMoreLimitNote: document.getElementById('add-more-limit-note'),
  };

  let seq = 0;
  // id -> { cropper, imgEl, cardEl, viewportEl, objectUrls, bgColor, duplicate, edgeColors }
  const photos = new Map();
  let pendingLoads = 0;
  let lastCroppedBlobs = null; // [{filename, blob}] set in review step

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.add('hidden'), 3500);
  }

  function showStep(step) {
    for (const s of [els.stepSelect, els.stepEdit, els.stepReview, els.stepDone]) {
      s.classList.toggle('hidden', s !== step);
    }
  }

  function isHeic(file) {
    return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  }

  // 스마트폰 세로 사진은 대부분 EXIF Orientation 태그로 "90도 돌려서 보여줘"라고만 표시하고,
  // 실제 픽셀은 가로로 저장돼 있다. Cropper.js는 imageData.naturalWidth/naturalHeight를 그
  // "돌리기 전" 원본 기준으로 주고 rotate 필드로 회전값을 따로 알려주는데, 우리 fitCanvas가
  // naturalWidth/naturalHeight를 그대로(회전 무시하고) 화면상 가로/세로로 오해해서 비율을
  // 계산하면 배율이 완전히 틀어져 사진이 과도하게 확대되고 잘려나가는 버그가 있었다("특정
  // 사진만 높이 맞춤이 안 됨" 실사용 리포트 — 알고 보니 그 사진만 EXIF 회전 태그가 있었음).
  // 90도/270도 회전이면 화면에 보이는 가로세로가 뒤바뀌므로 여기서 미리 바꿔준다.
  function effectiveNaturalSize(imageData) {
    const swapped = Math.abs(imageData.rotate % 180) === 90;
    return swapped
      ? { width: imageData.naturalHeight, height: imageData.naturalWidth }
      : { width: imageData.naturalWidth, height: imageData.naturalHeight };
  }

  // 크기를 맞추고 크롭 박스 중앙에 재배치한다. zoomTo()는 "현재 캔버스 위치"를 기준으로 크기만
  // 바꾸기 때문에, 사용자가 많이 축소한 채로 이미지를 크롭 박스 밖까지 드래그해둔 상태에서는
  // 크기를 아무리 맞춰도 이미지가 크롭 박스 밖에 그대로 남아 "안 먹힌 것처럼" 보이는 버그가
  // 있었다(실사용 버그 리포트). setCanvasData로 위치까지 직접 계산해서 항상 중앙에 오게 한다.
  function fitCanvas(cropper, mode) {
    const imageData = cropper.getImageData();
    const { width: naturalWidth, height: naturalHeight } = effectiveNaturalSize(imageData);
    const cropBoxData = cropper.getCropBoxData();
    const wRatio = cropBoxData.width / naturalWidth;
    const hRatio = cropBoxData.height / naturalHeight;
    const ratio = mode === 'width' ? wRatio : mode === 'height' ? hRatio : Math.max(wRatio, hRatio);
    const newWidth = naturalWidth * ratio;
    const newHeight = naturalHeight * ratio;
    cropper.setCanvasData({
      left: cropBoxData.left + (cropBoxData.width - newWidth) / 2,
      top: cropBoxData.top + (cropBoxData.height - newHeight) / 2,
      width: newWidth,
      height: newHeight,
    });
    return ratio;
  }

  // "높이 맞춤"/"너비 맞춤" 모드에서 팬(드래그) 위치를 한 축으로만 제한하고, 나머지 한쪽
  // 가장자리가 프레임을 벗어나 배경이 드러나지 않게(반대쪽으로 넘어가지도 않게) 고정한다.
  // 실사용 요청: "왼쪽 기준으로 딱 맞추고 싶은 사진들이 있다" — 잘라낼 부분만 드래그로
  // 고르고, 나머지 축은 항상 프레임에 꽉 맞아 있어야 함.
  function clampFitMode(entry) {
    const cropper = entry.cropper;
    const cropBoxData = cropper.getCropBoxData();
    let { left, top, width, height } = cropper.getCanvasData();
    if (entry.fitMode === 'height') {
      top = cropBoxData.top;
      height = cropBoxData.height;
      if (width >= cropBoxData.width) {
        const minLeft = cropBoxData.left + cropBoxData.width - width;
        const maxLeft = cropBoxData.left;
        left = Math.min(maxLeft, Math.max(minLeft, left));
      } else {
        left = cropBoxData.left + (cropBoxData.width - width) / 2;
      }
    } else if (entry.fitMode === 'width') {
      left = cropBoxData.left;
      width = cropBoxData.width;
      if (height >= cropBoxData.height) {
        const minTop = cropBoxData.top + cropBoxData.height - height;
        const maxTop = cropBoxData.top;
        top = Math.min(maxTop, Math.max(minTop, top));
      } else {
        top = cropBoxData.top + (cropBoxData.height - height) / 2;
      }
    } else {
      return;
    }
    cropper.setCanvasData({ left, top, width, height });
  }

  // fitMode에 맞게 확대/축소 가능 여부와 드래그 시 클램핑 리스너를 (재)연결한다. 위치 자체는
  // 바꾸지 않는다 — 위치를 바꾸고 싶으면 applyFitMode()를 쓴다.
  function unbindFitModeInteraction(entry) {
    if (entry._cropHandler) {
      entry.imgEl.removeEventListener('crop', entry._cropHandler);
      entry._cropHandler = null;
    }
  }

  function bindFitModeInteraction(entry) {
    unbindFitModeInteraction(entry);
    const cropper = entry.cropper;
    if (entry.fitMode === 'free') {
      cropper.options.zoomable = true;
      return;
    }
    // 잠금 모드에서는 배율이 바뀌면 "높이/너비 딱 맞음"이 깨지므로 확대·축소 자체를 막는다
    // (그릴링 세션 결정).
    cropper.options.zoomable = false;
    let guarding = false;
    const handler = () => {
      if (guarding) return;
      guarding = true;
      clampFitMode(entry);
      guarding = false;
    };
    entry._cropHandler = handler;
    entry.imgEl.addEventListener('crop', handler);
  }

  // 높이/너비 맞춤 모드에서 반대 축으로 드래그할 여지가 실제로 있는지 알려준다. 사진 비율에
  // 따라 이미 반대 축 전체가 다 보이는 경우(드래그할 게 없는 게 정상)가 흔한데, 아무 설명
  // 없이 조용히 안 움직이면 "드래그가 안 된다"는 오인 리포트로 이어졌다(실사용 피드백).
  function updateFitStatus(entry) {
    const statusEl = entry.cardEl.querySelector('.card-status');
    if (!statusEl) return;
    if (entry.duplicate) {
      statusEl.textContent = '나란히 2장 배치 — 사진을 자르지 않고 통째로 넣었어요';
      return;
    }
    if (!entry.cropper) return;
    const canvasData = entry.cropper.getCanvasData();
    const cropBoxData = entry.cropper.getCropBoxData();
    if (entry.fitMode === 'height') {
      const hasRoom = canvasData.width > cropBoxData.width + 0.5;
      statusEl.textContent = hasRoom
        ? '높이를 맞췄어요 — 좌우로 드래그해서 보여줄 부분을 고르세요'
        : '높이를 맞췄어요 — 이미 폭 전체가 보여서 좌우로 드래그할 게 없어요';
    } else if (entry.fitMode === 'width') {
      const hasRoom = canvasData.height > cropBoxData.height + 0.5;
      statusEl.textContent = hasRoom
        ? '너비를 맞췄어요 — 상하로 드래그해서 보여줄 부분을 고르세요'
        : '너비를 맞췄어요 — 이미 높이 전체가 보여서 상하로 드래그할 게 없어요';
    } else {
      statusEl.textContent = '자동 조정됨 — 드래그로 위치, 휠/핀치로 확대·축소 가능';
    }
  }

  function applyFitMode(entry) {
    if (!entry.cropper) return;
    // 먼저 이전 clamp 핸들러를 떼어낸 뒤에 fitCanvas를 불러야 한다 — 순서가 바뀌면
    // fitCanvas의 setCanvasData가 쏘는 'crop' 이벤트를 (아직 안 떨어진) 옛 핸들러가 가로채
    // 자기 기준(옛 aspectRatio 시점의 cropBoxData)으로 또 한 번 보정을 얹어버려서, "나란히
    // 2장 배치"를 반복 토글할 때마다 크롭 프레임이 점점 작아지는 실사용 버그가 있었다.
    bindFitModeInteraction(entry);
    fitCanvas(entry.cropper, entry.fitMode === 'free' ? 'cover' : entry.fitMode);
    updateFitStatus(entry);
  }

  async function toDisplayBlob(file) {
    if (!isHeic(file)) return file;
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: JPEG_QUALITY });
    return Array.isArray(result) ? result[0] : result;
  }

  // blob을 <img>로 디코드한다. 반환된 objectURL은 호출한 쪽이 다 쓴 뒤 revoke할 것.
  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 열 수 없습니다.'));
      };
      img.src = url;
    });
  }

  // 원본 해상도 이미지를 maxDim 이하로 줄인 JPEG blob으로 만든다. 편집 화면에서 Cropper에
  // 물리는 건 이 다운스케일 버전뿐이라, 사진을 여러 장(최대 MAX_PHOTOS_PER_BATCH) 동시에
  // 편집해도 원본 해상도를 전부 메모리에 들고 있지 않는다.
  function downscaleToBlob(img, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('미리보기 축소 실패'))),
        'image/jpeg',
        0.9,
      );
    });
  }

  function updateToReviewButton() {
    els.toReviewBtn.disabled = pendingLoads > 0 || photos.size === 0;
  }

  // 사진의 네 모서리 근처 색을 뽑아 배경색 후보로 제안한다. "스포이드"보다 손이 덜 가면서도
  // 사진과 자연스럽게 어울리는 배경을 고를 수 있게 하기 위함(그릴링 세션 결정).
  function extractEdgeColors(img) {
    const SAMPLE = 32;
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    const patch = 4; // 모서리에서 4x4 픽셀 평균

    function avgAt(px, py) {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let y = py; y < py + patch; y++) {
        for (let x = px; x < px + patch; x++) {
          const i = (y * SAMPLE + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const toHex = (v) =>
        Math.round(v / n)
          .toString(16)
          .padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    return [
      avgAt(0, 0),
      avgAt(SAMPLE - patch, 0),
      avgAt(0, SAMPLE - patch),
      avgAt(SAMPLE - patch, SAMPLE - patch),
    ];
  }

  function applyBgPreview(entry) {
    entry.viewportEl.style.backgroundColor = entry.bgColor;
  }

  function setBgColor(entry, color, cardEl) {
    entry.bgColor = color;
    applyBgPreview(entry);
    renderDupPreview(entry); // 거울모드면 여백 색이 바로 반영되게 다시 그림
    cardEl.querySelector('.bg-color-input').value = color;
    cardEl.querySelectorAll('.bg-swatch').forEach((sw) => {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === color.toLowerCase());
    });
  }

  function renderSwatches(cardEl, entry, colors) {
    const row = cardEl.querySelector('.bg-swatches');
    row.innerHTML = '';
    colors.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bg-swatch';
      btn.dataset.color = color;
      btn.style.backgroundColor = color;
      btn.title = color;
      btn.addEventListener('click', () => setBgColor(entry, color, cardEl));
      row.appendChild(btn);
    });
  }

  // Cropper 인스턴스를 만든다. entry.pendingCropData가 있으면(리뷰 화면에서 돌아올 때 저장해둔
  // 크롭 위치/확대값) 그걸로 복원하고, 없으면(최초 로드) 커버 핏으로 자동 조정한다.
  function createCropper(entry) {
    const cropper = new Cropper(entry.imgEl, {
      aspectRatio: getCropAspect(),
      viewMode: 0, // 0: 사진이 프레임보다 작아지는 것도 허용 (축소 하한 제거, 그릴링 세션 결정)
      dragMode: 'move',
      autoCropArea: 1,
      background: false,
      // Cropper 자체의 window resize 대응(responsive)을 꺼둔다 — 리뷰 화면에서 카드가
      // display:none으로 숨겨진 동안 리사이즈 이벤트가 오면 0 크기 컨테이너 기준으로 내부
      // 상태가 망가지는 문제가 있었다(실사용 버그 리포트). 대신 "편집으로 돌아가기"에서
      // 크롭 데이터를 보존한 채 인스턴스를 재생성하는 방식으로 크기 변화에 대응한다.
      responsive: false,
      cropBoxMovable: false,
      cropBoxResizable: false,
      toggleDragModeOnDblclick: false,
      minCropBoxWidth: 0,
      minCropBoxHeight: 0,
      ready() {
        if (entry.pendingCanvasData) {
          // getData()/setData()(이미지 자연좌표 기준)는 크롭 영역이 이미지 밖으로 나가는
          // 걸(배경 채우기용 축소/오프셋) 복원 시 0으로 클램핑해버리는 문제가 있었다. 대신
          // 컨테이너 기준 캔버스(이미지) 위치를 그대로 저장해뒀다가, 컨테이너 폭이 바뀌었을
          // 수 있으니 비율만 맞춰 그대로 복원한다 — 클램핑 없이 정확히 재현됨.
          const { canvasData, containerWidth } = entry.pendingCanvasData;
          const scale = cropper.getContainerData().width / containerWidth;
          cropper.setCanvasData({
            left: canvasData.left * scale,
            top: canvasData.top * scale,
            width: canvasData.width * scale,
            height: canvasData.height * scale,
          });
          entry.pendingCanvasData = null;
          bindFitModeInteraction(entry);
          updateFitStatus(entry);
        } else {
          applyFitMode(entry);
        }
      },
    });
    entry.cropper = cropper;
    return cropper;
  }

  function applyAspect(entry) {
    if (!entry.cropper) return;
    // 진짜 원인: Cropper.js의 setAspectRatio()는 "현재 캔버스(이미지) 크기"를 새 크롭 박스의
    // 상한으로 써서 크기를 다시 계산한다. 높이/너비 맞춤 잠금 모드에서는 캔버스가 크롭 박스보다
    // 작게(한쪽 축에 배경이 드러나게) 되어 있는 게 정상인데, 그 상태에서 바로 setAspectRatio를
    // 부르면 그 작아진 캔버스를 기준으로 크롭 박스 자체가 영구적으로 줄어들어버린다. 그래서
    // setAspectRatio를 부르기 전에 캔버스를 항상 "커버" 상태로 먼저 채워 넣어 상한 문제를
    // 없앤 뒤, 새 비율이 적용되고 나서 applyFitMode로 원래 원하던 모드(잠금 포함)를 다시 씌운다.
    unbindFitModeInteraction(entry);
    fitCanvas(entry.cropper, 'cover');
    entry.cropper.setAspectRatio(getCropAspect());
    entry.cropper.reset();
    applyFitMode(entry);
  }

  // 거울모드 카드의 미리보기(합성 결과)를 그린다. 편집용 다운스케일 이미지로 그리므로 가볍다.
  function renderDupPreview(entry) {
    if (!entry.duplicate || !entry.dupCanvasEl || !entry.imgEl.naturalWidth) return;
    const composed = composeDuplicate(entry.imgEl, entry.bgColor, PREVIEW_MAX_DIM);
    const target = entry.dupCanvasEl;
    target.width = composed.width;
    target.height = composed.height;
    target.getContext('2d').drawImage(composed, 0, 0);
  }

  // 거울모드를 켜고 끈다. 켜면 크롭이 없으므로 크로퍼를 아예 없애고 합성 미리보기를 보여주고,
  // 끄면 다시 크로퍼를 만든다.
  function setDuplicateMode(entry, on) {
    entry.duplicate = on;
    entry.cardEl.classList.toggle('dup-mode', on);
    if (on) {
      if (entry.cropper) {
        unbindFitModeInteraction(entry);
        entry.cropper.destroy();
        entry.cropper = null;
      }
      renderDupPreview(entry);
      updateFitStatus(entry);
    } else if (!entry.cropper) {
      createCropper(entry);
    }
  }

  async function addPhotoCard(file) {
    const id = ++seq;
    pendingLoads++;
    updateToReviewButton();

    const card = document.createElement('div');
    card.className = 'photo-card';
    card.innerHTML = `
      <div class="crop-viewport">
        <img alt="${file.name}" />
        <canvas class="dup-preview" aria-label="나란히 2장 배치 미리보기"></canvas>
      </div>
      <div class="bg-controls">
        <span class="bg-label">배경색</span>
        <div class="bg-swatches"></div>
        <input type="color" class="bg-color-input" value="${DEFAULT_BG}" />
        <label class="dup-toggle">
          <input type="checkbox" class="dup-checkbox" />
          나란히 2장 배치 (좁고 긴 사진용)
        </label>
      </div>
      <div class="fit-mode-row">
        <label><input type="radio" name="fit-mode-${id}" class="fit-mode-radio" value="free" /> 자유</label>
        <label><input type="radio" name="fit-mode-${id}" class="fit-mode-radio" value="height" checked /> 높이 맞춤</label>
        <label><input type="radio" name="fit-mode-${id}" class="fit-mode-radio" value="width" /> 너비 맞춤</label>
      </div>
      <div class="card-controls">
        <span class="card-status">불러오는 중…</span>
        <button type="button" class="reset">재설정</button>
        <button type="button" class="remove">삭제</button>
      </div>
    `;
    els.cardList.appendChild(card);

    const img = card.querySelector('img');
    const viewportEl = card.querySelector('.crop-viewport');
    viewportEl.style.aspectRatio = getAspectCss();
    const statusEl = card.querySelector('.card-status');
    const objectUrls = [];

    const entry = {
      cropper: null,
      imgEl: img,
      dupCanvasEl: card.querySelector('.dup-preview'),
      cardEl: card,
      viewportEl,
      objectUrls,
      bgColor: DEFAULT_BG,
      duplicate: false,
      fitMode: 'height', // 기본값: 높이 맞춤(실사용 요청) — 인생네컷으로 추정되면 아래서 덮어씀
    };
    photos.set(id, entry);
    updatePhotoCountUI();
    applyBgPreview(entry);

    card.querySelector('.remove').addEventListener('click', () => removePhoto(id));
    card.querySelector('.reset').addEventListener('click', () => {
      if (!entry.cropper) return;
      unbindFitModeInteraction(entry); // reset()이 쏘는 'crop' 이벤트를 옛 핸들러가 가로채지 않게
      entry.cropper.reset();
      applyFitMode(entry);
    });
    card.querySelectorAll('.fit-mode-radio').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        entry.fitMode = e.target.value;
        applyFitMode(entry);
      });
    });
    card.querySelector('.bg-color-input').addEventListener('input', (e) => {
      setBgColor(entry, e.target.value, card);
    });
    card.querySelector('.dup-checkbox').addEventListener('change', (e) => {
      setDuplicateMode(entry, e.target.checked);
    });

    try {
      const displayBlob = await toDisplayBlob(file);
      entry.fullResBlob = displayBlob; // 전송 시점에 다시 불러올 원본(인코딩된 상태 그대로 보관)

      // 원본을 딱 한 번 디코드해서 다운스케일 미리보기를 만들고, 그 디코드 결과(전체 해상도
      // 픽셀 데이터)는 바로 버린다 — 편집 중 메모리에 남는 건 미리보기 블롭뿐.
      const { img: fullImg, url: fullUrl } = await loadImageFromBlob(displayBlob);
      const previewBlob = await downscaleToBlob(fullImg, PREVIEW_MAX_DIM);
      URL.revokeObjectURL(fullUrl);

      const url = URL.createObjectURL(previewBlob);
      objectUrls.push(url);
      img.src = url;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('이미지를 열 수 없습니다.'));
      });

      const edgeColors = extractEdgeColors(img);
      renderSwatches(card, entry, edgeColors);

      // 인생네컷/포토부스 스트립처럼 세로로 아주 좁고 긴 사진이면, 매번 손으로 "나란히 2장
      // 배치"를 켜지 않아도 되게 기본값으로 자동 적용한다(실사용 요청). EXIF 회전이 있어도
      // img.naturalWidth/Height는 브라우저가 이미 보정해서 주므로 그대로 씀.
      if (img.naturalWidth / img.naturalHeight < LIFE4CUT_ASPECT_THRESHOLD) {
        // 거울모드는 여백이 항상 생기므로, 검정 기본값보다 사진 가장자리 색이 훨씬 자연스럽다.
        // 사용자가 스와치로 다른 색을 고를 수 있는 건 그대로.
        if (edgeColors.length > 0) setBgColor(entry, edgeColors[0], card);
        card.querySelector('.dup-checkbox').checked = true;
        setDuplicateMode(entry, true); // 크로퍼 없이 합성 미리보기로 바로 감
      } else {
        createCropper(entry);
      }
    } catch (err) {
      statusEl.textContent = `오류: ${err.message}`;
      showToast(`${file.name} 처리 실패: ${err.message}`);
    } finally {
      pendingLoads--;
      updateToReviewButton();
    }
  }

  function removePhoto(id) {
    const entry = photos.get(id);
    if (!entry) return;
    if (entry.cropper) entry.cropper.destroy();
    entry.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    entry.cardEl.remove();
    photos.delete(id);
    updateToReviewButton();
    updatePhotoCountUI();
    // 마지막 한 장까지 삭제하면 빈 편집 화면에 덩그러니 남기지 말고 처음 업로드 화면으로.
    if (photos.size === 0 && !els.stepEdit.classList.contains('hidden')) {
      els.fileInput.value = '';
      showStep(els.stepSelect);
    }
  }

  // 실사용 버그: 사진 한 장은 "미리보기로 이동"이 잘 되는데 여러 장을 한꺼번에 고르면 편집
  // 화면이 뜨다가 초기 업로드 화면으로 돌아가 버림(서버 로그엔 아무 요청도 안 남음 — 발송
  // 전 단계라 100% 클라이언트에서 벌어지는 일). 유력한 원인은 HEIC 변환+Cropper 초기화를
  // forEach로 전부 동시에 돌려서, 사진이 여러 장(특히 아이폰 HEIC 고해상도)일 때 모바일
  // 브라우저가 메모리 부족으로 탭을 통째로 새로고침하는 것 — 새로고침되면 JS 상태가 다 날아가
  // "처음 화면으로 돌아간 것"처럼 보이고, 콘솔 로그도 함께 사라져서 원인을 남길 수가 없다.
  // 1) 동시 처리를 순차 처리로 바꿔 피크 메모리를 줄이고,
  // 2) sessionStorage에 "처리 중" 표시를 남겨서, 다음에 이 페이지가 열릴 때 직전 새로고침이
  //    업로드 도중 발생했었는지 감지해 알려준다(진짜 원인이 이게 맞는지 확인하기 위함).
  const INFLIGHT_KEY = 'kfe_upload_inflight';

  function checkPreviousCrash() {
    const raw = sessionStorage.getItem(INFLIGHT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(INFLIGHT_KEY);
    try {
      const info = JSON.parse(raw);
      showToast(
        `이전에 사진 ${info.count}장을 처리하던 중 페이지가 예기치 않게 새로고침된 흔적이 있습니다(메모리 부족 가능성) — 한 번에 올리는 장수를 줄여보세요.`,
      );
    } catch {
      /* 무시 */
    }
  }
  checkPreviousCrash();

  // 편집 화면에 동시에 띄울 수 있는 최대 장수. 이제 편집 중엔 다운스케일 미리보기만 메모리에
  // 두므로(PREVIEW_MAX_DIM) 24장에서 탭이 크래시하던 문제는 근본적으로 해결됐지만, 그래도
  // 무한정 열어두면 카드 DOM/이벤트 리스너 자체는 계속 쌓이므로 안전 상한을 둔다.
  const MAX_PHOTOS_PER_BATCH = 30;

  // 상시 노출되는 "N / 30장" 카운터 + 상한 도달 시 "+사진 더 추가" 비활성화. 토스트는 그
  // 순간엔 눈에 띄어도 3.5초면 사라져서 "안내가 없었다"는 피드백을 받았다 — 사라지지 않는
  // 상태 표시를 주 채널로 둔다(토스트는 그 순간의 확인용으로만 보조).
  function updatePhotoCountUI() {
    const count = photos.size;
    const atLimit = count >= MAX_PHOTOS_PER_BATCH;
    els.photoCountStatus.textContent = `${count} / ${MAX_PHOTOS_PER_BATCH}장 선택됨`;
    els.photoCountStatus.classList.toggle('at-limit', atLimit);
    els.addMoreLabel.classList.toggle('disabled', atLimit);
    els.fileInput2.disabled = atLimit;
    els.addMoreLimitNote.classList.toggle('hidden', !atLimit);
    if (atLimit) {
      els.addMoreLimitNote.textContent = `최대 ${MAX_PHOTOS_PER_BATCH}장까지 편집할 수 있어요 — 지금 화면의 사진을 먼저 전송한 뒤 이어서 올려주세요.`;
    }
  }

  async function handleFiles(fileList) {
    let files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/') || isHeic(f));
    if (files.length === 0) return;

    const room = MAX_PHOTOS_PER_BATCH - photos.size;
    if (room <= 0) {
      showToast(
        `한 번에 편집할 수 있는 사진은 최대 ${MAX_PHOTOS_PER_BATCH}장입니다. 지금 화면의 사진을 먼저 전송한 뒤 나머지를 이어서 올려주세요.`,
      );
      updatePhotoCountUI();
      return;
    }
    if (files.length > room) {
      showToast(
        `한 번에 최대 ${MAX_PHOTOS_PER_BATCH}장까지만 편집할 수 있어 ${room}장만 먼저 추가했습니다. 나머지는 이 배치를 전송한 뒤 이어서 올려주세요.`,
      );
      files = files.slice(0, room);
    }

    showStep(els.stepEdit);
    sessionStorage.setItem(INFLIGHT_KEY, JSON.stringify({ count: files.length, at: Date.now() }));
    for (const file of files) {
      await addPhotoCard(file); // 동시 처리 대신 한 장씩 — 피크 메모리를 줄이기 위함(위 설명 참고)
    }
    sessionStorage.removeItem(INFLIGHT_KEY);
  }

  function updateSubtitle() {
    els.subtitle.textContent =
      frameMode === 'landscape'
        ? '액자 화면 비율(가로 16:10)에 맞춰 자르고, 확인 후 전송합니다.'
        : '액자 화면 비율(세로 10:16)에 맞춰 자르고, 확인 후 전송합니다.';
  }

  // 세로/가로 전환 시 목표 프레임 모양 자체가 바뀌어 기존 크롭 상태를 이어갈 방법이 마땅치
  // 않으므로, 편집 중이던 사진은 전부 초기화하고 다시 업로드받는다(실사용 요청, 기본은 세로).
  function setFrameMode(mode) {
    if (mode === frameMode) return;
    const hadWork = photos.size > 0 || lastCroppedBlobs;
    frameMode = mode;
    for (const id of Array.from(photos.keys())) removePhoto(id);
    lastCroppedBlobs = null;
    els.fileInput.value = '';
    els.cardList.innerHTML = '';
    els.modeButtons.forEach((btn) => {
      const isActive = btn.dataset.mode === mode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
    updateSubtitle();
    showStep(els.stepSelect);
    if (hadWork) {
      showToast(
        mode === 'landscape'
          ? '가로 모드로 전환 — 편집 중이던 사진은 초기화됐습니다'
          : '세로 모드로 전환 — 편집 중이던 사진은 초기화됐습니다',
      );
    }
  }
  els.modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => setFrameMode(btn.dataset.mode));
  });

  els.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  els.fileInput2.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  // 크롭 결과(투명 영역 포함 가능 — 사진이 축소되어 프레임/절반 슬롯을 다 못 채우면 나머지는
  // 투명)를 배경색 위에 합성한다. JPEG는 알파를 지원하지 않으므로 반드시 먼저 배경을 채워야 함.
  // 편집 중엔 다운스케일 미리보기 크로퍼로만 작업하므로, "전송" 시점에 실제 결과물을 만들
  // 때는 그 크로퍼의 크롭 위치/배율을 원본 해상도에 그대로 적용해야 한다. Cropper의 캔버스
  // 데이터는 해상도 그 자체가 아니라 "이미지 대비 비율"이므로, 그 비율만 뽑아두면 해상도가
  // 달라도(미리보기든 원본이든) 동일하게 재현할 수 있다.
  function getCropRectFraction(cropper) {
    const imageData = cropper.getImageData();
    const { width: natW, height: natH } = effectiveNaturalSize(imageData);
    const canvasData = cropper.getCanvasData();
    const cropBoxData = cropper.getCropBoxData();
    const scale = canvasData.width / natW;
    return {
      x: (cropBoxData.left - canvasData.left) / scale / natW,
      y: (cropBoxData.top - canvasData.top) / scale / natH,
      width: cropBoxData.width / scale / natW,
      height: cropBoxData.height / scale / natH,
    };
  }

  // frac(비율)을 img의 실제 해상도에 곱해서 크롭한다.
  //
  // frac은 이미지 밖으로 나갈 수 있다(배경 채우기 = "너비 맞춤"으로 위아래에 여백을 두는 상태).
  // 예전엔 이때 drawImage가 알아서 처리해주길 기대하고 소스 사각형을 그대로 넘겼는데, 이건
  // 엔진마다 동작이 달라서 실제로 깨졌다:
  //   - Chrome: 스펙대로 소스 사각형을 이미지에 맞게 자르고 목적지 사각형도 "같은 비율로"
  //     줄여준다 → 여백이 생기고 비율 유지 (그래서 데스크톱 테스트에선 멀쩡해 보였음).
  //   - iOS Safari/WebKit: 소스만 이미지 경계로 자르고 목적지는 그대로 둬서, 이미지를 목적지
  //     사각형에 꽉 채우도록 늘려버린다 → 세로로 쭉 늘어남.
  // 인생네컷(좁고 긴 사진)은 자동으로 "나란히 2장 배치 + 너비 맞춤"이 켜지면서 frac.height가
  // 1을 넘기 때문에, 이 경로를 타는 건 사실상 거울모드뿐이었다. 그래서 "거울모드일 때만 얼굴이
  // 세로로 길어짐"으로 나타났다(2026-08-16, 실제 액자 사진 + R2 원본 파일 측정으로 확인.
  // frac.height=1.1712 → 가로 0.854배 압축 = 세로 17% 늘어남, 측정값과 정확히 일치).
  //
  // 그래서 이제 엔진 동작에 기대지 않고, 소스 사각형을 이미지 경계로 직접 자르고 목적지
  // 사각형도 같은 비율로 우리가 직접 계산해서 넘긴다. drawImage에는 항상 이미지 안쪽의
  // 사각형만 들어가므로 어느 브라우저에서도 결과가 같다.
  function cropImageByFraction(img, frac) {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    let sx = frac.x * natW;
    let sy = frac.y * natH;
    let sw = frac.width * natW;
    let sh = frac.height * natH;
    let dw = Math.max(1, Math.round(sw));
    let dh = Math.max(1, Math.round(sh));
    const longSide = Math.max(dw, dh);
    if (longSide > MAX_OUTPUT_DIM) {
      const capScale = MAX_OUTPUT_DIM / longSide;
      dw = Math.max(1, Math.round(dw * capScale));
      dh = Math.max(1, Math.round(dh * capScale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 소스 1px이 목적지에서 몇 px이 되는지(캡이 걸렸을 땐 1이 아님). sw/sh는 여기서 항상 > 0.
    const scaleX = dw / sw;
    const scaleY = dh / sh;
    // 이미지 왼쪽/위로 벗어난 만큼은 목적지에서도 그만큼 안쪽으로 밀어서 그린다.
    let dx = 0;
    let dy = 0;
    if (sx < 0) {
      dx = -sx * scaleX;
      sw += sx;
      sx = 0;
    }
    if (sy < 0) {
      dy = -sy * scaleY;
      sh += sy;
      sy = 0;
    }
    // 오른쪽/아래로 벗어난 만큼은 소스 폭/높이를 줄인다.
    if (sx + sw > natW) sw = natW - sx;
    if (sy + sh > natH) sh = natH - sy;
    // 크롭 영역이 이미지와 아예 안 겹치면 배경만 남긴다(합성 단계에서 배경색이 채워짐).
    if (sw > 0 && sh > 0) {
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw * scaleX, sh * scaleY);
    }
    return canvas;
  }

  // 캔버스를 긴 변이 maxLongDim 이하가 되게 축소한다. 목표의 2배 안에 들어올 때까지 절반씩
  // 단계적으로 줄인 뒤 마지막에 정확한 크기로 맞춘다(고전적인 mipmap 방식).
  //
  // 참고: Chrome에서는 `imageSmoothingQuality:'high'`가 이미 제대로 된 다중 탭 샘플링을 해서
  // 단계적 축소와 품질 차이가 측정되지 않았다(3배 축소 후 디테일 지표 88.6 vs 88.6). 그럼에도
  // 단계적으로 두는 건 실사용 환경이 iOS Safari이고, 이 엔진이 축소 품질에서 Chrome과 다르게
  // 동작한 전례가 있기 때문이다(ISSUES.md 버그 #9 — drawImage 동작 차이). 각 단계가 2배
  // 이내면 어떤 엔진의 단순 보간에서도 원본 픽셀을 건너뛰지 않는다.
  function downscaleCanvas(src, maxLongDim) {
    let cur = src;
    let longSide = Math.max(cur.width, cur.height);
    if (longSide <= maxLongDim) return cur;

    const draw = (w, h) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w));
      c.height = Math.max(1, Math.round(h));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, c.width, c.height);
      return c;
    };

    while (longSide > maxLongDim * 2) {
      cur = draw(cur.width / 2, cur.height / 2);
      longSide = Math.max(cur.width, cur.height);
    }
    const scale = maxLongDim / longSide;
    return draw(cur.width * scale, cur.height * scale);
  }

  function compositeSingle(cropped, bgColor) {
    const out = document.createElement('canvas');
    out.width = cropped.width;
    out.height = cropped.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(cropped, 0, 0);
    return out;
  }

  // 거울모드 합성: 사진을 자르지 않고 통째로 좌우 반쪽 슬롯에 하나씩(오른쪽은 좌우 반전)
  // 넣는다. 크롭이 없으므로 크로퍼 상태를 전혀 참조하지 않고 이미지 하나만 받는다.
  //
  // 결과물 크기는 "사진이 원본 해상도 그대로 들어가는 크기"로 잡는다 — 반쪽 슬롯 폭 Wh에
  // 대해 사진이 들어갈 안쪽 폭은 (1-2*여백)*Wh, 안쪽 높이는 슬롯 높이(Wh/슬롯비율) 전체다.
  // 둘 중 먼저 꽉 차는 쪽이 축소 배율을 정하므로(contain), 배율이 1이 되는 Wh를 역산하면
  // max(natW/(1-2*여백), natH*슬롯비율)이 된다. 그 뒤 긴 변만 MAX_OUTPUT_DIM으로 캡.
  function composeDuplicate(img, bgColor, maxDim = MAX_OUTPUT_DIM) {
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    const slotAspect = getHalfSlotAspect();
    const innerRatio = 1 - 2 * DUP_INNER_MARGIN_FRACTION;

    let halfW = Math.max(natW / innerRatio, natH * slotAspect);
    let totalH = halfW / slotAspect;
    // 긴 변 캡(원본이 아주 크면 여기서 균등 축소된다 — 가로/세로 같은 배율이라 왜곡 없음)
    const longSide = Math.max(halfW * 2, totalH);
    if (longSide > maxDim) {
      const capScale = maxDim / longSide;
      halfW *= capScale;
      totalH *= capScale;
    }
    halfW = Math.max(1, Math.round(halfW));
    totalH = Math.max(1, Math.round(totalH));

    const out = document.createElement('canvas');
    out.width = halfW * 2;
    out.height = totalH;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, out.width, out.height);

    // contain: 안쪽 영역 안에 비율 그대로 들어가는 최대 크기
    const innerW = halfW * innerRatio;
    const scale = Math.min(innerW / natW, totalH / natH);
    const drawW = natW * scale;
    const drawH = natH * scale;
    const offX = (halfW - drawW) / 2; // 슬롯 안에서 가운데 정렬
    const offY = (totalH - drawH) / 2;

    ctx.drawImage(img, offX, offY, drawW, drawH);
    // 오른쪽 슬롯: 좌우 반전(거울 대칭)해서 배치 (그릴링 세션 결정)
    ctx.save();
    ctx.translate(out.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, offX, offY, drawW, drawH);
    ctx.restore();
    return out;
  }

  // 미리보기 크로퍼에서 뽑은 크롭 비율을 원본 해상도 이미지에 적용해 최종 결과물을 만든다.
  // 원본은 이 함수 호출 시점에만 잠깐 디코드했다가 끝나면 바로 해제한다 — 여러 장을 이
  // 함수로 연달아 처리해도(순차 호출 전제) 한 번에 메모리에 남는 원본은 최대 1장뿐.
  async function exportEntryToBlob(entry) {
    // 거울모드는 크롭이 없으므로 크로퍼 상태를 읽지 않는다(애초에 크로퍼가 없다).
    const frac = entry.duplicate ? null : getCropRectFraction(entry.cropper);
    const { img: fullImg, url } = await loadImageFromBlob(entry.fullResBlob);
    try {
      const composed = entry.duplicate
        ? composeDuplicate(fullImg, entry.bgColor)
        : compositeSingle(cropImageByFraction(fullImg, frac), entry.bgColor);
      // 축소를 액자 내장 스케일러에 맡기지 않고 여기서 고품질로 끝낸다(FRAME_TARGET_LONG_DIM).
      const canvas = downscaleCanvas(composed, FRAME_TARGET_LONG_DIM);
      return await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('이미지 변환 실패'))),
          'image/jpeg',
          JPEG_QUALITY,
        );
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function formatBytes(n) {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }

  els.toReviewBtn.addEventListener('click', async () => {
    els.toReviewBtn.disabled = true;
    els.toReviewBtn.textContent = '변환 중…';
    try {
      // 거울모드 카드는 크로퍼가 없으므로(크롭 안 함) cropper 유무로 거르면 안 된다.
      const entries = Array.from(photos.values()).filter((e) => e.cropper || e.duplicate);
      // 원본 해상도를 하나씩 그때그때 불러와 처리한다(동시 처리 시 원본이 전부 메모리에
      // 동시에 떠서 편집 화면과 같은 크래시가 재현됨 — ISSUES.md 버그 #7).
      lastCroppedBlobs = [];
      for (let i = 0; i < entries.length; i++) {
        els.toReviewBtn.textContent = `변환 중… (${i + 1}/${entries.length})`;
        const blob = await exportEntryToBlob(entries[i]);
        lastCroppedBlobs.push({ filename: `${i + 1}.jpg`, blob, entry: entries[i] });
      }

      els.reviewGrid.innerHTML = '';
      let totalBytes = 0;
      for (const item of lastCroppedBlobs) {
        totalBytes += item.blob.size;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(item.blob);
        img.style.aspectRatio = getAspectCss();
        img.addEventListener('click', () => openLightbox(img.src, item.entry));
        els.reviewGrid.appendChild(img);
      }
      // 서버(mailer.js)와 동일한 기준(용량 20MB, 장수 9장 중 먼저 걸리는 쪽)으로 안내만
      // 미리 계산한다 — 실제 분할은 서버가 하고, 여긴 화면 안내용 추정치일 뿐이다.
      const batchMaxBytes = 20 * 1024 * 1024;
      const batchMaxCount = 9;
      const batches = Math.max(
        1,
        Math.ceil(totalBytes / batchMaxBytes),
        Math.ceil(lastCroppedBlobs.length / batchMaxCount),
      );
      els.reviewSummary.textContent =
        `총 ${lastCroppedBlobs.length}장 · 약 ${formatBytes(totalBytes)}` +
        (batches > 1 ? ` · 이메일 ${batches}통으로 나눠 발송됩니다` : '');

      showStep(els.stepReview);
    } catch (err) {
      showToast(`미리보기 생성 실패: ${err.message}`);
    } finally {
      els.toReviewBtn.disabled = false;
      els.toReviewBtn.textContent = '미리보기로 이동';
    }
  });

  let lightboxEntry = null;
  function openLightbox(src, entry) {
    els.lightboxImg.src = src;
    lightboxEntry = entry || null;
    els.lightboxEdit.classList.toggle('hidden', !lightboxEntry);
    els.lightbox.classList.remove('hidden');
  }
  function closeLightbox() {
    els.lightbox.classList.add('hidden');
    els.lightboxImg.src = '';
    lightboxEntry = null;
  }
  els.lightboxClose.addEventListener('click', closeLightbox);
  els.lightbox.addEventListener('click', (e) => {
    if (e.target === els.lightbox) closeLightbox();
  });

  // 리뷰 화면에 있는 동안 편집 카드들은 display:none으로 숨겨지는데, 그 사이 모바일
  // 브라우저의 뷰포트 변화(주소창 접힘/펼침 등)로 리사이즈 이벤트가 발생하면 Cropper.js가
  // 0 크기 컨테이너를 기준으로 내부 상태를 망가뜨려 사진이 안 보이게 되는 문제가 있었다
  // (실사용 버그 리포트). 크롭 위치/확대값(캔버스 데이터)을 보존한 채로 안전하게 재생성해서
  // 고친다. focusEntry를 주면(라이트박스의 "이 사진 편집하기") 그 카드로 스크롤 이동까지 한다.
  function reenterEditMode(focusEntry) {
    showStep(els.stepEdit);
    for (const entry of photos.values()) {
      // 거울모드 카드는 크로퍼가 없고 상태를 보존할 것도 없다 — 미리보기만 다시 그린다.
      if (entry.duplicate) {
        renderDupPreview(entry);
        continue;
      }
      if (!entry.cropper) continue;
      entry.pendingCanvasData = {
        canvasData: entry.cropper.getCanvasData(),
        containerWidth: entry.cropper.getContainerData().width,
      };
      entry.cropper.destroy();
      createCropper(entry);
    }
    if (focusEntry) {
      requestAnimationFrame(() => {
        focusEntry.cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  els.backToEditBtn.addEventListener('click', () => reenterEditMode());
  els.lightboxEdit.addEventListener('click', () => {
    const entry = lightboxEntry;
    closeLightbox();
    reenterEditMode(entry);
  });

  // 액자 번호는 사람마다 고정이고 매번 다시 치게 하면 번거로우므로 브라우저에 기억해둔다.
  const FRAME_ID_STORAGE_KEY = 'kfe_frame_id';

  function saveFrameId(id) {
    try {
      localStorage.setItem(FRAME_ID_STORAGE_KEY, id);
    } catch {
      /* 사파리 프라이빗 모드 등에서 막힐 수 있는데, 기억 못 할 뿐이라 무시해도 된다 */
    }
  }

  function loadFrameId() {
    try {
      return localStorage.getItem(FRAME_ID_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function setFrameIdError(msg) {
    els.frameIdError.textContent = msg;
    els.frameIdError.classList.toggle('hidden', !msg);
    els.frameId.classList.toggle('invalid', !!msg);
  }

  els.frameId.value = loadFrameId();
  // 숫자만 남기고, 고치기 시작하면 에러 표시를 지운다.
  els.frameId.addEventListener('input', () => {
    const cleaned = els.frameId.value.replace(/\D/g, '');
    if (cleaned !== els.frameId.value) els.frameId.value = cleaned;
    if (els.frameIdError.textContent) setFrameIdError('');
  });

  els.sendBtn.addEventListener('click', async () => {
    if (!lastCroppedBlobs || lastCroppedBlobs.length === 0) return;

    const frameId = els.frameId.value.trim();
    if (!/^\d{4,16}$/.test(frameId)) {
      setFrameIdError('액자 번호를 숫자로 입력해 주세요.');
      els.frameId.focus();
      return;
    }
    setFrameIdError('');

    els.sendBtn.disabled = true;
    els.sendBtn.textContent = '전송 중…';
    try {
      const formData = new FormData();
      // 도메인은 서버가 붙인다 — 클라이언트는 숫자만 보낸다(src/server.js 참고).
      formData.append('frameId', frameId);
      for (const { filename, blob } of lastCroppedBlobs) {
        formData.append('photos', blob, filename);
      }
      const res = await fetch('/api/send', { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `전송 실패 (HTTP ${res.status})`);

      saveFrameId(frameId); // 성공한 번호만 기억해서 다음에 자동으로 채운다
      els.doneMessage.textContent = `${lastCroppedBlobs.length}장을 액자로 보냈습니다. 사진이 많으면 이메일이 여러 통으로 나뉘어 발송되니, 몇 분 정도 지난 뒤 액자에서 확인해 주세요.`;
      showStep(els.stepDone);
    } catch (err) {
      showToast(`전송 실패: ${err.message}`);
    } finally {
      els.sendBtn.disabled = false;
      els.sendBtn.textContent = '액자로 전송';
    }
  });

  els.restartBtn.addEventListener('click', () => {
    for (const id of Array.from(photos.keys())) removePhoto(id);
    lastCroppedBlobs = null;
    els.fileInput.value = '';
    els.cardList.innerHTML = '';
    showStep(els.stepSelect);
  });
})();

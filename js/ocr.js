// Распознавание на устройстве: Tesseract лежит в vendor/, картинки никуда не уходят.
let workerPromise = null;
let onProgress = () => {};

const abs = (p) => new URL(p, location.href).href;

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error('Не удалось загрузить модуль распознавания'));
    document.head.append(s);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(abs('vendor/tesseract.min.js'));
      const worker = await window.Tesseract.createWorker(['rus', 'eng'], 1, {
        workerPath: abs('vendor/worker.min.js'),
        corePath: abs('vendor/core'),
        langPath: abs('vendor/lang'),
        gzip: true,
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text') onProgress(m.progress);
        },
      });
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/** Серый тон, инверсия тёмной темы, увеличение мелких картинок: так Tesseract ошибается реже. */
async function prepare(file) {
  const bitmap = await createImageBitmap(file);
  const scale = bitmap.width < 1000 ? 2 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width * scale;
  canvas.height = bitmap.height * scale;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = y;
    sum += y;
  }
  const dark = sum / (px.length / 4) < 110;
  for (let i = 0; i < px.length; i += 4) {
    const y = dark ? 255 - px[i] : px[i];
    px[i] = px[i + 1] = px[i + 2] = y;
    px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** @returns {{lines: {text: string, conf: number}[], text: string}} */
export async function recognize(file, progress = () => {}) {
  onProgress = progress;
  const worker = await getWorker();
  const canvas = await prepare(file);
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) lines.push({ text: l.text.trim(), conf: l.confidence });
    }
  }
  return { lines: lines.length ? lines : data.text.split('\n').map((text) => ({ text, conf: 100 })), text: data.text };
}

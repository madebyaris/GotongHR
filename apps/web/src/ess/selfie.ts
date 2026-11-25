import { SELFIE_MAX_BYTES, SELFIE_MAX_EDGE } from "./policy";

const FAIL = "Choose a selfie under 40 KB.";

export async function compressSelfie(file: Blob): Promise<{ blob: Blob; type: "image/webp" | "image/jpeg" }> {
  if (file.size < 1) throw new Error(FAIL);
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(FAIL);
  try {
    const scale = Math.min(1, SELFIE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(FAIL);
    context.drawImage(bitmap, 0, 0, width, height);
    const webp = await canvasBlob(canvas, "image/webp", 0.8);
    if (webp && webp.type === "image/webp" && webp.size > 0 && webp.size <= SELFIE_MAX_BYTES) {
      return { blob: webp, type: "image/webp" };
    }
    for (const quality of [0.72, 0.5, 0.32, 0.2]) {
      const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
      if (jpeg && jpeg.size > 0 && jpeg.size <= SELFIE_MAX_BYTES) {
        return { blob: jpeg, type: "image/jpeg" };
      }
    }
    throw new Error(FAIL);
  } finally {
    bitmap.close();
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

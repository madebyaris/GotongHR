const CHUNK_CHARS = 900;
export const MAX_SOP_CHUNKS = 40;
const MAX_INPUT_CHARS = CHUNK_CHARS * MAX_SOP_CHUNKS;

/** Splits SOP text on paragraph boundaries. Returns null when the text is too long. */
export function chunkText(text: string): string[] | null {
  const normalized = text.split("\u0000").join("").replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];
  if (normalized.length > MAX_INPUT_CHARS) return null;
  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_CHARS) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (let index = 0; index < paragraph.length; index += CHUNK_CHARS) {
        chunks.push(paragraph.slice(index, index + CHUNK_CHARS));
      }
      continue;
    }
    const next = current.length === 0 ? paragraph : `${current}\n${paragraph}`;
    if (next.length > CHUNK_CHARS) {
      chunks.push(current);
      current = paragraph;
      continue;
    }
    current = next;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length > MAX_SOP_CHUNKS) return null;
  return chunks;
}

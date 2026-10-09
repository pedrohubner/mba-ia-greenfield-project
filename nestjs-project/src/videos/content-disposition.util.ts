const COMBINING_MARKS = /\p{M}/gu;

const UNSAFE_FALLBACK_CHARACTERS = /[^\x20-\x7e]|["\\]/g;

function asciiFallback(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(UNSAFE_FALLBACK_CHARACTERS, '_')
    .trim();
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildAttachmentDisposition(
  title: string,
  extension: string,
): string {
  const fileName = `${title}.${extension}`;
  const fallback = `${asciiFallback(title) || 'video'}.${asciiFallback(extension)}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

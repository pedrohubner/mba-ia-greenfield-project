import { VIDEO_TITLE_MAX_LENGTH } from './videos.constants';

const CONTROL_CHARACTERS = /\p{Cc}/gu;

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

export function deriveVideoTitle(filename: string, title?: string): string {
  const explicit = title?.trim();
  if (explicit) {
    return explicit.slice(0, VIDEO_TITLE_MAX_LENGTH);
  }

  const fromFilename = stripExtension(filename)
    .replace(CONTROL_CHARACTERS, '')
    .trim()
    .slice(0, VIDEO_TITLE_MAX_LENGTH)
    .trim();
  return fromFilename || filename.replace(CONTROL_CHARACTERS, '').trim();
}

export function fileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return filename.slice(lastDot + 1).toLowerCase();
}

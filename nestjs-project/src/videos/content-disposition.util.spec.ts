import { buildAttachmentDisposition } from './content-disposition.util';

function parse(disposition: string): {
  type: string;
  fallback: string;
  encoded: string;
} {
  const match = /^(\w+); filename="([^"]*)"; filename\*=UTF-8''(.+)$/.exec(
    disposition,
  );
  if (!match) {
    throw new Error(`Unexpected disposition: ${disposition}`);
  }
  return { type: match[1], fallback: match[2], encoded: match[3] };
}

describe('buildAttachmentDisposition', () => {
  it('should build an attachment with plain ASCII titles unchanged', () => {
    expect(buildAttachmentDisposition('Fluxo completo', 'mp4')).toBe(
      `attachment; filename="Fluxo completo.mp4"; filename*=UTF-8''Fluxo%20completo.mp4`,
    );
  });

  it('should strip accents in the fallback and keep them in filename*', () => {
    const { fallback, encoded } = parse(
      buildAttachmentDisposition('Aula de Programação', 'webm'),
    );

    expect(fallback).toBe('Aula de Programacao.webm');
    expect(decodeURIComponent(encoded)).toBe('Aula de Programação.webm');
  });

  it('should neutralize quotes, backslashes and control characters in the fallback', () => {
    const { fallback, encoded } = parse(
      buildAttachmentDisposition('My "best" \\ video\u0007', 'mp4'),
    );

    expect(fallback).toBe('My _best_ _ video_.mp4');
    expect(decodeURIComponent(encoded)).toBe('My "best" \\ video\u0007.mp4');
  });

  it('should replace emoji in the fallback and percent-encode them in filename*', () => {
    const { fallback, encoded } = parse(
      buildAttachmentDisposition('Viagem 🎬', 'mp4'),
    );

    expect(fallback).toMatch(/^Viagem _+\.mp4$/);
    expect(encoded).toBe('Viagem%20%F0%9F%8E%AC.mp4');
  });

  it("should percent-encode characters RFC 5987 reserves (' ( ) *)", () => {
    const { encoded } = parse(
      buildAttachmentDisposition("it's (a) *test*", 'mp4'),
    );

    expect(encoded).toBe('it%27s%20%28a%29%20%2Atest%2A.mp4');
  });

  it('should preserve the extension and fall back to "video" when nothing ASCII is left', () => {
    const { fallback, encoded } = parse(
      buildAttachmentDisposition('🎬', 'webm'),
    );

    expect(fallback.endsWith('.webm')).toBe(true);
    expect(encoded.endsWith('.webm')).toBe(true);
  });
});

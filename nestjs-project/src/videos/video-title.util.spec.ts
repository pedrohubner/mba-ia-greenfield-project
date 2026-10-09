import { deriveVideoTitle, fileExtension } from './video-title.util';

describe('deriveVideoTitle', () => {
  it('should prefer the trimmed explicit title', () => {
    expect(deriveVideoTitle('aula.mp4', '  Minha aula  ')).toBe('Minha aula');
  });

  it('should fall back to the filename without its extension', () => {
    expect(deriveVideoTitle('aula-01.final.mp4')).toBe('aula-01.final');
  });

  it('should fall back to the filename when the title is blank', () => {
    expect(deriveVideoTitle('aula.mp4', '   ')).toBe('aula');
  });

  it('should remove control characters from the filename', () => {
    expect(deriveVideoTitle('au\u0000la\u0007.mp4')).toBe('aula');
  });

  it('should truncate the derived title to 100 characters', () => {
    const title = deriveVideoTitle(`${'a'.repeat(150)}.mp4`);

    expect(title).toHaveLength(100);
  });

  it('should keep the full name when nothing is left before the extension', () => {
    expect(deriveVideoTitle('.mp4')).toBe('.mp4');
  });
});

describe('fileExtension', () => {
  it('should return the lowercased last extension', () => {
    expect(fileExtension('Aula.Final.MP4')).toBe('mp4');
  });
});

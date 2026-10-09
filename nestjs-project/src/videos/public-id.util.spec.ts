import { generatePublicId, isValidPublicId } from './public-id.util';

describe('public-id.util', () => {
  describe('generatePublicId', () => {
    it('should generate 11-character base64url identifiers', () => {
      const ids = Array.from({ length: 200 }, () => generatePublicId());

      for (const id of ids) {
        expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      }
    });

    it('should generate distinct identifiers', () => {
      const ids = new Set(
        Array.from({ length: 200 }, () => generatePublicId()),
      );

      expect(ids.size).toBe(200);
    });
  });

  describe('isValidPublicId', () => {
    it('should accept a generated identifier', () => {
      expect(isValidPublicId(generatePublicId())).toBe(true);
    });

    it('should accept the base64url special characters', () => {
      expect(isValidPublicId('aZ09_-aZ09_')).toBe(true);
    });

    it.each(['', 'abc', 'abcdefghij', 'abcdefghijkl'])(
      'should reject the wrong length %p',
      (value) => {
        expect(isValidPublicId(value)).toBe(false);
      },
    );

    it.each(['abcdefghij+', 'abcdefghij/', 'abcdefghij=', 'abcde fghij'])(
      'should reject characters outside base64url in %p',
      (value) => {
        expect(isValidPublicId(value)).toBe(false);
      },
    );
  });
});

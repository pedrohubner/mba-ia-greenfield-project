import { thumbnailTimestamp } from './thumbnail.service';

describe('thumbnailTimestamp', () => {
  it('should pick the frame at 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBeCloseTo(12);
  });

  it('should stay before the end of a very short video', () => {
    expect(thumbnailTimestamp(0.105)).toBeLessThanOrEqual(0.005 + 1e-9);
  });

  it('should never return a negative timestamp', () => {
    expect(thumbnailTimestamp(0.05)).toBe(0);
    expect(thumbnailTimestamp(0)).toBe(0);
  });
});

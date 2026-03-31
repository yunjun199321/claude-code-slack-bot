import { describe, it, expect } from 'vitest';

// We need to test the private splitMessage method. Extract the logic for testing.
// This tests the same algorithm used in SlackHandler.splitMessage
function splitMessage(text: string, maxLength: number = 3900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('returns single chunk at exact max length', () => {
    const msg = 'x'.repeat(3900);
    expect(splitMessage(msg)).toEqual([msg]);
  });

  it('splits at paragraph boundary when possible', () => {
    const para1 = 'a'.repeat(100);
    const para2 = 'b'.repeat(100);
    const msg = para1 + '\n\n' + para2;
    const chunks = splitMessage(msg, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('falls back to newline split', () => {
    const line1 = 'a'.repeat(100);
    const line2 = 'b'.repeat(100);
    const msg = line1 + '\n' + line2;
    const chunks = splitMessage(msg, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('falls back to space split', () => {
    const word1 = 'a'.repeat(50);
    const word2 = 'b'.repeat(50);
    const word3 = 'c'.repeat(50);
    const msg = `${word1} ${word2} ${word3}`;
    const chunks = splitMessage(msg, 80);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // No chunk should exceed maxLength
    chunks.forEach(chunk => expect(chunk.length).toBeLessThanOrEqual(80));
  });

  it('hard splits when no separators found', () => {
    const msg = 'x'.repeat(200);
    const chunks = splitMessage(msg, 80);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    chunks.forEach(chunk => expect(chunk.length).toBeLessThanOrEqual(80));
  });

  it('does not produce empty chunks', () => {
    const msg = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50);
    const chunks = splitMessage(msg, 60);
    chunks.forEach(chunk => expect(chunk.length).toBeGreaterThan(0));
  });

  it('handles very long single-line messages', () => {
    const msg = 'word '.repeat(2000); // ~10000 chars
    const chunks = splitMessage(msg, 3900);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach(chunk => expect(chunk.length).toBeLessThanOrEqual(3900));
    // All content should be preserved
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(msg.trim());
  });
});

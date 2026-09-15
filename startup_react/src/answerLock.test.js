import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { lookup } from './answerLock';

// Re-implements service/answerLock.js so the test checks that both halves agree.
function serverLock(salt, variant, answer) {
  const seed = createHash('sha256').update(`${salt}:${variant}`).digest();
  const plain = Buffer.from(answer, 'utf8');
  const stream = Buffer.alloc(plain.length);
  let block = seed;
  for (let offset = 0; offset < plain.length; offset += block.length) {
    block = createHash('sha256').update(block).digest();
    block.copy(stream, offset);
  }
  const cipher = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    cipher[i] = plain[i] ^ stream[i];
  }
  return { id: seed.subarray(0, 8).toString('hex'), c: cipher.toString('hex') };
}

describe('answer locking', () => {
  const salt = 'a1b2c3d4e5f60718';

  it('derives the same id on the client as the server', async () => {
    const locked = serverLock(salt, 'bastille', 'The Bastille');
    const { id } = await lookup(salt, 'bastille');
    expect(id).toBe(locked.id);
  });

  it('decrypts the display answer for a correct guess', async () => {
    const locked = serverLock(salt, 'washington', 'George Washington');
    const { decrypt } = await lookup(salt, 'washington');
    expect(await decrypt(locked.c)).toBe('George Washington');
  });

  it('produces a different id for a wrong guess', async () => {
    const locked = serverLock(salt, 'bastille', 'The Bastille');
    const { id } = await lookup(salt, 'versailles');
    expect(id).not.toBe(locked.id);
  });

  it('cannot decrypt an answer with the wrong guess', async () => {
    const locked = serverLock(salt, 'bastille', 'The Bastille');
    const { decrypt } = await lookup(salt, 'versailles');
    expect(await decrypt(locked.c)).not.toBe('The Bastille');
  });

  it('changes the id when the salt changes, so ids cannot be catalogued', async () => {
    const first = await lookup(salt, 'bastille');
    const second = await lookup('ffffffffffffffff', 'bastille');
    expect(first.id).not.toBe(second.id);
  });

  it('handles answers longer than one hash block', async () => {
    const answer = 'The Committee of Public Safety and Then Some More Words';
    const locked = serverLock(salt, 'public safety', answer);
    const { decrypt } = await lookup(salt, 'public safety');
    expect(await decrypt(locked.c)).toBe(answer);
  });

  it('handles accented display answers', async () => {
    const locked = serverLock(salt, 'vendee', 'The Vendée');
    const { decrypt } = await lookup(salt, 'vendee');
    expect(await decrypt(locked.c)).toBe('The Vendée');
  });
});

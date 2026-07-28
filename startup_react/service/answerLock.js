import crypto from 'crypto';

// Answers are never sent in the clear. Each accepted spelling is turned into
// an id (for matching a guess) plus a ciphertext of the display answer keyed
// by that same spelling — so the browser can only reveal an answer it has
// actually guessed. A fresh salt per response keeps the ids from being
// catalogued across page loads.

function digest(salt, variant) {
  return crypto.createHash('sha256').update(`${salt}:${variant}`).digest();
}

function keystream(seed, length) {
  const out = Buffer.alloc(length);
  let block = seed;
  for (let offset = 0; offset < length; offset += block.length) {
    block = crypto.createHash('sha256').update(block).digest();
    block.copy(out, offset);
  }
  return out;
}

export function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

export function lockAnswer(salt, variant, answer) {
  const seed = digest(salt, variant);
  const plain = Buffer.from(answer, 'utf8');
  const stream = keystream(seed, plain.length);
  const cipher = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    cipher[i] = plain[i] ^ stream[i];
  }
  return { id: seed.subarray(0, 8).toString('hex'), c: cipher.toString('hex') };
}

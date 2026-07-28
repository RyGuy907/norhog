// Client half of the answer locking in service/answerLock.js: derive the same
// digest from a normalized guess to find a matching question, then use it to
// decrypt that answer's display text. Answers you haven't guessed stay
// unreadable until the server reveals them at the end of a run.

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function digest(salt, variant) {
  return sha256(new TextEncoder().encode(`${salt}:${variant}`));
}

async function keystream(seed, length) {
  const out = new Uint8Array(length);
  let block = seed;
  for (let offset = 0; offset < length; offset += block.length) {
    block = await sha256(block);
    out.set(block.subarray(0, Math.min(block.length, length - offset)), offset);
  }
  return out;
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) =>
  new Uint8Array(hex.match(/.{2}/g)?.map((pair) => parseInt(pair, 16)) ?? []);

// Returns { id, decrypt } for a normalized guess.
export async function lookup(salt, normalizedGuess) {
  const seed = await digest(salt, normalizedGuess);
  return {
    id: toHex(seed.subarray(0, 8)),
    decrypt: async (cipherHex) => {
      const cipher = fromHex(cipherHex);
      const stream = await keystream(seed, cipher.length);
      return new TextDecoder().decode(cipher.map((byte, i) => byte ^ stream[i]));
    },
  };
}

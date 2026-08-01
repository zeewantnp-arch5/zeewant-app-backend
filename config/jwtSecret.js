// Centralised JWT signing secret. Fails fast at import time instead of
// silently falling back to a guessable default if the env var is missing.
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is not set. Refusing to start with an insecure default — set it in the environment."
  );
}

export default JWT_SECRET;

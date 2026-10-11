import { hash, verify } from "@node-rs/argon2";

/** Argon2id with library defaults (memory-hard). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Minimum policy for new passwords. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return "A senha deve ter pelo menos 10 caracteres.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "A senha deve conter letras e números.";
  return null;
}

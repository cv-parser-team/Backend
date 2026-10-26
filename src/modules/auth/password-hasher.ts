import argon2 from 'argon2';

export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$9HUhUnLP85i8ArsHe4PdRA$zQo8kKA6malDIHBpIMthW33QcQjpk5Pq53XmPcTYm7E';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export function createPasswordHasher(): PasswordHasher {
  return {
    hash(password) {
      return argon2.hash(password, { type: argon2.argon2id });
    },
    verify(hash, password) {
      return argon2.verify(hash, password);
    }
  };
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

function pending(): never {
  throw new Error('Password hashing is not implemented');
}

export function createPasswordHasher(): PasswordHasher {
  return {
    async hash(_password) {
      return pending();
    },
    async verify(_hash, _password) {
      return pending();
    }
  };
}

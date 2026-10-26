export interface RegisterBody {
  name: string;
  email: string;
  password: string;
}

export interface SignInBody {
  email: string;
  password: string;
}

// TODO: replace these contracts with JSON Schemas and inferred types when the
// routes are implemented.

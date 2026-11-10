import { AppDatabase } from '../infrastructure/database/database.js';
import {
  createNormalizationRepository
} from '../modules/normalization/normalization.repository.js';
import { seedDictionary } from '../modules/normalization/normalization.seed.js';

// Loads the starting normalization dictionary. Uses the same environment as
// the API, and adds only what is missing, so it can run again safely.
const database = new AppDatabase();
try {
  const { termsAdded, aliasesAdded } = await seedDictionary(
    createNormalizationRepository(database)
  );
  console.log(`Normalization dictionary: ${termsAdded} terms and ${aliasesAdded} aliases added`);
} finally {
  await database.close();
}

import { createReadStream } from 'node:fs';
import { config } from '../config/config.js';
import { AppDatabase } from '../infrastructure/database/database.js';
import { createPasswordHasher } from '../modules/auth/password-hasher.js';
import { createCandidatesRepository } from '../modules/candidates/candidates.repository.js';
import { createDocumentsRepository } from '../modules/documents/documents.repository.js';
import { createDocumentsService } from '../modules/documents/documents.service.js';
import { createLocalDocumentStorage } from '../modules/documents/documents.storage.js';
import { createDocumentValidator } from '../modules/documents/documents.validator.js';
import { createExtractionReviewRepository } from '../modules/extraction/extraction-review.repository.js';
import { createAiRequestRepository } from '../modules/normalization/normalization-ai-requests.repository.js';
import { createNormalizationRepository } from '../modules/normalization/normalization.repository.js';
import { seedDictionary } from '../modules/normalization/normalization.seed.js';
import { createNormalizationService } from '../modules/normalization/normalization.service.js';
import { DEMO_PASSWORD } from './demo/demo-data.js';
import { createDemoStore, resetDemoData } from './demo/demo-reset.js';
import { seedDemoData } from './demo/demo-seed.js';

// Replaces all demo data with a fresh copy. Uses the same environment as the
// API. AI normalization requests are queued when AI matching is enabled; the
// worker processes them.
const database = new AppDatabase();
try {
  const store = createDemoStore(database);
  const storage = createLocalDocumentStorage({
    storageRoot: config.documents.storageRoot,
    maximumByteSize: config.documents.maximumUploadByteSize
  });
  const documentsRepository = createDocumentsRepository(database);
  const documentsService = createDocumentsService({
    repository: documentsRepository,
    storage,
    validator: createDocumentValidator()
  });
  const candidatesRepository = createCandidatesRepository(database);
  const normalizationRepository = createNormalizationRepository(database);
  const aiEnabled = config.normalization.aiEnabled && Boolean(config.llm.apiKey);
  const normalization = createNormalizationService({
    repository: normalizationRepository,
    aiRequests: aiEnabled ? createAiRequestRepository(database) : undefined
  });
  const reviewRepository = createExtractionReviewRepository(database);
  const passwordHasher = createPasswordHasher();

  const result = await seedDemoData({
    nodeEnv: config.nodeEnv,
    reset: () => resetDemoData({ store, storage, nodeEnv: config.nodeEnv }),
    seedDictionary: () => seedDictionary(normalizationRepository),
    hashPassword: (password) => passwordHasher.hash(password),
    createUser: (input) => store.createUser(input),
    createCandidate: (input) => candidatesRepository.createCandidate(input),
    createClaim: (input) => candidatesRepository.createClaim(input),
    normalizeClaim: (claim) => normalization.normalizeClaim(claim),
    async createProcessedDocument(ownerUserId, filename) {
      const { document } = await documentsService.uploadDocument({
        ownerUserId,
        purpose: 'source',
        originalFilename: filename,
        stream: createReadStream(new URL('./demo/demo-resume.docx', import.meta.url))
      });
      await documentsRepository.markDocumentProcessing(document.documentId);
      await documentsRepository.markDocumentReady(document.documentId);
      return { documentId: document.documentId };
    },
    createReviewItems: (documentId, invocationId, items) =>
      reviewRepository.replacePendingForDocument(documentId, invocationId, items)
  });

  console.log(
    `Demo data ready (removed ${result.removed.users} old demo users). Password for every account: ${DEMO_PASSWORD}`
  );
  console.table(result.accounts);
  if (!aiEnabled) {
    console.log('AI normalization is off: set LLM_API_KEY to match the AI demo values.');
  }
} finally {
  await database.close();
}

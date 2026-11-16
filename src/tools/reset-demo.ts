import { config } from '../config/config.js';
import { AppDatabase } from '../infrastructure/database/database.js';
import { createLocalDocumentStorage } from '../modules/documents/documents.storage.js';
import { createDemoStore, resetDemoData } from './demo/demo-reset.js';

// Removes all demo data: demo users, everything they own, and their files.
const database = new AppDatabase();
try {
  const result = await resetDemoData({
    store: createDemoStore(database),
    storage: createLocalDocumentStorage({
      storageRoot: config.documents.storageRoot,
      maximumByteSize: config.documents.maximumUploadByteSize
    }),
    nodeEnv: config.nodeEnv
  });
  console.log(`Demo data removed: ${result.users} users and ${result.files} files`);
} finally {
  await database.close();
}

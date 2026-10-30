import { closeDb } from './index.js';
import { migrate } from './migrate.js';

await migrate();
console.log('Database migrations are up to date.');
await closeDb();

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config';
import { createDatabase } from './db/database';
import { createApp } from './http/app';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DATABASE_PATH ?? resolve(process.cwd(), 'data', 'store.sqlite');
if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

const db = createDatabase(dbPath);
const { app } = createApp({ db, config: loadConfig() });

app.listen(port, () => {
  console.log(`Checkout & Rewards API listening on http://localhost:${port}`);
  console.log(`SQLite file: ${dbPath}`);
});

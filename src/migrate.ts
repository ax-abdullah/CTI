import 'reflect-metadata';
import { AppDataSource } from './data-source';

/**
 * Standalone migration runner.
 *
 * The app used to apply migrations on boot (`migrationsRun: true`). With one
 * process that was fine; with N replicas they all race the same DDL, and
 * TypeORM takes no advisory lock — so two runners can both see a migration as
 * pending, both execute it, and the loser dies on a duplicate-object error
 * (or, for a data migration, applies it twice).
 *
 * Run this once before rolling the replicas: a Kubernetes `pre-upgrade` Job,
 * an init container, or `npm run migrate` by hand. Exits non-zero on failure
 * so a deploy stops rather than starting replicas against a half-migrated
 * schema.
 */
async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const applied = await AppDataSource.runMigrations();
    if (applied.length === 0) {
      // eslint-disable-next-line no-console
      console.log('Schema already up to date; nothing to apply.');
    } else {
      for (const m of applied) {
        // eslint-disable-next-line no-console
        console.log(`Applied ${m.name}`);
      }
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exit(1);
});

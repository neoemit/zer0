import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { RedisStore } from './store.js';

const config = loadConfig();
const store = RedisStore.fromUrl(config.redisUrl);
const app = await buildApp({ ...config, store });

const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await store.close();
};

process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });

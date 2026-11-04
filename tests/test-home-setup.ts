import { afterAll } from 'vitest';
import { installTestHomeIsolation } from './fixtures/test-home-lifecycle.js';

installTestHomeIsolation({ env: process.env, registerAfterAll: cleanup => afterAll(cleanup) });

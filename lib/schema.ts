import { z } from 'zod';

// Manifest V3 forbids eval-based schema compilation.
z.config({ jitless: true });

export { z };

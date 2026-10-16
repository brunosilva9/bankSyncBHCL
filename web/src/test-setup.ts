import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Sin esto el DOM de un test queda montado y contamina al siguiente.
afterEach(cleanup);

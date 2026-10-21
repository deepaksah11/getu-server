import fs from 'fs';

/** Removes the throwaway data directory created by vitest.config.ts. */
export default function setup() {
  return () => {
    const dir = process.env.DATA_DIR;
    if (dir && dir.includes('autoapply-test-')) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

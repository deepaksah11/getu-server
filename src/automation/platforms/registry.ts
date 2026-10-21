import { NormalizedJob } from '../../types/index.js';
import { ashbyAdapter } from './ashby.js';
import { demoAdapter } from './demo.js';
import { directAdapter } from './direct.js';
import { greenhouseAdapter } from './greenhouse.js';
import { indeedAdapter } from './indeed.js';
import { internshalaAdapter } from './internshala.js';
import { leverAdapter } from './lever.js';
import { linkedinAdapter } from './linkedin.js';
import { naukriAdapter } from './naukri.js';
import { unstopAdapter } from './unstop.js';
import { PlatformAdapter } from './types.js';

/** Order = order in which an automation run visits the platforms. */
export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  linkedinAdapter,
  naukriAdapter,
  indeedAdapter,
  unstopAdapter,
  internshalaAdapter,
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  directAdapter,
  demoAdapter,
];

export function getAdapter(platformId: string): PlatformAdapter | undefined {
  const id = platformId.toLowerCase();
  return PLATFORM_ADAPTERS.find((a) => a.id.toLowerCase() === id);
}

/** Adapter that applies to this job: its own platform, else by URL, else the generic career-site filler. */
export function adapterForJob(job: NormalizedJob): PlatformAdapter {
  return (
    getAdapter(job.platform) ||
    PLATFORM_ADAPTERS.find((a) => a !== directAdapter && a.canHandleUrl(job.application_url)) ||
    directAdapter
  );
}

/** Adapter for an external "apply on company site" URL. */
export function adapterForUrl(url: string): PlatformAdapter {
  return PLATFORM_ADAPTERS.find((a) => a !== directAdapter && !a.requiresLogin && a.canHandleUrl(url)) || directAdapter;
}

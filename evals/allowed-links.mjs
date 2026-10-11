// The links the assistant may give without a documentation search, for the
// evaluation runner. Plain Node cannot load src/domain/allowed-links.ts,
// which imports other TypeScript modules, so the list is repeated here; a
// unit test fails if the two differ.
export const ALLOWED_URLS = [
  "https://developers.cloudflare.com/support/contacting-cloudflare-support/",
  "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  "https://developers.cloudflare.com/workers/platform/pricing/",
  "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  "https://developers.cloudflare.com/workflows/reference/pricing/"
];

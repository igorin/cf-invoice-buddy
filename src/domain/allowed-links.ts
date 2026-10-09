import { ALLOWANCE_SOURCE } from "./allowances";
import { SUPPORT_URL } from "./credit-draft";
import { PRICE_TABLE } from "./plans";
import { LLAMA_3_3_PRICE } from "./self-cost";

/**
 * The fixed, reviewed list of links the assistant may give without a
 * documentation search (rule G-7): Cloudflare's support page, and the
 * pricing pages the app's own figures come from, which its tools name as
 * their source. Every other link must come from a search result.
 */
export const ALLOWED_URLS: ReadonlyArray<string> = [
  ...new Set([
    SUPPORT_URL,
    LLAMA_3_3_PRICE.source,
    ...ALLOWANCE_SOURCE.urls,
    ...PRICE_TABLE.urls
  ])
];

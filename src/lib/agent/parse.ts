import type { RequestType, ResourceKind } from "@/lib/db/types";

/**
 * Heuristic request parser used by the deterministic fallback path.
 *
 * When Bedrock is reachable the model does this job far better — it reads
 * intent, not keywords. This exists so a clean checkout with no AWS credentials
 * still runs the full pipeline end to end, and so the parsing step is unit
 * testable without a network call.
 */

export interface ParsedRequest {
  title: string;
  requestType: RequestType;
  resourceKind: ResourceKind | null;
  quantity: number;
  estimatedMonthlyCostUsd: number | null;
  vendor: string | null;
  environment: string | null;
  durationDays: number | null;
}

const RESOURCE_PATTERNS: ReadonlyArray<readonly [RegExp, ResourceKind]> = [
  [/\b(gpu|gpus|a100|h100|v100|accelerator|cuda)\b/i, "gpu"],
  [/\b(instance|vm|ec2|server|node|cluster|compute)\b/i, "cloud_instance"],
  [/\b(licen[cs]e|seat|subscription|saas|plan)\b/i, "saas_license"],
  [/\b(monitoring|observability|production service|apm|logging|tracing)\b/i, "production_service"],
];

const KNOWN_VENDORS = [
  "Datadog",
  "New Relic",
  "Grafana Cloud",
  "Splunk",
  "PagerDuty",
  "Sentry",
  "AWS",
  "GCP",
  "Azure",
  "Figma",
  "Linear",
  "Snowflake",
];

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

export function parseRequest(text: string): ParsedRequest {
  const normalized = text.trim();

  const resourceKind = detectResourceKind(normalized);
  const vendor = detectVendor(normalized);
  const environment = detectEnvironment(normalized);

  return {
    title: buildTitle(normalized),
    requestType: detectRequestType(normalized, resourceKind, vendor),
    resourceKind,
    quantity: detectQuantity(normalized),
    estimatedMonthlyCostUsd: detectCost(normalized),
    vendor,
    environment,
    durationDays: detectDuration(normalized),
  };
}

function detectResourceKind(text: string): ResourceKind | null {
  for (const [pattern, kind] of RESOURCE_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

function detectRequestType(
  text: string,
  kind: ResourceKind | null,
  vendor: string | null,
): RequestType {
  if (/\b(reuse|reallocate|use the existing|use existing|instead of provisioning)\b/i.test(text)) {
    return "resource_reuse";
  }
  if (/\b(access|permission|credential|role|onboard)\b/i.test(text)) return "access";
  if (kind === "saas_license" || (vendor && /\b(licen[cs]e|seat|subscription)\b/i.test(text))) {
    return "saas_license";
  }
  if (kind === "production_service") return "service_addition";
  if (kind) return "resource_provision";
  return "other";
}

function detectQuantity(text: string): number {
  const digits = /\b(\d{1,3})\s*(?:more\s+)?(?:additional\s+)?(?:gpu|instance|licen[cs]e|seat|node|server)/i.exec(text);
  if (digits?.[1]) {
    const parsed = Number.parseInt(digits[1], 10);
    if (parsed > 0 && parsed < 1000) return parsed;
  }

  const words =
    /\b(a|an|one|another|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more\s+)?(?:additional\s+)?(?:gpu|instance|licen[cs]e|seat|node|server)/i.exec(
      text,
    );
  const word = words?.[1]?.toLowerCase();
  if (word && word in NUMBER_WORDS) return NUMBER_WORDS[word] ?? 1;

  return 1;
}

function detectCost(text: string): number | null {
  const match =
    /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(?:\/\s*(mo|month|yr|year)|per\s+(month|year))?/i.exec(text);
  if (!match?.[1]) return null;

  const amount = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;

  const unit = (match[2] ?? match[3] ?? "").toLowerCase();
  if (unit.startsWith("y")) return Math.round((amount / 12) * 100) / 100;
  return amount;
}

function detectVendor(text: string): string | null {
  for (const vendor of KNOWN_VENDORS) {
    const pattern = new RegExp(`\\b${vendor.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (pattern.test(text)) return vendor;
  }
  return null;
}

function detectEnvironment(text: string): string | null {
  if (/\b(production|prod\b|live)\b/i.test(text)) return "production";
  if (/\bstaging\b/i.test(text)) return "staging";
  if (/\b(development|dev\b|local)\b/i.test(text)) return "development";
  return null;
}

function detectDuration(text: string): number | null {
  const days = /\b(\d{1,3})\s*(day|days)\b/i.exec(text);
  if (days?.[1]) return Number.parseInt(days[1], 10);

  const weeks = /\b(\d{1,2})\s*(week|weeks)\b/i.exec(text);
  if (weeks?.[1]) return Number.parseInt(weeks[1], 10) * 7;

  const months = /\b(\d{1,2})\s*(month|months)\b/i.exec(text);
  if (months?.[1]) return Number.parseInt(months[1], 10) * 30;

  if (/\b(temporar(y|ily)|short[- ]term|for now|trial)\b/i.test(text)) return 7;
  return null;
}

/** First sentence, trimmed to something that reads like a ticket title. */
function buildTitle(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const cleaned = firstSentence
    .replace(/^(hi|hey|hello)[, ]+/i, "")
    .replace(/^(can|could|may)\s+(i|we)\s+/i, "")
    .replace(/^(i|we)\s+(need|want|would like)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const titled = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return titled.length > 120 ? `${titled.slice(0, 117)}...` : titled || "Operational request";
}

export interface VacancyLocation {
  cities: string[];
  isRemote: boolean;
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function normalizeCity(city: string): string {
  return city.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

function addCity(cities: Map<string, string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const city = value.trim();
  const normalized = normalizeCity(city);
  if (normalized && !cities.has(normalized)) cities.set(normalized, city);
}

function collectLocationNames(value: unknown, cities: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLocationNames(item, cities);
    return;
  }
  if (!isObject(value)) {
    addCity(cities, value);
    return;
  }

  addCity(cities, value.name);
  addCity(cities, value.addressLocality);
  if (isObject(value.address)) addCity(cities, value.address.addressLocality);
}

function isRemoteValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /telecommute|remote|удал(?:ен|ён)/i.test(value);
}

function collectJobPostingNodes(value: unknown, nodes: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostingNodes(item, nodes);
    return;
  }
  if (!isObject(value)) return;

  const type = value['@type'];
  if (typeof type === 'string' && /jobposting/i.test(type)) nodes.push(value);
  if (Array.isArray(type) && type.some((item) => typeof item === 'string' && /jobposting/i.test(item))) {
    nodes.push(value);
  }
  collectJobPostingNodes(value['@graph'], nodes);
}

function hasRemoteWorkFormat(sourceHtml: string): boolean {
  const decoded = sourceHtml.replace(/&#34;|&#x22;|&quot;/gi, '"');
  const directFormats = decoded.matchAll(/["']workFormats["']\s*:\s*\[([^\]]*)\]/gi);
  for (const match of directFormats) {
    const formats = match[1];
    if (!formats.includes('{') && /["']REMOTE["']/i.test(formats)) return true;
  }

  const nestedFormats = decoded.matchAll(/["']workFormatsElement["']\s*:\s*\[([^\]]*)\]/gi);
  return [...nestedFormats].some((match) => /["']REMOTE["']/i.test(match[1]));
}

export function parseVacancyLocation(
  jsonLdScripts: string[],
  sourceHtml = '',
): VacancyLocation {
  const nodes: JsonObject[] = [];
  for (const script of jsonLdScripts) {
    try {
      collectJobPostingNodes(JSON.parse(script) as unknown, nodes);
    } catch {
      continue;
    }
  }

  const cities = new Map<string, string>();
  let isRemote = false;
  for (const node of nodes) {
    collectLocationNames(node.jobLocation, cities);
    collectLocationNames(node.areaServed, cities);
    isRemote ||= isRemoteValue(node.jobLocationType);
  }
  isRemote ||= hasRemoteWorkFormat(sourceHtml);

  return { cities: [...cities.values()], isRemote };
}

export interface LocationEligibility {
  eligible: boolean;
  reason: string;
}

export function checkLocationEligibility(
  location: VacancyLocation,
  onsiteCities: string[],
): LocationEligibility {
  const allowedCities = new Set(onsiteCities.map(normalizeCity).filter(Boolean));
  const onsiteCity = location.cities.find((city) => allowedCities.has(normalizeCity(city)));
  if (onsiteCity) return { eligible: true, reason: `Подходит город: ${onsiteCity}` };
  if (location.isRemote) return { eligible: true, reason: 'Удалённый формат' };

  if (location.cities.length > 0) {
    return {
      eligible: false,
      reason: `Город ${location.cities.join(', ')} не входит в список: ${onsiteCities.join(', ') || 'не задан'}`,
    };
  }
  return { eligible: false, reason: 'Город и удалённый формат не определены' };
}

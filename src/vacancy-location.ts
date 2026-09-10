export interface VacancyLocation {
  cities: string[];
  isRemote: boolean;
  workFormats: string[];
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
  if (isObject(value.address)) {
    addCity(cities, value.address.addressLocality);
    addCity(cities, value.address.city);
    if (isObject(value.address.city)) {
      addCity(cities, value.address.city.name);
      addCity(cities, value.address.city.title);
    }
  }
}

function collectLocationNamesFromSource(sourceHtml: string, cities: Map<string, string>): void {
  const decoded = sourceHtml.replace(/&#34;|&#x22;|&quot;/gi, '"');
  for (const match of decoded.matchAll(/["']address["']\s*:\s*\{([^{}]*?)\}/gi)) {
    const block = match[1];
    for (const id of block.matchAll(/["'](?:city|title|name|addressLocality)["']\s*:\s*["']([^"']+)["']/gi)) {
      addCity(cities, id[1]);
    }
  }
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

  // Trust only the explicitly selected work formats. Generic catalogs (e.g. all possible
  // options shown in a picker) can include REMOTE even when the vacancy is ON_SITE only.
  const selected = decoded.match(/["']selectedWorkFormats["']\s*:\s*\[([^\]]*)\]/i);
  if (selected && !selected[1].includes('{') && /["']REMOTE["']/i.test(selected[1])) return true;

  const singleFormat = decoded.match(/["']workFormat["']\s*:\s*["'](REMOTE|TELECOMMUTE)["']/i);
  if (singleFormat) return true;

  const nested = decoded.matchAll(/["']workFormatsElement["']\s*:\s*\[([^\]]*)\]/gi);
  for (const match of nested) {
    const content = match[1];
    if (!content.includes('{') && /["']REMOTE["']/i.test(content)) return true;
  }

  return false;
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
  collectLocationNamesFromSource(sourceHtml, cities);
  isRemote ||= hasRemoteWorkFormat(sourceHtml);

  return {
    cities: [...cities.values()],
    isRemote,
    workFormats: extractSelectedWorkFormatIds(sourceHtml),
  };
}

export function hasApplicationQuestionnaire(text: string): boolean {
  return /для отклика необходимо ответить на несколько вопросов работодателя/i.test(text);
}

export function extractSelectedWorkFormatIds(sourceHtml: string): string[] {
  const decoded = sourceHtml.replace(/&#34;|&#x22;|&quot;/gi, '"');
  const selected = new Set<string>();

  const selectedMatch = decoded.match(/["']selectedWorkFormats["']\s*:\s*\[([^\]]*)\]/i);
  if (selectedMatch && !selectedMatch[1].includes('{')) {
    for (const id of selectedMatch[1].matchAll(/["']([A-Z_]+)["']/g)) {
      selected.add(id[1].toUpperCase());
    }
  }

  const singleMatch = decoded.match(/["']workFormat["']\s*:\s*["']([A-Z_]+)["']/i);
  if (singleMatch) selected.add(singleMatch[1].toUpperCase());

  for (const match of decoded.matchAll(/["']workFormatsElement["']\s*:\s*\[([^\]]*)\]/gi)) {
    if (match[1].includes('{')) continue;
    for (const id of match[1].matchAll(/["']([A-Z_]+)["']/g)) {
      selected.add(id[1].toUpperCase());
    }
  }

  return [...selected];
}

export interface LocationEligibility {
  eligible: boolean;
  reason: string;
}

export function checkLocationEligibility(
  location: VacancyLocation,
  onsiteCities: string[],
  selectedWorkFormats: string[] = [],
): LocationEligibility {
  const allowedCities = new Set(onsiteCities.map(normalizeCity).filter(Boolean));
  const onsiteCity = location.cities.find((city) => allowedCities.has(normalizeCity(city)));
  if (onsiteCity) {
    return {
      eligible: true,
      reason: `Подходит город: ${onsiteCity}${selectedWorkFormats.length ? ` (${selectedWorkFormats.join(', ')})` : ''}`,
    };
  }

  // Outside the onsite list, the candidate only accepts vacancies that allow remote work.
  const remoteLike = new Set(['REMOTE', 'TELECOMMUTE']);
  const hasRemote = selectedWorkFormats.some((id) => remoteLike.has(id));
  if (hasRemote) return { eligible: true, reason: 'Удалённый формат' };

  if (location.cities.length > 0) {
    return {
      eligible: false,
      reason: `Город ${location.cities.join(', ')} не входит в список: ${onsiteCities.join(', ') || 'не задан'}; удалённый формат не выбран (${selectedWorkFormats.join(', ') || 'не определён'})`,
    };
  }
  return { eligible: false, reason: 'Город и удалённый формат не определены' };
}

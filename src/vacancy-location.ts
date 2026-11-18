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

function hasRemoteWorkFormat(sourceHtml: string, domWorkFormatText = ''): boolean {
  if (domWorkFormatText && /удал(?:ен|ён)|remote|telecommute/i.test(domWorkFormatText)) {
    return true;
  }

  if (/["'](?:vacancy-label-)?work-schedule-remote["']/i.test(sourceHtml)) {
    return true;
  }

  const formatTextMatch = sourceHtml.match(/data-qa=["'](?:work-formats?(?:-text)?|vacancy-view-work-formats?)["'][^>]*>([\s\S]*?)<\/(?:div|span|dl|dd)>/i);
  if (formatTextMatch && /удал(?:ен|ён)|remote|telecommute/i.test(formatTextMatch[1])) {
    return true;
  }

  const ddRemoteMatch = sourceHtml.match(/<dt[^>]*>[^<]*Формат работы[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
  if (ddRemoteMatch && /удал(?:ен|ён)|remote|telecommute/i.test(ddRemoteMatch[1])) {
    return true;
  }

  const partsMatches = sourceHtml.matchAll(/class=["'][^"']*parts--[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
  for (const m of partsMatches) {
    const text = m[1].replace(/<[^>]+>/g, ' ');
    if (/удал(?:ен|ён)но|remote|telecommute/i.test(text)) {
      return true;
    }
  }

  const decoded = sourceHtml.replace(/&#34;|&#x22;|&quot;/gi, '"');

  // Trust explicitly selected work formats in "workFormats":["REMOTE"] or "selectedWorkFormats":["REMOTE"].
  // Generic catalogs (e.g. all possible options) contain ON_SITE, REMOTE, and HYBRID together, or objects with '{'.
  for (const match of decoded.matchAll(/["'](?:selectedWorkFormats|workFormats)["']\s*:\s*\[([^\]]*)\]/gi)) {
    const content = match[1];
    if (content.includes('{')) continue;
    const ids = [...content.matchAll(/["']([A-Z_]+)["']/g)].map((m) => m[1].toUpperCase());
    if (ids.includes('REMOTE') && !(ids.includes('ON_SITE') && ids.includes('REMOTE') && ids.includes('HYBRID'))) {
      return true;
    }
  }

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
  domWorkFormatText = '',
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
  isRemote ||= hasRemoteWorkFormat(sourceHtml, domWorkFormatText);

  const workFormats = extractSelectedWorkFormatIds(sourceHtml, domWorkFormatText);
  if (isRemote && !workFormats.includes('REMOTE')) {
    workFormats.push('REMOTE');
  }

  return {
    cities: [...cities.values()],
    isRemote,
    workFormats,
  };
}

export function hasApplicationQuestionnaire(text: string): boolean {
  return /для отклика необходимо ответить на несколько вопросов работодателя/i.test(text);
}

export function extractSelectedWorkFormatIds(sourceHtml: string, domWorkFormatText = ''): string[] {
  const selected = new Set<string>();

  const checkText = (text: string) => {
    if (/удал(?:ен|ён)|remote|telecommute/i.test(text)) selected.add('REMOTE');
    if (/гибрид|hybrid/i.test(text)) selected.add('HYBRID');
    if (/на месте|разъездн|в офисе|on[-_]?site/i.test(text)) selected.add('ON_SITE');
  };

  if (domWorkFormatText) {
    checkText(domWorkFormatText);
  }

  if (/["'](?:vacancy-label-)?work-schedule-remote["']/i.test(sourceHtml)) {
    selected.add('REMOTE');
  }

  const formatTextMatch = sourceHtml.match(/data-qa=["'](?:work-formats?(?:-text)?|vacancy-view-work-formats?)["'][^>]*>([\s\S]*?)<\/(?:div|span|dl|dd)>/i);
  if (formatTextMatch) {
    checkText(formatTextMatch[1].replace(/<[^>]+>/g, ' '));
  }

  const ddMatch = sourceHtml.match(/<dt[^>]*>[^<]*Формат работы[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
  if (ddMatch) {
    checkText(ddMatch[1].replace(/<[^>]+>/g, ' '));
  }

  const partsMatches = sourceHtml.matchAll(/class=["'][^"']*parts--[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
  for (const m of partsMatches) {
    checkText(m[1].replace(/<[^>]+>/g, ' '));
  }

  const decoded = sourceHtml.replace(/&#34;|&#x22;|&quot;/gi, '"');

  for (const match of decoded.matchAll(/["'](?:selectedWorkFormats|workFormats)["']\s*:\s*\[([^\]]*)\]/gi)) {
    const content = match[1];
    if (content.includes('{')) continue;
    const ids = [...content.matchAll(/["']([A-Z_]+)["']/g)].map((m) => m[1].toUpperCase());
    if (ids.includes('ON_SITE') && ids.includes('REMOTE') && ids.includes('HYBRID')) continue;
    for (const id of ids) {
      selected.add(id);
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
  const hasRemote = location.isRemote || selectedWorkFormats.some((id) => remoteLike.has(id));
  if (hasRemote) return { eligible: true, reason: 'Удалённый формат' };

  if (location.cities.length > 0) {
    return {
      eligible: false,
      reason: `Город ${location.cities.join(', ')} не входит в список: ${onsiteCities.join(', ') || 'не задан'}; удалённый формат не выбран (${selectedWorkFormats.join(', ') || 'не определён'})`,
    };
  }
  return { eligible: false, reason: 'Город и удалённый формат не определены' };
}

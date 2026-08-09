const GENERIC_TOKENS = new Set([
  'hot', 'wheels', 'mini', 'gt', 'pop', 'race', 'time', 'micro', 'model',
  'diecast', 'scale', 'set', 'pack', 'box', 'blister', 'limited', 'edition',
  'car', 'cars', 'the', 'and', 'with', 'for', 'of', 'in', 'to', 'a', '1', '64',
  '2023', '2024', '2025', '2026'
]);

const COLORS = [
  'red', 'blue', 'green', 'black', 'white', 'silver', 'gold', 'yellow', 'orange',
  'purple', 'pink', 'grey', 'gray', 'chrome', 'metallic', 'teal', 'bronze'
];

const BRAND_PATTERNS = {
  'hot wheels': /hot[\s-]*wheels/i,
  'mini gt': /mini[\s-]*gt|\bmgt0*\d+/i,
  'pop race': /pop[\s-]*race/i,
  'time micro': /time[\s-]*micro/i,
  'inno64': /inno[\s-]*64/i,
  'morecar': /more[\s-]*car/i,
  'hg': /(?:^|[^a-z])hg(?:[^a-z]|$)/i
};

function normalize(value = '') {
  let decoded = String(value);
  try { decoded = decodeURIComponent(decoded); } catch { /* keep original text */ }
  return decoded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function meaningfulTokens(value = '') {
  return normalize(value).split(/\s+/).filter(token => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

function brandIsCompatible(brand, haystack) {
  const normalizedBrand = normalize(brand);
  const expectedPattern = BRAND_PATTERNS[normalizedBrand];
  if (!expectedPattern) return true;
  if (!expectedPattern.test(haystack)) return false;
  return !Object.entries(BRAND_PATTERNS).some(([otherBrand, pattern]) => otherBrand !== normalizedBrand && pattern.test(haystack));
}

export function validateImageMatch(product, candidate, manufacturerSkuCandidate = '') {
  const haystack = normalize([
    candidate?.title,
    candidate?.pageUrl || candidate?.sourcePage,
    candidate?.imageUrl || candidate?.sourceImageUrl
  ].filter(Boolean).join(' '));

  if (!haystack) return { valid: false, reason: 'Candidate has no searchable source metadata.' };
  if (!brandIsCompatible(product.brand, haystack)) return { valid: false, reason: `Source brand does not match ${product.brand}.` };

  const manufacturerDigits = String(manufacturerSkuCandidate || '').replace(/\D/g, '').replace(/^0+/, '');
  if (manufacturerDigits) {
    const numberPattern = new RegExp(`(?:^|[^0-9])0*${manufacturerDigits}(?:[^0-9]|$)`);
    if (!numberPattern.test(haystack)) return { valid: false, reason: `Source does not contain manufacturer model number ${manufacturerDigits}.` };
    return { valid: true, reason: 'Exact manufacturer model number and brand matched.' };
  }

  const productTokens = [...new Set(meaningfulTokens(product.name))];
  const matchingTokens = productTokens.filter(token => haystack.includes(token));
  const requiredMatches = productTokens.length <= 2 ? 1 : 2;
  if (matchingTokens.length < requiredMatches) {
    return { valid: false, reason: `Only ${matchingTokens.length} distinctive model token(s) matched; ${requiredMatches} required.` };
  }

  const normalizedNameTokens = normalize(product.name).split(' ');
  const sourceTokens = haystack.split(' ');
  const expectedColors = COLORS.filter(color => normalizedNameTokens.includes(color));
  const sourceColors = COLORS.filter(color => sourceTokens.includes(color));
  if (expectedColors.length > 0 && !expectedColors.some(color => sourceColors.includes(color)) && sourceColors.length > 0) {
    return { valid: false, reason: `Source colour ${sourceColors.join(', ')} conflicts with ${expectedColors.join(', ')}.` };
  }

  return { valid: true, reason: `Brand and model tokens matched: ${matchingTokens.join(', ')}.` };
}

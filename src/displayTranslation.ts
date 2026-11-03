export type DisplayTranslator = (source: string, values?: Record<string, unknown>) => string;
export const sourceTranslation: DisplayTranslator = (source, values = {}) => source.replace(/\{\{(\w+)\}\}/g,
  (match, key) => values[key] === undefined ? match : String(values[key]));

// Hosts may provide their own translation engine; the reusable kit has no
// dependency on a product's locale, storage or React provider.
export type FeedbackTranslate = (message: string, params?: Record<string, unknown>) => string;
export const feedbackSourceText: FeedbackTranslate = (message, params) => message.replace(/\{\{(\w+)\}\}/g,
  (match, key: string) => params?.[key] === undefined ? match : String(params[key]));

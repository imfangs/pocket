export const directivePattern: RegExp;
export function directiveAttributes(source: string): Record<string, string> | null;
export function protectedMarkdownRanges(source: string, includeHtml?: boolean): [number, number][];
export function localFileReference(value: unknown, decode?: boolean): string | null;
export function referencedMessageFiles(source: string): string[];
export function directiveIsEscaped(source: string, start: number): boolean;

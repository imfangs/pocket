export type TurnFailure = { turnId: string; status: "failed"; message?: string; code?: string; additionalDetails?: string; timestamp?: number };
export function turnFailureFromError(turnId: unknown, error: unknown, timestamp?: unknown): TurnFailure | null;
export function normalizeTurnFailures(value: unknown): TurnFailure[];

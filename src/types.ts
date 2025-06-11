import type { Condition, Filter, WithId, Document } from "mongodb";

type ResponseStatus = "ok" | "hasErrors";

export type QueryResponse<T, S extends keyof T = keyof T> = {
    data: Pick<T, S>[];
    status: ResponseStatus;
    error?: string;
    queryFilter: TypeSafeFilter<T> | undefined;
};

export type QueryResponseSingle<T, S extends keyof T = keyof T> = {
    data: Pick<T, S> | null;
    status: ResponseStatus;
    error?: string;
    queryFilter: TypeSafeFilter<T> | undefined;
};

export type InsertResponse<T> = {
    data: T | null;
    error?: string;
    status: ResponseStatus;
};

export type LoggerLike = {
    log(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
    debug(message: string, ...meta: unknown[]): void;
};

export type Insertable<T> = Omit<T, "_id" | "created_at" | "updated_at">;

/**
 * Custom type that omits `Document` type in the root FilterOperators because
 * it basically breaks all types...
 */
export type TypeSafeFilter<T> = {
    [P in keyof WithId<T>]?: Condition<WithId<T>[P]>;
} & {
    $and?: Filter<T>[];
    $nor?: Filter<T>[];
    $or?: Filter<T>[];
    $text?: {
        $search: string;
        $language?: string;
        $caseSensitive?: boolean;
        $diacriticSensitive?: boolean;
    };
    $where?: string | ((this: T) => boolean);
    $comment?: string | Document;
};

export type AggregateResponse<T> = {
    data: T[];
    status: ResponseStatus;
    error?: string;
    pipeline: Document[] | undefined;
};

export type LogToFileFunction = (
    error: unknown,
    context?: string,
) => Promise<void>;

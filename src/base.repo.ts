import {
    type Abortable,
    type AggregateOptions,
    type Collection,
    type Db,
    type Document,
    type Filter,
    type FindOptions,
    type InsertOneResult,
    ObjectId,
    type UpdateFilter,
    type UpdateOptions,
    type WithId,
} from "mongodb";
import { z } from "zod";
import type {
    AggregateResponse,
    Insertable,
    InsertResponse,
    LoggerLike,
    LogToFileFunction,
    QueryResponse,
    QueryResponseSingle,
    TypeSafeFilter,
} from "./types";
import { defaultLogErrorToFile, getNestLogger } from "./utils";

/**
 * A type-safe MongoDB repository base class that provides runtime schema validation using Zod.
 *
 * **Usage:**
 * ```typescript
 * // Define your schema
 * const UserSchema = z.object({
 *   name: z.string(),
 *   email: z.string().email(),
 *   age: z.number().optional()
 * });
 *
 * // Extend RepoBase
 * class UserRepo extends RepoBase<z.infer<typeof UserSchema>> {
 *   constructor(db: Db) {
 *     super(db, 'users', UserSchema);
 *   }
 * }
 *
 * // Use with full type safety
 * const users = await userRepo.find({
 *   filter: { age: { $gte: 18 } },
 *   select: ['name', 'email'] // Only these fields will be returned
 * });
 * ```
 *
 * **Error Handling:**
 * All operations return a standardized response format with `{ data, status, error }`
 * for consistent error handling across your application.
 *
 * @template T The document type (typically inferred from your Zod schema)
 */
export abstract class RepoBase<T> {
    static globalLogToFile: LogToFileFunction = defaultLogErrorToFile;

    protected collection: Collection;
    protected logErrorToFile: LogToFileFunction;
    protected logger: LoggerLike;
    protected schema: z.ZodType<T, z.ZodTypeDef, unknown>;

    constructor(
        protected readonly db: Db,
        collectionName: string,
        schema: z.ZodType<T, z.ZodTypeDef, unknown>,
        logger?: LoggerLike,
        customLogToFile?: LogToFileFunction,
    ) {
        this.collection = this.db.collection(collectionName);
        this.schema = schema;

        if (logger) {
            this.logger = logger;
        } else {
            this.logger = console;
            void this.initLogger(collectionName); // Consider adding a public method to ensure the logger is properly initialized for cases where code needs to use the logger immediately after construction
        }

        this.logErrorToFile = customLogToFile ?? RepoBase.globalLogToFile;
    }

    /**
     * Query the driver directly, bypassing schema validation.
     *
     * @warning Not recommended for production!
     */
    async _rawFind(
        filter: TypeSafeFilter<T>,
        options?: FindOptions & Abortable,
    ) {
        return await this.collection
            .find(filter as Filter<Document>, options)
            .toArray();
    }

    /**
     * Run a MongoDB aggregation pipeline with optional runtime validation.
     *
     * ⚠️ If the result is anything other than the full document shape (`T`),
     * you must provide a matching generic type argument `U` along with a `schema`
     * (a Zod schema matching the projected shape).
     *
     * To bypass validation entirely, pass `schema: false`.
     *
     * @param pipeline - The aggregation pipeline to run.
     * @param options - Optional MongoDB aggregate options.
     * @param schema - Optional Zod schema for validating output shape. Pass `false` to skip validation.
     */
    async aggregate<U = T>({
        pipeline,
        options,
        schema,
    }: {
        pipeline: Document[];
        options?: AggregateOptions & Abortable;
        schema?: z.ZodType<U> | false;
    }): Promise<AggregateResponse<U>> {
        try {
            let status: AggregateResponse<U>["status"] = "ok";
            let error: AggregateResponse<U>["error"];

            const results = await this.collection
                .aggregate(pipeline, options)
                .toArray();

            const effectiveSchema =
                schema === false ? undefined : (schema ?? this.schema);

            if (effectiveSchema) {
                const parsedResults = results.map((r) =>
                    effectiveSchema.safeParse(r),
                );

                const validResults = parsedResults
                    .filter((result) => result.success)
                    .map((result) => result.data);

                const invalidResults = parsedResults
                    .filter((result) => !result.success)
                    .map((result, index) => ({
                        originalData: results[index],
                        errors: result.error.issues,
                    }));

                if (invalidResults.length > 0) {
                    const errorMsg = `${invalidResults.length} ${this.collection.collectionName} document(s) failed validation during aggregate`;
                    this.logger.warn(
                        errorMsg,
                        JSON.stringify(invalidResults, null, 2),
                    );
                    status = "hasErrors";
                    error = errorMsg;
                }

                return {
                    data: validResults as U[],
                    error,
                    status,
                    pipeline: error ? pipeline : undefined,
                };
            }

            return {
                data: results as U[],
                status,
                pipeline: undefined,
            };
        } catch (error) {
            const err = error as Error;
            this.logger.error(`Aggregate failed`, err);

            this.writeLogErrorIfDev(
                error,
                `${this.collection.collectionName}.aggregate`,
            );

            return {
                data: [],
                status: "hasErrors",
                error: err.message,
                pipeline: pipeline,
            };
        }
    }

    /**
     * Wrapper around MongoDB's `.find` function that implements type-safe select
     * with dynamic schema.
     */
    async find<
        K extends keyof z.infer<typeof this.schema> = keyof z.infer<
            typeof this.schema
        >,
    >({
        filter,
        max = undefined,
        select = undefined,
    }: {
        filter: TypeSafeFilter<T>;
        max?: number;
        select?: K[];
    }): Promise<QueryResponse<T, K>> {
        let query = this.collection.find(filter as Filter<Document>);

        if (max !== undefined) {
            query = query.limit(max);
        }

        const { projection, dynamicSchema } =
            this.generateProjectionAndSchema(select);

        if (projection) {
            query = query.project(projection);
        }

        const results = await query.toArray();

        let status: QueryResponse<T>["status"] = "ok";
        let error: QueryResponse<T>["error"];

        const parsedResults = results.map((result) =>
            dynamicSchema.safeParse(result),
        );

        const validResults = parsedResults
            .filter((result) => result.success)
            .map((result) => result.data);

        const invalidResults = parsedResults
            .filter((result) => !result.success)
            .map((result, index) => ({
                originalData: results[index],
                errors: result.error.issues,
            }));

        if (validResults.length !== results.length) {
            const errorMsg = `${invalidResults.length} ${this.collection.collectionName} document(s) failed validation during find`;
            this.logger.warn(errorMsg, JSON.stringify(invalidResults, null, 2));
            this.writeLogErrorIfDev(
                { error: errorMsg, invalidResults },
                `${this.collection.collectionName}.find`,
            );

            status = "hasErrors";
            error = errorMsg;
        }

        return {
            data: validResults,
            error,
            status,
            queryFilter: error ? filter : undefined,
        };
    }

    async findOne<
        K extends keyof z.infer<typeof this.schema> = keyof z.infer<
            typeof this.schema
        >,
    >({
        filter,
        select = undefined,
    }: {
        filter: TypeSafeFilter<T>;
        select?: K[];
    }): Promise<QueryResponseSingle<T, K>> {
        const { projection, dynamicSchema } =
            this.generateProjectionAndSchema(select);

        const result = await this.collection.findOne(
            filter as Filter<Document>,
            projection,
        );

        let status: QueryResponse<T>["status"] = "ok";
        let error: QueryResponse<T>["error"];

        if (!result) {
            return {
                data: null,
                error,
                status,
                queryFilter: error ? filter : undefined,
            };
        }

        const { error: parseError, data } = dynamicSchema.safeParse(result);

        if (parseError) {
            const errorMsg = `1 ${this.collection.collectionName} document failed validation during findOne`;
            const invalidResult = {
                originalData: data,
                errors: parseError.issues,
            };
            this.logger.warn(errorMsg, {
                invalidResult,
            });
            this.writeLogErrorIfDev(
                { error: errorMsg, invalidResult },
                `${this.collection.collectionName}.findOne`,
            );

            status = "hasErrors";
            error = errorMsg;
        }

        return {
            data: data ?? null,
            error,
            status,
            queryFilter: error ? filter : undefined,
        };
    }

    /**
     * Atomic operators (`$set`, `$inc` etc.) must be used in `update` rather than directly manipulating the fields.
     */
    async findOneAndUpdate<
        K extends keyof z.infer<typeof this.schema> = keyof z.infer<
            typeof this.schema
        >,
    >({
        filter,
        update,
        select = undefined,
        options = {},
    }: {
        filter: TypeSafeFilter<T>;
        update: UpdateFilter<T>;
        select?: K[];
        options?: UpdateOptions;
    }): Promise<QueryResponse<T, K>> {
        const funcName = "findOneAndUpdate";

        let status: QueryResponse<T>["status"] = "ok";
        let error: QueryResponse<T>["error"];

        const { projection, dynamicSchema } =
            this.generateProjectionAndSchema(select);

        const updateObj = update as UpdateFilter<Document>;

        const extractedPayload = this.extractUpdatePayload(update);

        let partialSchema: z.ZodTypeAny;
        if (dynamicSchema instanceof z.ZodObject) {
            partialSchema = dynamicSchema.partial();
        } else if (this.schema instanceof z.ZodObject) {
            partialSchema = this.schema.partial();
        } else {
            partialSchema = this.schema;
        }

        const { error: parseErrorPrior } =
            partialSchema.safeParse(extractedPayload);

        if (parseErrorPrior) {
            const errorMsg = `1 ${this.collection.collectionName} document failed validation before findOneAndUpdate`;
            this.logger.warn(errorMsg);
            this.logger.warn("Original Data:");
            this.logger.warn(JSON.stringify(updateObj, null, 2));
            this.logger.warn("Validation Errors:");
            this.logger.warn(JSON.stringify(parseErrorPrior.issues, null, 2));
            status = "hasErrors";
            error = errorMsg;

            this.writeLogErrorIfDev(
                { error: errorMsg, parseErrorIssues: parseErrorPrior.issues },
                `${this.collection.collectionName}.${funcName}`,
            );

            return {
                data: [],
                error,
                status,
                queryFilter: error ? filter : undefined,
            };
        }

        let result: WithId<Document> | null = null;

        try {
            result = await this.collection.findOneAndUpdate(
                filter as Filter<Document>,
                {
                    ...updateObj,
                    $set: {
                        ...(updateObj.$set ?? {}),
                        updated_at: new Date(),
                    },
                },
                {
                    returnDocument: "after",
                    projection,
                    ...options,
                    hint: options.hint as Document | undefined,
                },
            );
        } catch (err) {
            const errorMsg = `1 ${this.collection.collectionName} document failed findOneAndUpdate in mongodb`;
            status = "hasErrors";
            error = errorMsg;
            this.writeLogErrorIfDev(
                err,
                `${this.collection.collectionName}.${funcName}`,
            );

            return {
                data: [],
                error,
                status,
                queryFilter: error ? filter : undefined,
            };
        }

        if (!result) {
            const errorMsg = `1 ${this.collection.collectionName} document returned null findOneAndUpdate in mongodb`;
            status = "hasErrors";
            error = errorMsg;
            this.writeLogErrorIfDev(
                errorMsg,
                `${this.collection.collectionName}.${funcName}`,
            );

            return {
                data: [],
                error,
                status,
                queryFilter: error ? filter : undefined,
            };
        }

        // FIXME
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { error: parseError, data } = dynamicSchema.safeParse(result);

        if (parseError) {
            const errorMsg = `1 ${this.collection.collectionName} document failed validation after findOneAndUpdate`;
            this.logger.warn(errorMsg);
            this.logger.warn("Original Data:");
            this.logger.warn(JSON.stringify(result, null, 2));
            this.logger.warn("Validation Errors");
            this.logger.warn(JSON.stringify(parseError.issues, null, 2));
            status = "hasErrors";
            error = errorMsg;

            this.writeLogErrorIfDev(
                { error: errorMsg, parseErrorIssues: parseError.issues },
                `${this.collection.collectionName}.${funcName}`,
            );
        }

        return {
            // FIXME
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            data: data ? [data] : [],
            error,
            status,
            queryFilter: error ? filter : undefined,
        };
    }

    async getAll({ max }: { max?: number } = {}) {
        return this.find({ filter: {}, max });
    }

    async insertOne(input: Insertable<T>): Promise<InsertResponse<T>> {
        const funcName = "insertOne";
        const _input = this.buildInsertPayload(input);
        const parsed = this.schema.safeParse(_input);

        if (!parsed.success) {
            const errorMsg = `Failed to insert document: schema validation failed`;
            const errorIssues = parsed.error.issues;
            const errorFull = `${errorMsg} ${JSON.stringify(errorIssues)}`;
            this.logger.warn(errorMsg, {
                errors: errorIssues,
            });

            this.writeLogErrorIfDev(
                { error: errorMsg, parseErrorIssues: errorIssues },
                `${this.collection.collectionName}.${funcName}`,
            );

            return {
                data: null,
                error: errorFull,
                status: "hasErrors",
            };
        }

        const parsedData = parsed.data as Partial<Document>;

        let insertResult: InsertOneResult<Document>;
        try {
            insertResult = await this.collection.insertOne(parsedData);
        } catch (err) {
            const errorMsg = `MongoDB failed to insertOne`;
            this.logger.error(errorMsg, {
                err,
            });

            this.writeLogErrorIfDev(
                { error: errorMsg, err },
                `${this.collection.collectionName}.${funcName}`,
            );

            return {
                data: null,
                error: errorMsg,
                status: "hasErrors",
            };
        }

        if (!insertResult.acknowledged) {
            const errorMsg = `MongoDB failed to acknowledge insert`;
            this.logger.error(errorMsg, {
                attemptedData: parsed.data,
            });

            this.writeLogErrorIfDev(
                { error: errorMsg, attemptedData: parsed.data },
                `${this.collection.collectionName}.${funcName}`,
            );

            return {
                data: null,
                error: errorMsg,
                status: "hasErrors",
            };
        }

        return {
            data: parsed.data,
            status: "ok",
        };
    }

    protected writeLogErrorIfDev(error: unknown, context: string) {
        if (process.env["DEBUG_DISABLE_DB_ERROR_LOG"] === "true") {
            return;
        }
        if (process.env.NODE_ENV === "development") {
            void this.logErrorToFile?.(error, context);
        }
    }

    private buildInsertPayload(input: Insertable<T>): T {
        const now = new Date();
        return {
            ...input,
            _id: new ObjectId(),
            created_at: now,
            updated_at: now,
        } as T;
    }

    /**
     * Extracts data from within MongoDB operators.
     *
     * @warning ⚠️ Does not support dot notation
     */
    private extractUpdatePayload(update: UpdateFilter<T>): Partial<T> {
        const extracted: Partial<T> = {};

        function walk(obj: UpdateFilter<T>) {
            for (const [key, val] of Object.entries(obj)) {
                if (key.startsWith("$")) {
                    if (typeof val === "object" && val !== null) {
                        for (const [fieldKey, fieldVal] of Object.entries(
                            val as Record<string, unknown>,
                        )) {
                            if (fieldKey.includes(".")) {
                                throw new Error(
                                    `Dot notation keys are not supported yet: "${fieldKey}"`,
                                );
                            }

                            extracted[fieldKey as keyof T] =
                                key === "$unset"
                                    ? undefined
                                    : (fieldVal as T[keyof T]);
                        }
                    }
                } else {
                    if (key.includes(".")) {
                        throw new Error(
                            `Dot notation keys are not supported yet: "${key}"`,
                        );
                    }

                    extracted[key as keyof T] = val as T[keyof T];
                }
            }
        }

        walk(update);
        return extracted;
    }

    private generateDynamicSchema<K extends keyof z.infer<typeof this.schema>>(
        select?: K[],
    ): z.ZodSchema<Pick<z.infer<typeof this.schema>, K>> {
        if (!select || select.length === 0) {
            return this.schema as z.ZodSchema<
                Pick<z.infer<typeof this.schema>, K>
            >;
        }

        if (!(this.schema instanceof z.ZodObject)) {
            throw new Error("Only object Zod schemas are supported for select");
        }

        const schemaShape = (this.schema as z.ZodObject<z.ZodRawShape>).shape;

        const selectedShape = Object.fromEntries(
            select
                .filter((field) => field in schemaShape)
                .map((field) => [
                    field,
                    schemaShape[field as keyof typeof schemaShape],
                ]),
        );

        return z.object(selectedShape) as z.ZodSchema<
            Pick<z.infer<typeof this.schema>, K>
        >;
    }

    private generateProjection<K extends keyof z.infer<typeof this.schema>>(
        select?: K[],
    ): Record<string, 1> | undefined {
        return select
            ? Object.fromEntries(select.map((field) => [field, 1]))
            : undefined;
    }

    private generateProjectionAndSchema<K extends keyof T>(
        select?: K[],
    ): {
        projection: Record<string, 1> | undefined;
        dynamicSchema: z.ZodSchema<Pick<T, K>>;
    } {
        return {
            projection: this.generateProjection(select),
            dynamicSchema: this.generateDynamicSchema(select),
        };
    }

    private async initLogger(collectionName: string): Promise<void> {
        if (this.logger === console) {
            try {
                this.logger = await getNestLogger(collectionName);
            } catch {
                this.logger = console;
            }
        }
    }
}

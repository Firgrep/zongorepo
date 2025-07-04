import { z } from "zod";
import { RepoBase } from "./base.repo";
import type { UpdateFilter } from "mongodb";
import { describe, it, expect } from "vitest";

const testSchema = z.object({
    name: z.string(),
    status: z.enum(["pending", "sent", "failed"]),
    count: z.number().optional(),
    archivedAt: z.date().optional(),
    last_attempt_at: z.date().optional(),
});

const mockDb = {
    collection: () => ({
        collectionName: "test",
    }),
};

class TestRepo extends RepoBase<z.infer<typeof testSchema>> {
    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        super(mockDb as any, "test", testSchema);
    }

    public testExtract(update: UpdateFilter<z.infer<typeof testSchema>>) {
        // @ts-expect-error accessing private method for test
        return this.extractUpdatePayload(update);
    }
}

describe("extractUpdatePayload", () => {
    const repo = new TestRepo();

    it("should extract from $set", () => {
        const update = {
            $set: {
                name: "John",
                status: "sent",
            },
        } as const;
        expect(repo.testExtract(update)).toEqual({
            name: "John",
            status: "sent",
        });
    });

    it("should extract from $unset", () => {
        const update = {
            $unset: {
                archivedAt: "",
            },
        } as const;
        expect(repo.testExtract(update)).toEqual({
            archivedAt: undefined,
        });
    });

    it("should extract from mixed operators", () => {
        const now = new Date();
        const update = {
            $set: {
                status: "sent",
                count: 1,
            },
            $unset: {
                archivedAt: "",
            },
            last_attempt_at: now,
        } as const;
        expect(repo.testExtract(update)).toEqual({
            status: "sent",
            count: 1,
            archivedAt: undefined,
            last_attempt_at: now,
        });
    });

    it("should extract direct updates", () => {
        const update = {
            name: "Alice",
            count: 42,
        };
        expect(repo.testExtract(update)).toEqual({
            name: "Alice",
            count: 42,
        });
    });

    it("should return an empty object for an empty update", () => {
        const update = {};
        expect(repo.testExtract(update)).toEqual({});
    });

    it("should let direct keys override operator values when duplicated", () => {
        const update = {
            $set: {
                name: "John",
            },
            name: "Alice",
        };
        expect(repo.testExtract(update)).toEqual({
            name: "Alice", // Direct key wins
        });
    });

    it("should extract $inc as-is", () => {
        const update = {
            $inc: {
                count: 2,
            },
        };
        expect(repo.testExtract(update)).toEqual({
            count: 2,
        });
    });

    it("should not recursively extract nested objects in $set", () => {
        const update = {
            $set: {
                nested: {
                    inner: "value",
                },
            },
        };
        expect(repo.testExtract(update)).toEqual({
            nested: { inner: "value" },
        });
    });

    it("should preserve null values from $set", () => {
        const update = {
            $set: {
                status: null,
            },
        } as const;
        // @ts-expect-error testing
        expect(repo.testExtract(update)).toEqual({
            status: null,
        });
    });

    it("should preserve Date instances", () => {
        const date = new Date();
        const update = {
            $set: {
                last_attempt_at: date,
            },
        };
        expect(repo.testExtract(update)).toEqual({
            last_attempt_at: date,
        });
    });

    it("should handle number increments", () => {
        const update = {
            $set: {
                status: "failed",
            },
            $inc: { count: 1 },
        } as const;
        expect(repo.testExtract(update)).toEqual({
            status: "failed",
            count: 1,
        });
    });

    it("should preserve 7 levels of nesting in $set", () => {
        const update = {
            $set: {
                level1: {
                    level2: {
                        level3: {
                            level4: {
                                level5: {
                                    level6: {
                                        level7: {
                                            level8: {
                                                value: "deep",
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    someVal: "hey",
                },
            },
        };

        expect(repo.testExtract(update)).toEqual({
            level1: {
                level2: {
                    level3: {
                        level4: {
                            level5: {
                                level6: {
                                    level7: {
                                        level8: {
                                            value: "deep",
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                someVal: "hey",
            },
        });
    });

    it("should throw if dot notation is used in $set", () => {
        const update = {
            $set: {
                "user.name": "Alice",
            },
        };

        expect(() => repo.testExtract(update)).toThrow(
            'Dot notation keys are not supported yet: "user.name"',
        );
    });

    it("should throw if dot notation is used in direct key", () => {
        const update = {
            "profile.contact.email": "a@b.com",
        };

        expect(() => repo.testExtract(update)).toThrow(
            'Dot notation keys are not supported yet: "profile.contact.email"',
        );
    });
});

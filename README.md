# zongorepo

> [!WARNING]  
> Very early alpha release. Expect API changes.

<!-- API_DOC_START -->

A type-safe MongoDB repository base class that provides runtime schema
validation using Zod.

**Usage:**

```typescript
// Define your schema
const UserSchema = z.object({
    name: z.string(),
    email: z.string().email(),
    age: z.number().optional(),
});

// Extend RepoBase
class UserRepo extends RepoBase<z.infer<typeof UserSchema>> {
    constructor(db: Db) {
        super(db, "users", UserSchema);
    }
}

// Use with full type safety
const users = await userRepo.find({
    filter: { age: { $gte: 18 } },
    select: ["name", "email"], // Only these fields will be returned
});
```

**Error Handling:** All operations return a standardized response format with
`{ data, status, error }` for consistent error handling across your application.

<!-- API_DOC_END -->
